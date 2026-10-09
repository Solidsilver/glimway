package api

import (
	"context"
	"errors"
	"github.com/coder/websocket"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/proto"
	"math"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

func validPresenceRoom(area string) bool {
	if validArea(area) {
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
	return err == nil && strconv.Itoa(y) == parts[3] && x >= 0 && y >= 0 && x < int(r.GetGridWidth()) && y < int(r.GetGridHeight())
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
	h := a.presence
	// Already-full sessions need no additional DB proof query.
	h.mu.Lock()
	sessionFull := h.sessions[session] >= int(h.config.GetMaxSessionConnections())
	h.mu.Unlock()
	if sessionFull {
		w.Header().Set("Retry-After", "5")
		return fail(429, "presence-session-limit")
	}
	ctx, cancel := context.WithTimeout(context.Background(), millis(int(a.presence.config.GetAuthTimeoutMs())))
	identity, err := a.presenceIdentity(ctx, session, false)
	cancel()
	if err != nil {
		return err
	}
	reservation, err := h.reserve(session, identity.ID)
	if err != nil {
		w.Header().Set("Retry-After", "5")
		return err
	}
	defer h.release(reservation)
	// net/http deadlines survive hijacking; network lifetimes are owned here.
	controller := http.NewResponseController(w)
	_ = controller.SetReadDeadline(time.Time{})
	_ = controller.SetWriteDeadline(time.Time{})
	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{presenceProtocol}})
	if err != nil {
		return nil
	}
	defer conn.CloseNow()
	if conn.Subprotocol() != presenceProtocol {
		_ = conn.Close(presenceReload, "reload-needed")
		return nil
	}
	h.mu.Lock()
	if h.closing {
		h.mu.Unlock()
		_ = conn.Close(websocket.StatusGoingAway, "server-shutdown")
		return nil
	}
	h.sockets[conn] = struct{}{}
	h.mu.Unlock()
	defer func() { h.mu.Lock(); delete(h.sockets, conn); h.mu.Unlock() }()
	conn.SetReadLimit(int64(int(h.config.GetMessageBytes())))
	ctx, cancel = context.WithTimeout(context.Background(), millis(int(h.config.GetAuthTimeoutMs())))
	typ, b, err := conn.Read(ctx)
	cancel()
	if err != nil {
		return nil
	}
	message, err := decodePresence(b)
	auth := message.GetAuth()
	if err != nil || typ != websocket.MessageBinary || auth == nil || len(auth.Lease) != 64 {
		_ = conn.Close(presenceUnauthorized, "unauthorized")
		return nil
	}
	ctx, cancel = context.WithTimeout(context.Background(), millis(int(h.config.GetAuthTimeoutMs())))
	defer cancel()
	for {
		h.mu.Lock()
		generation := reservation.account.generation
		closing := h.closing
		h.mu.Unlock()
		if closing {
			_ = conn.Close(websocket.StatusGoingAway, "server-shutdown")
			return nil
		}
		identity, err = a.presenceIdentity(ctx, session, true)
		h.mu.Lock()
		if h.closing {
			h.mu.Unlock()
			_ = conn.Close(websocket.StatusGoingAway, "server-shutdown")
			return nil
		}
		if generation != reservation.account.generation {
			h.mu.Unlock()
			if ctx.Err() != nil {
				_ = conn.Close(websocket.StatusInternalError, "auth-unavailable")
				return nil
			}
			continue
		}
		if err != nil || identity.Lease != auth.Lease || identity.ID != reservation.id {
			h.mu.Unlock()
			code := presenceUnauthorized
			reason := "unauthorized"
			var f *failure
			if err != nil && !errors.As(err, &f) {
				code = websocket.StatusInternalError
				reason = "auth-unavailable"
			}
			if err == nil && identity.Lease != auth.Lease {
				code = presenceSuperseded
				reason = "superseded"
			}
			_ = conn.Close(code, reason)
			return nil
		}
		// Successful registration continues with the lock held and a current generation.
		break
	}
	if len(h.peers) >= int(h.config.GetMaxConnections()) && h.peers[identity.ID] == nil {
		h.mu.Unlock()
		_ = conn.Close(websocket.StatusTryAgainLater, "presence-full")
		return nil
	}
	peerCtx, peerCancel := context.WithCancel(context.Background())
	p := &presencePeer{identity: identity, account: reservation.account, conn: conn, ctx: peerCtx, cancel: peerCancel, queue: make(chan []byte, int(h.config.GetQueueMessages())), lastActivity: time.Now()}
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
	h.send(p, &contract.PresenceReady{AccountId: identity.ID})
	if p.area != "" {
		h.room(p)
		h.broadcast(p, &contract.PresenceJoin{Area: p.area, Player: p.player()})
	}
	h.mu.Unlock()
	done := make(chan struct{})
	go func() { defer close(done); a.presenceWriter(p) }()
	authDone := make(chan struct{})
	go func() { defer close(authDone); a.presenceRevalidator(p) }()
	// The writer owns termination deadlines; this read stays alive for ping/pong
	// and close handshakes even after cancellation of application work.
	a.presenceReader(p)
	p.stop(websocket.StatusNormalClosure, "disconnected")
	<-done
	<-authDone
	h.detach(p)
	return nil
}

