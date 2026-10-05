package api

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fingersnap/content"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
	"fmt"
	"io"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

const (
	presenceUnauthorized websocket.StatusCode = 4001
	presenceSuperseded   websocket.StatusCode = 4002
	presenceReplaced     websocket.StatusCode = 4003
	presenceIdle         websocket.StatusCode = 4004
)

func millis(n int) time.Duration { return time.Duration(n) * time.Millisecond }

type presenceAvatar struct {
	Appearance    rules.Appearance   `json:"appearance"`
	Equipped      map[string]*string `json:"equipped"`
	Costume       map[string]*string `json:"costume"`
	UseCostume    bool               `json:"useCostume"`
	SelectedPet   *string            `json:"selectedPet"`
	SelectedMount *string            `json:"selectedMount"`
}
type presencePosition struct {
	X      float64        `json:"x"`
	Y      float64        `json:"y"`
	Facing rules.Position `json:"facing"`
	Moving bool           `json:"moving"`
}
type presencePlayer struct {
	HabiticaID  string            `json:"habiticaId"`
	DisplayName string            `json:"displayName"`
	Avatar      *presenceAvatar   `json:"avatar"`
	Pos         *presencePosition `json:"pos"`
}
type presenceIdentity struct {
	ID, World, Name, Lease, Session string
	Avatar                          *presenceAvatar
}

type presencePeer struct {
	identity    presenceIdentity
	conn        *websocket.Conn
	ctx         context.Context
	cancel      context.CancelFunc
	queue       chan []byte
	queuedBytes int
	stopOnce    sync.Once
	closeCode   websocket.StatusCode
	closeReason string
	// All fields below are protected by the hub mutex.
	area                         string
	pos                          *presencePosition
	lastPos, lastJoin, lastEmote time.Time
	lastActivity                 time.Time
	detached                     bool
	grace                        *time.Timer
}

// stop never does network I/O while holding the hub lock. The writer sends the
// close frame after cancellation and the read loop remains available for pong.
func (p *presencePeer) stop(code websocket.StatusCode, reason string) {
	p.stopOnce.Do(func() { p.closeCode = code; p.closeReason = reason; p.cancel() })
}

type presenceHub struct {
	mu        sync.Mutex
	peers     map[string]*presencePeer
	sockets   map[*websocket.Conn]struct{}
	drained   chan struct{}
	drainOnce sync.Once
	slots     int
	closing   bool
	config    content.Presence
}

func newPresenceHub(c *content.Presence) *presenceHub {
	config := content.PresenceRules
	if c != nil {
		config = *c
		if err := content.ValidatePresence(config); err != nil {
			panic(err)
		}
	}
	config.Emotes = slices.Clone(config.Emotes)
	return &presenceHub{peers: map[string]*presencePeer{}, sockets: map[*websocket.Conn]struct{}{}, drained: make(chan struct{}), config: config}
}
func (h *presenceHub) reserve() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing || h.slots >= h.config.MaxConnections {
		return false
	}
	h.slots++
	return true
}
func (h *presenceHub) release() {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.slots--
	if h.closing && h.slots == 0 {
		h.drainOnce.Do(func() { close(h.drained) })
	}
}
func (h *presenceHub) send(p *presencePeer, v any) {
	if p.detached || p.ctx.Err() != nil {
		return
	}
	b, err := json.Marshal(v)
	if err != nil {
		p.stop(websocket.StatusInternalError, "internal")
		return
	}
	if len(b) > 131072 || p.queuedBytes+len(b) > 262144 {
		p.stop(websocket.StatusTryAgainLater, "slow-consumer")
		return
	}
	select {
	case p.queue <- b:
		p.queuedBytes += len(b)
	default:
		p.stop(websocket.StatusTryAgainLater, "slow-consumer")
	}
}
func (h *presenceHub) broadcast(sender *presencePeer, v any) {
	for _, p := range h.peers {
		if p != sender && p.identity.World == sender.identity.World && p.area == sender.area && p.area != "" {
			h.send(p, v)
		}
	}
}
func (h *presenceHub) remove(p *presencePeer) {
	if h.peers[p.identity.ID] != p {
		return
	}
	if p.grace != nil {
		p.grace.Stop()
	}
	delete(h.peers, p.identity.ID)
	if p.area != "" {
		h.broadcast(p, struct {
			Type       string `json:"type"`
			HabiticaID string `json:"habiticaId"`
		}{"leave", p.identity.ID})
	}
}
func (h *presenceHub) detach(p *presencePeer) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.peers[p.identity.ID] != p {
		return
	}
	p.detached = true
	if h.closing {
		h.remove(p)
		return
	}
	p.grace = time.AfterFunc(millis(h.config.LeaveGraceMs), func() { h.mu.Lock(); defer h.mu.Unlock(); h.remove(p) })
}
func (a *Server) ClosePresence() {
	h := a.presence
	h.mu.Lock()
	first := !h.closing
	h.closing = true
	for _, p := range h.peers {
		p.stop(websocket.StatusGoingAway, "server-shutdown")
		h.remove(p)
	}
	sockets := make([]*websocket.Conn, 0, len(h.sockets))
	for conn := range h.sockets {
		sockets = append(sockets, conn)
	}
	if h.slots == 0 {
		h.drainOnce.Do(func() { close(h.drained) })
	}
	h.mu.Unlock()
	// HTTP Shutdown does not wait for hijacked connections, including sockets
	// still waiting for auth. Close them concurrently and bound the drain.
	if first {
		for _, conn := range sockets {
			go func() { _ = conn.Close(websocket.StatusGoingAway, "server-shutdown") }()
		}
	}
	select {
	case <-h.drained:
	case <-time.After(5 * time.Second):
		for _, conn := range sockets {
			_ = conn.CloseNow()
		}
	}
}

