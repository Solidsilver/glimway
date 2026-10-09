package api

import (
	"context"
	"github.com/coder/websocket"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
	"google.golang.org/protobuf/proto"
	"slices"
	"strings"
	"sync"
	"time"
)

const (
	presenceUnauthorized websocket.StatusCode = 4001
	presenceSuperseded   websocket.StatusCode = 4002
	presenceReplaced     websocket.StatusCode = 4003
	presenceIdle         websocket.StatusCode = 4004
	presenceReload       websocket.StatusCode = 4005
)

func millis(n int) time.Duration { return time.Duration(n) * time.Millisecond }

type presencePosition struct {
	X      float64        `json:"x"`
	Y      float64        `json:"y"`
	Facing rules.Position `json:"facing"`
	Moving bool           `json:"moving"`
	// Pose is the movement state the screen owns (3.4): "riding", "fishing"
	// or '' (on foot).
	Pose string `json:"pose"`
}

type presenceIdentity struct {
	ID, World, Name, Lease, Session string
	Avatar                          *contract.PresenceAvatar
	// Magic is the account's craft state a cast is checked against
	// (crafts.md 4.5), refreshed with the hub's revalidation.
	Magic presenceMagic
}

type presencePeer struct {
	identity    presenceIdentity
	account     *presenceAccount
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
	authFailures                 int
	authCheck, authApplied       uint64
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
	accounts  map[string]*presenceAccount
	sessions  map[string]int
	sockets   map[*websocket.Conn]struct{}
	drained   chan struct{}
	drainOnce sync.Once
	slots     int
	closing   bool
	config    *content.Presence
	// Lane C (crafts.md 4.5): the per-account per-ability cooldown a cast
	// must pass, and the ward credit pulses leave for the next report.
	abilityReady map[string]map[string]time.Time
	ward         map[string]*wardCredit
	// clock is the server's (injected) time: the ward credit's expiry and
	// the cooldowns read it, so tests can move time (review finding 12).
	clock func() time.Time
}

// Account generations live only while physical reservations exist. A socket
// keeps its account pointer, so no unbounded generation tombstone map is needed.
type presenceAccount struct {
	slots      int
	generation uint64
}

type presenceReservation struct {
	session, id string
	account     *presenceAccount
}

func newPresenceHub(c *content.Presence, now func() time.Time) *presenceHub {
	config := content.PresenceRules
	if c != nil {
		if err := content.ValidatePresence(c); err != nil {
			panic(err)
		}
		config = c
	}
	// The hub mutates nothing and shares no slice: work on a clone, never
	// on the shared rules table.
	config = proto.Clone(config).(*content.Presence)
	return &presenceHub{peers: map[string]*presencePeer{}, accounts: map[string]*presenceAccount{}, sessions: map[string]int{}, sockets: map[*websocket.Conn]struct{}{}, drained: make(chan struct{}), config: config, abilityReady: map[string]map[string]time.Time{}, ward: map[string]*wardCredit{}, clock: now}
}

// now is the server's clock (config's, or the wall clock for a bare hub).
func (h *presenceHub) now() time.Time {
	if h.clock != nil {
		return h.clock()
	}
	return time.Now()
}

func (h *presenceHub) reserve(session, id string) (presenceReservation, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing {
		return presenceReservation{}, fail(503, "presence-full")
	}
	if h.sessions[session] >= int(h.config.GetMaxSessionConnections()) {
		return presenceReservation{}, fail(429, "presence-session-limit")
	}
	account := h.accounts[id]
	if account != nil && account.slots >= int(h.config.GetMaxPlayerConnections()) {
		return presenceReservation{}, fail(429, "presence-player-limit")
	}
	if h.slots >= int(h.config.GetMaxConnections()) {
		return presenceReservation{}, fail(503, "presence-full")
	}
	if account == nil {
		account = &presenceAccount{}
		h.accounts[id] = account
	}
	account.slots++
	h.sessions[session]++
	h.slots++
	return presenceReservation{session, id, account}, nil
}