func (a *Server) presenceReader(p *presencePeer) {
	h := a.presence
	ingress := newPresenceIngress(h.config)
	for {
		typ, b, err := p.conn.Read(context.Background())
		if err != nil {
			return
		}
		if p.ctx.Err() != nil {
			return
		}
		if typ != websocket.MessageBinary {
			p.stop(websocket.StatusUnsupportedData, "binary-required")
			return
		}
		admitted, sustained := ingress.admit(time.Now(), h.config)
		if !admitted {
			if sustained {
				p.stop(websocket.StatusPolicyViolation, "rate-limited")
				return
			}
			continue
		}
		message, err := decodePresence(b)
		if err != nil {
			p.stop(websocket.StatusPolicyViolation, "invalid-message")
			return
		}
		// Client messages cannot carry server identity or roster fields.
		if join := message.GetJoin(); join != nil && join.Player != nil || message.GetPos() != nil && message.GetPos().AccountId != nil || message.GetEmote() != nil && message.GetEmote().AccountId != nil {
			p.stop(websocket.StatusPolicyViolation, "invalid-message")
			return
		}
		// Positions and emotes are immutable snapshots. Encode outside h.mu;
		// throttling, room membership, ordering and enqueue stay under the lock.
		var encoded []byte
		var encodeErr error
		if pos := message.GetPos(); pos != nil {
			outbound := proto.Clone(pos).(*contract.PresencePosition)
			outbound.AccountId = proto.String(p.identity.ID)
			// Only the poses this contract names travel on ("riding" |
			// "fishing"); anything else reads as on foot (3.4).
			if pose := outbound.GetPose(); pose != "" && pose != "riding" && pose != "fishing" {
				outbound.Pose = nil
			}
			encoded, encodeErr = encodePresence(outbound)
		} else if emote := message.GetEmote(); emote != nil {
			encoded, encodeErr = encodePresence(&contract.PresenceEmote{Id: emote.Id, AccountId: proto.String(p.identity.ID)})
		}
		now := time.Now()
		h.mu.Lock()
		if h.peers[p.identity.ID] != p || p.ctx.Err() != nil {
			h.mu.Unlock()
			return
		}
		p.lastActivity = now
		switch event := message.Event.(type) {
		case *contract.PresenceMessage_Heartbeat:
		case *contract.PresenceMessage_Join:
			if !validPresenceRoom(event.Join.Area) {
				p.stop(websocket.StatusPolicyViolation, "invalid-room")
				h.mu.Unlock()
				return
			}
			if !p.lastJoin.IsZero() && now.Sub(p.lastJoin) < millis(int(h.config.GetJoinCooldownMs())) {
				h.mu.Unlock()
				continue
			}
			p.lastJoin = now
			if p.area == event.Join.Area {
				h.room(p)
				h.mu.Unlock()
				continue
			}
			n := 0
			for _, other := range h.peers {
				if other != p && other.identity.World == p.identity.World && other.area == event.Join.Area {
					n++
				}
			}
			if n >= int(h.config.GetMaxRoomPlayers()) {
				p.stop(websocket.StatusTryAgainLater, "room-full")
				h.mu.Unlock()
				return
			}
			if p.area != "" {
				h.broadcast(p, &contract.PresenceLeave{AccountId: p.identity.ID})
			}
			p.area = event.Join.Area
			p.pos = nil
			h.room(p)
			h.broadcast(p, &contract.PresenceJoin{Area: p.area, Player: p.player()})
		case *contract.PresenceMessage_Pos:
			position := event.Pos
			if p.area == "" || position.X == nil || position.Y == nil || position.Facing == nil || position.Facing.X == nil || position.Facing.Y == nil || position.Moving == nil {
				p.stop(websocket.StatusPolicyViolation, "invalid-position")
				h.mu.Unlock()
				return
			}
			x, y, fx, fy := *position.X, *position.Y, *position.Facing.X, *position.Facing.Y
			length := fx*fx + fy*fy
			if !finitePresence(x) || !finitePresence(y) || !finitePresence(fx) || !finitePresence(fy) || math.Abs(x) > 1e6 || math.Abs(y) > 1e6 || math.Abs(length-1) > 0.01 {
				p.stop(websocket.StatusPolicyViolation, "invalid-position")
				h.mu.Unlock()
				return
			}
			if !p.lastPos.IsZero() && now.Sub(p.lastPos) < time.Second/time.Duration(int(h.config.GetPositionHz())) {
				h.mu.Unlock()
				continue
			}
			p.lastPos = now
			pose := position.GetPose()
			if pose != "riding" && pose != "fishing" {
				pose = ""
			}
			p.pos = &presencePosition{x, y, rules.Position{X: fx, Y: fy}, *position.Moving, pose}
			h.broadcastEncoded(p, encoded, encodeErr)
		case *contract.PresenceMessage_Emote:
			if p.area == "" || !slices.Contains(h.config.GetEmotes(), event.Emote.Id) {
				p.stop(websocket.StatusPolicyViolation, "invalid-emote")
				h.mu.Unlock()
				return
			}
			if !p.lastEmote.IsZero() && now.Sub(p.lastEmote) < millis(int(h.config.GetEmoteCooldownMs())) {
				h.mu.Unlock()
				continue
			}
			p.lastEmote = now
			h.broadcastEncoded(p, encoded, encodeErr)
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
	idle := time.NewTicker(min(millis(int(h.config.GetIdleTimeoutMs()))/4, time.Second))
	defer idle.Stop()
	ping := time.NewTicker(millis(int(h.config.GetPingIntervalMs())))
	defer ping.Stop()
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
			ctx, cancel := context.WithTimeout(context.Background(), millis(int(h.config.GetWriteTimeoutMs())))
			err := p.conn.Write(ctx, websocket.MessageBinary, b)
			cancel()
			if err != nil {
				p.stop(websocket.StatusTryAgainLater, "slow-consumer")
			}
		case <-ping.C:
			ctx, cancel := context.WithTimeout(context.Background(), millis(int(h.config.GetPongTimeoutMs())))
			err := p.conn.Ping(ctx)
			cancel()
			if err != nil {
				p.stop(presenceIdle, "pong-timeout")
			}
		case <-idle.C:
			h.mu.Lock()
			expired := time.Since(p.lastActivity) >= millis(int(h.config.GetIdleTimeoutMs()))
			h.mu.Unlock()
			if expired {
				p.stop(presenceIdle, "idle-timeout")
			}

		}
	}
}

// Reader-owned token bucket: denied messages never parse JSON or take h.mu.
type presenceIngress struct {
	tokens                        float64
	last, excessSince, lastExcess time.Time
}

func newPresenceIngress(c *content.Presence) presenceIngress {
	return presenceIngress{tokens: float64(c.IncomingBurst), last: time.Now()}
}

func (b *presenceIngress) admit(now time.Time, c *content.Presence) (bool, bool) {
	b.tokens = min(float64(c.IncomingBurst), b.tokens+max(0, now.Sub(b.last).Seconds())*float64(c.IncomingMessagesPerSecond))
	b.last = now
	if b.tokens >= float64(c.IncomingBurst) || now.Sub(b.lastExcess) >= time.Second {
		b.excessSince = time.Time{}
	}
	if b.tokens >= 1 {
		b.tokens--
		return true, false
	}
	if b.excessSince.IsZero() {
		b.excessSince = now
	}
	b.lastExcess = now
	return false, now.Sub(b.excessSince) >= millis(int(c.GetIncomingExcessMs()))
}