// Read-only authentication: presence never slides sessions, touches leases,
// changes revisions or writes progress. HTTP play/progress retains that role.
func (a *Server) presenceIdentity(ctx context.Context, session string) (presenceIdentity, error) {
	var v presenceIdentity
	v.Session = session
	var profile sql.NullString
	var origin, lease sql.NullString
	now := a.Config.Now().Unix()
	err := a.Store.DB.QueryRowContext(ctx, `SELECT p.habitica_id,p.world_id,p.display_name,p.save_origin,p.lease_id,b.profile_json FROM sessions s JOIN allowlist l USING(habitica_id) JOIN players p USING(habitica_id) JOIN sync_baselines b USING(habitica_id) WHERE s.id_hash=? AND s.expires_at>? AND s.created_at>?`, session, now, now-int64(SessionTTL.Seconds())).Scan(&v.ID, &v.World, &v.Name, &origin, &lease, &profile)
	if err == sql.ErrNoRows {
		return v, fail(401, "unauthorized")
	}
	if err != nil {
		return v, err
	}
	if !origin.Valid {
		return v, fail(409, "origin-required")
	}
	if !lease.Valid {
		return v, fail(409, "superseded")
	}
	v.Lease = lease.String
	v.Name = capDonor(v.Name)
	if profile.Valid {
		var p rules.Profile
		if err = json.Unmarshal([]byte(profile.String), &p); err != nil {
			return v, err
		}
		v.Avatar = visualAvatar(p)
	}
	return v, nil
}
func (a *Server) revalidatePresence(p *presencePeer) (websocket.StatusCode, string) {
	ctx, cancel := context.WithTimeout(context.Background(), millis(a.presence.config.WriteTimeoutMs))
	defer cancel()
	v, err := a.presenceIdentity(ctx, p.identity.Session)
	if err != nil {
		var f *failure
		if errors.As(err, &f) {
			if f.code == "superseded" {
				return presenceSuperseded, "superseded"
			}
			return presenceUnauthorized, "unauthorized"
		}
		return websocket.StatusInternalError, "internal"
	}
	if v.Lease != p.identity.Lease {
		return presenceSuperseded, "superseded"
	}
	if v.ID != p.identity.ID || v.World != p.identity.World {
		return presenceUnauthorized, "unauthorized"
	}
	return 0, ""
}