func (h *presenceHub) release(reservation presenceReservation) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.slots--
	h.sessions[reservation.session]--
	if h.sessions[reservation.session] == 0 {
		delete(h.sessions, reservation.session)
	}
	reservation.account.slots--
	if reservation.account.slots == 0 {
		delete(h.accounts, reservation.id)
	}
	// Cooldown memory outlives a reconnect (review finding 4): an account's
	// entry goes only once every timestamp in it is older than the table's
	// longest cooldown and can no longer bound a cast.
	h.pruneAbilityReady(h.now())
	if h.closing && h.slots == 0 {
		h.drainOnce.Do(func() { close(h.drained) })
	}
}

func (h *presenceHub) send(p *presencePeer, v proto.Message) {
	if p.detached || p.ctx.Err() != nil {
		return
	}
	b, err := encodePresence(v)
	if err != nil {
		p.stop(websocket.StatusInternalError, "internal")
		return
	}
	h.enqueue(p, b)
}

// Callers hold h.mu. Queues share immutable encoded bytes; this does no codec
// or network work, and accounts for each recipient's own outstanding bytes.
func (h *presenceHub) enqueue(p *presencePeer, b []byte) {
	if p.detached || p.ctx.Err() != nil {
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

func (h *presenceHub) broadcast(sender *presencePeer, v proto.Message) {
	b, err := encodePresence(v)
	h.broadcastEncoded(sender, b, err)
}

func (h *presenceHub) broadcastEncoded(sender *presencePeer, b []byte, err error) {
	for _, p := range h.peers {
		if p != sender && p.identity.World == sender.identity.World && p.area == sender.area && p.area != "" {
			if err != nil {
				p.stop(websocket.StatusInternalError, "internal")
				continue
			}
			h.enqueue(p, b)
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
		h.broadcast(p, &contract.PresenceLeave{AccountId: p.identity.ID})
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
	p.grace = time.AfterFunc(millis(int(h.config.GetLeaveGraceMs())), func() { h.mu.Lock(); defer h.mu.Unlock(); h.remove(p) })
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

// moveWorld: the old room sees the player leave; they rejoin their area's
// room in the new world. If that room is full they get an empty roster (so
// the old world's players clear) and wait for their next join.
func (h *presenceHub) moveWorld(p *presencePeer, world string) {
	if p.area != "" {
		h.broadcast(p, &contract.PresenceLeave{AccountId: p.identity.ID})
	}
	p.identity.World = world
	p.pos = nil
	if p.area == "" {
		return
	}
	n := 0
	for _, other := range h.peers {
		if other != p && other.identity.World == world && other.area == p.area {
			n++
		}
	}
	if n >= int(h.config.GetMaxRoomPlayers()) {
		h.send(p, &contract.PresenceRoom{Area: p.area, Players: []*contract.PresencePlayer{}})
		p.area = ""
		return
	}
	h.room(p)
	h.broadcast(p, &contract.PresenceJoin{Area: p.area, Player: p.player()})
}

// near reports whether a player is connected to presence in this world, in
// the given room, and last stood within radius px of (x, y). A socket in its
// reconnect grace (detached) does not count: nobody is standing there.
func (h *presenceHub) near(world, id, room string, x, y, radius float64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	p := h.peers[id]
	if p == nil || p.detached || p.identity.World != world || p.area != room || p.pos == nil {
		return false
	}
	dx, dy := p.pos.X-x, p.pos.Y-y
	return dx*dx+dy*dy <= radius*radius
}

func (p *presencePeer) player() *contract.PresencePlayer {
	return &contract.PresencePlayer{AccountId: p.identity.ID, DisplayName: p.identity.Name, Avatar: p.identity.Avatar, Pos: presencePositionProto(p.pos)}
}

func (h *presenceHub) room(p *presencePeer) {
	players := []*contract.PresencePlayer{}
	for _, other := range h.peers {
		if other != p && other.area == p.area && other.identity.World == p.identity.World {
			players = append(players, other.player())
		}
	}
	slices.SortFunc(players, func(a, b *contract.PresencePlayer) int { return strings.Compare(a.AccountId, b.AccountId) })
	h.send(p, &contract.PresenceRoom{Area: p.area, Players: players})
}