// Called after play/logout commits. Locking registration with the DB check
// prevents a stale first-message auth from racing a takeover notification.
func (a *Server) presenceChanged(id string) {
	h := a.presence
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, p := range h.peers {
		if p.identity.ID == id {
			if code, reason := a.revalidatePresence(p); code != 0 {
				p.stop(code, reason)
				h.remove(p)
			}
		}
	}
}
func validPresenceRoom(area string) bool {
	if slices.Contains([]string{"village", "woodland", "ruin", "commons"}, area) {
		return true
	}
	parts := strings.Split(area, ":")
	if len(parts) != 4 || parts[0] != "wilds" {
		return false
	}
	r, ok := regionDefinition(parts[1])
	if !ok {
		return false
	}
	x, err := strconv.Atoi(parts[2])
	if err != nil || strconv.Itoa(x) != parts[2] {
		return false
	}
	y, err := strconv.Atoi(parts[3])
	return err == nil && strconv.Itoa(y) == parts[3] && x >= 0 && y >= 0 && x < r.GridWidth && y < r.GridHeight
}
func strictPresenceJSON(b []byte, v any) error {
	d := json.NewDecoder(bytes.NewReader(b))
	d.DisallowUnknownFields()
	if err := d.Decode(v); err != nil {
		return err
	}
	if err := d.Decode(&struct{}{}); err != io.EOF {
		return fmt.Errorf("invalid message")
	}
	return nil
}
func (a *Server) presenceSocket(w http.ResponseWriter, r *http.Request) error {
	if !sameOrigin(r, true) || len(r.URL.RawQuery) > 0 {
		return fail(403, "cross-origin")
	}
	cookie, err := r.Cookie(CookieName)
	if err != nil || len(cookie.Value) != 64 {
		return fail(401, "unauthorized")
	}
	session := store.Hash(cookie.Value)
	ctx, cancel := context.WithTimeout(context.Background(), millis(a.presence.config.AuthTimeoutMs))
	_, err = a.presenceIdentity(ctx, session)
	cancel()
	if err != nil {
		return err
	}
	h := a.presence
	if !h.reserve() {
		w.Header().Set("Retry-After", "5")
		return fail(503, "presence-full")
	}
	defer h.release()
	// net/http deadlines survive hijacking; network lifetimes are owned here.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return nil
	}
	defer conn.CloseNow()
	h.mu.Lock()
	if h.closing {
		h.mu.Unlock()
		_ = conn.Close(websocket.StatusGoingAway, "server-shutdown")
		return nil
	}
	h.sockets[conn] = struct{}{}
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(h.sockets, conn); h.mu.Unlock() }()
	conn.SetReadLimit(int64(h.config.MessageBytes))
	ctx, cancel = context.WithTimeout(context.Background(), millis(h.config.AuthTimeoutMs))
	typ, b, err := conn.Read(ctx)
	cancel()
	if err != nil {
		return nil
	}
	var auth struct {
		Type  string `json:"type"`
		Lease string `json:"lease"`
	}
	if typ != websocket.MessageText || strictPresenceJSON(b, &auth) != nil || auth.Type != "auth" || len(auth.Lease) != 64 {
		_ = conn.Close(presenceUnauthorized, "unauthorized")
		return nil
	}
	h.mu.Lock()
	ctx, cancel = context.WithTimeout(context.Background(), millis(h.config.AuthTimeoutMs))
	identity, err := a.presenceIdentity(ctx, session)
	cancel()
	if err != nil || identity.Lease != auth.Lease || h.closing {
		h.mu.Unlock()
		code := presenceUnauthorized
		reason := "unauthorized"
		if err == nil && identity.Lease != auth.Lease {
			code = presenceSuperseded
			reason = "superseded"
		}
		_ = conn.Close(code, reason)
		return nil
	}
	if len(h.peers) >= h.config.MaxConnections && h.peers[identity.ID] == nil {
		h.mu.Unlock()
		_ = conn.Close(websocket.StatusTryAgainLater, "presence-full")
		return nil
	}
	peerCtx, peerCancel := context.WithCancel(context.Background())
	p := &presencePeer{identity: identity, conn: conn, ctx: peerCtx, cancel: peerCancel, queue: make(chan []byte, h.config.QueueMessages), lastActivity: time.Now()}
	if old := h.peers[identity.ID]; old != nil {
		if old.identity.Lease == identity.Lease && old.identity.World == identity.World {
			if old.grace != nil {
				old.grace.Stop()
			}
			p.area = old.area
			p.pos = old.pos
			p.lastPos = old.lastPos
			p.lastJoin = old.lastJoin
			p.lastEmote = old.lastEmote
			old.stop(presenceReplaced, "replaced")
		} else {
			old.stop(presenceSuperseded, "superseded")
			h.remove(old)
		}
	}
	h.peers[identity.ID] = p
	h.send(p, struct {
		Type       string `json:"type"`
		HabiticaID string `json:"habiticaId"`
	}{"ready", identity.ID})
	if p.area != "" {
		h.room(p)
		h.broadcast(p, struct {
			Type   string         `json:"type"`
			Area   string         `json:"area"`
			Player presencePlayer `json:"player"`
		}{"join", p.area, p.player()})
	}
	h.mu.Unlock()
	done := make(chan struct{})
	go func() { defer close(done); a.presenceWriter(p) }()
	// The writer owns termination deadlines; this read stays alive for ping/pong
	// and close handshakes even after cancellation of application work.
	a.presenceReader(p)
	p.stop(websocket.StatusNormalClosure, "disconnected")
	<-done
	h.detach(p)
	return nil
}

func (p *presencePeer) player() presencePlayer {
	return presencePlayer{p.identity.ID, p.identity.Name, p.identity.Avatar, p.pos}
}
func (h *presenceHub) room(p *presencePeer) {
	players := []presencePlayer{}
	for _, other := range h.peers {
		if other != p && other.area == p.area && other.identity.World == p.identity.World {
			players = append(players, other.player())
		}
	}
	slices.SortFunc(players, func(a, b presencePlayer) int { return strings.Compare(a.HabiticaID, b.HabiticaID) })
	h.send(p, struct {
		Type    string           `json:"type"`
		Area    string           `json:"area"`
		Players []presencePlayer `json:"players"`
	}{"room", p.area, players})
}
func (a *Server) presenceReader(p *presencePeer) {
	h := a.presence
	for {
		typ, b, err := p.conn.Read(context.Background())
		if err != nil {
			return
		}
		if p.ctx.Err() != nil {
			return
		}
		if typ != websocket.MessageText {
			p.stop(websocket.StatusUnsupportedData, "text-required")
			return
		}
		var message struct {
			Type   string   `json:"type"`
			Area   string   `json:"area,omitempty"`
			ID     string   `json:"id,omitempty"`
			X      *float64 `json:"x,omitempty"`
			Y      *float64 `json:"y,omitempty"`
			Facing *struct {
				X *float64 `json:"x"`
				Y *float64 `json:"y"`
			} `json:"facing,omitempty"`
			Moving *bool `json:"moving,omitempty"`
		}
		if strictPresenceJSON(b, &message) != nil {
			p.stop(websocket.StatusPolicyViolation, "invalid-message")
			return
		}
		// Reject irrelevant known fields as well as unknown JSON keys.
		positionFields := message.X != nil || message.Y != nil || message.Facing != nil || message.Moving != nil
		if message.Type != "pos" && positionFields || message.Type != "join" && message.Area != "" || message.Type != "emote" && message.ID != "" {
			p.stop(websocket.StatusPolicyViolation, "invalid-message")
			return
		}
		now := time.Now()
		h.mu.Lock()
		if h.peers[p.identity.ID] != p || p.ctx.Err() != nil {
			h.mu.Unlock()
			return
		}
		p.lastActivity = now
		switch message.Type {
		case "heartbeat":
		case "join":
			if !validPresenceRoom(message.Area) {
				p.stop(websocket.StatusPolicyViolation, "invalid-room")
				h.mu.Unlock()
				return
			}
			if !p.lastJoin.IsZero() && now.Sub(p.lastJoin) < millis(h.config.JoinCooldownMs) {
				h.mu.Unlock()
				continue
			}
			p.lastJoin = now
			if p.area == message.Area {
				h.room(p)
				h.mu.Unlock()
				continue
			}
			n := 0
			for _, other := range h.peers {
				if other != p && other.identity.World == p.identity.World && other.area == message.Area {
					n++
				}
			}
			if n >= h.config.MaxRoomPlayers {
				p.stop(websocket.StatusTryAgainLater, "room-full")
				h.mu.Unlock()
				return
			}
			if p.area != "" {
				h.broadcast(p, struct {
					Type       string `json:"type"`
					HabiticaID string `json:"habiticaId"`
				}{"leave", p.identity.ID})
			}
			p.area = message.Area
			p.pos = nil
			h.room(p)
			h.broadcast(p, struct {
				Type   string         `json:"type"`
				Area   string         `json:"area"`
				Player presencePlayer `json:"player"`
			}{"join", p.area, p.player()})
		case "pos":
			if p.area == "" || message.X == nil || message.Y == nil || message.Facing == nil || message.Facing.X == nil || message.Facing.Y == nil || message.Moving == nil {
				p.stop(websocket.StatusPolicyViolation, "invalid-position")
				h.mu.Unlock()
				return
			}
			x, y, fx, fy := *message.X, *message.Y, *message.Facing.X, *message.Facing.Y
			length := fx*fx + fy*fy
			if !finitePresence(x) || !finitePresence(y) || !finitePresence(fx) || !finitePresence(fy) || math.Abs(x) > 1e6 || math.Abs(y) > 1e6 || math.Abs(length-1) > 0.01 {
				p.stop(websocket.StatusPolicyViolation, "invalid-position")
				h.mu.Unlock()
				return
			}
			if !p.lastPos.IsZero() && now.Sub(p.lastPos) < time.Second/time.Duration(h.config.PositionHz) {
				h.mu.Unlock()
				continue
			}
			p.lastPos = now
			p.pos = &presencePosition{x, y, rules.Position{X: fx, Y: fy}, *message.Moving}
			h.broadcast(p, struct {
				Type       string `json:"type"`
				HabiticaID string `json:"habiticaId"`
				presencePosition
			}{"pos", p.identity.ID, *p.pos})
		case "emote":
			if p.area == "" || !slices.Contains(h.config.Emotes, message.ID) {
				p.stop(websocket.StatusPolicyViolation, "invalid-emote")
				h.mu.Unlock()
				return
			}
			if !p.lastEmote.IsZero() && now.Sub(p.lastEmote) < millis(h.config.EmoteCooldownMs) {
				h.mu.Unlock()
				continue
			}
			p.lastEmote = now
			h.broadcast(p, struct {
				Type       string `json:"type"`
				HabiticaID string `json:"habiticaId"`
				ID         string `json:"id"`
			}{"emote", p.identity.ID, message.ID})
		default:
			p.stop(websocket.StatusPolicyViolation, "invalid-message")
			h.mu.Unlock()
			return
		}
		h.mu.Unlock()
	}
}
func finitePresence(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }
func (a *Server) presenceWriter(p *presencePeer) {
	h := a.presence
	idle := time.NewTicker(min(millis(h.config.IdleTimeoutMs)/4, time.Second))
	defer idle.Stop()
	ping := time.NewTicker(millis(h.config.PingIntervalMs))
	defer ping.Stop()
	auth := time.NewTicker(millis(h.config.RevalidateMs))
	defer auth.Stop()
	for {
		if p.ctx.Err() != nil {
			_ = p.conn.Close(p.closeCode, p.closeReason)
			return
		}
		select {
		case <-p.ctx.Done():
			_ = p.conn.Close(p.closeCode, p.closeReason)
			return
		case b := <-p.queue:
			h.mu.Lock()
			p.queuedBytes -= len(b)
			h.mu.Unlock()
			// Cancelling coder/websocket Write closes the transport. Let a bounded
			// in-flight write finish so takeover can send its explicit close code.
			ctx, cancel := context.WithTimeout(context.Background(), millis(h.config.WriteTimeoutMs))
			err := p.conn.Write(ctx, websocket.MessageText, b)
			cancel()
			if err != nil {
				p.stop(websocket.StatusTryAgainLater, "slow-consumer")
			}
		case <-ping.C:
			ctx, cancel := context.WithTimeout(context.Background(), millis(h.config.PongTimeoutMs))
			err := p.conn.Ping(ctx)
			cancel()
			if err != nil {
				p.stop(presenceIdle, "pong-timeout")
			}
		case <-idle.C:
			h.mu.Lock()
			expired := time.Since(p.lastActivity) >= millis(h.config.IdleTimeoutMs)
			h.mu.Unlock()
			if expired {
				p.stop(presenceIdle, "idle-timeout")
			}
		case <-auth.C:
			if code, reason := a.revalidatePresence(p); code != 0 {
				p.stop(code, reason)
				h.mu.Lock()
				h.remove(p)
				h.mu.Unlock()
			}
		}
	}
}
func visualAvatar(p rules.Profile) *presenceAvatar {
	// Asset keys are short ASCII identifiers. Reject controls/markup rather than
	// allowing JSON escaping to amplify a roster beyond the outgoing byte limit.
	assetKey := func(s string, limit int) bool {
		if len(s) > limit {
			return false
		}
		for _, c := range s {
			if !(c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-') {
				return false
			}
		}
		return true
	}
	cleanMap := func(input map[string]*string) map[string]*string {
		out := map[string]*string{}
		for _, slot := range rules.Slots {
			v := input[slot]
			if v != nil && assetKey(*v, 128) {
				copy := *v
				out[slot] = &copy
			} else {
				out[slot] = nil
			}
		}
		return out
	}
	visual := p.Appearance
	for _, v := range []*string{&visual.Size, &visual.Shirt, &visual.Skin, &visual.HairColor, &visual.Background} {
		if !assetKey(*v, 64) {
			*v = ""
		}
	}
	selected := func(v *string) *string {
		if v == nil || !assetKey(*v, 128) {
			return nil
		}
		copy := *v
		return &copy
	}
	return &presenceAvatar{visual, cleanMap(p.Equipped), cleanMap(p.Costume), p.UseCostume, selected(p.SelectedPet), selected(p.SelectedMount)}
}
