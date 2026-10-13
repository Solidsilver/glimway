package api

import (
	"context"
	"github.com/coder/websocket"
	"glimway/content"
	"glimway/server/internal/fights"
	contract "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
	"google.golang.org/protobuf/proto"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
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

// poseOf is the movement state this contract names (3.4): "riding",
// "fishing", or empty for on foot. Anything else a client sends reads as on
// foot. One allow-list for the relay and the roster (review finding 17).
func poseOf(pose string) string {
	if pose == "riding" || pose == "fishing" {
		return pose
	}
	return ""
}

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
	identity     presenceIdentity
	account      *presenceAccount
	conn         *websocket.Conn
	ctx          context.Context
	cancel       context.CancelFunc
	queue        chan []byte
	flushWake    chan struct{}
	flushPending atomic.Bool
	// queuedBytes is the queue's outstanding payload: enqueue adds under
	// h.mu, the writer subtracts without it (one atomic a frame, no lock).
	queuedBytes atomic.Int64
	// In flush mode, queuedMessages includes held events as well as the
	// channel. Credits return only when events join an in-flight frame.
	queuedMessages atomic.Int64
	stopOnce       sync.Once
	closeCode      websocket.StatusCode
	closeReason    string
	// All fields below are protected by the hub mutex.
	area                         string
	pos                          *presencePosition
	lastPos, lastJoin, lastEmote time.Time
	lastActivity                 time.Time
	// pingAt is when the sweep last started a ping; pinging while one is
	// in flight (pingPeer clears it).
	pingAt                 time.Time
	pinging                bool
	authFailures           int
	authCheck, authApplied uint64
	detached               bool
	// clientJoined: this socket's client has named an area (its first Join).
	// Rooms covered before that were announced before it could take them.
	clientJoined          bool
	grace                 *time.Timer
	fightToken            string
	critSeed, lastCounter uint32
	hasCounter            bool
	lastSwing             time.Time
	fightRooms            map[uint32]*presenceFightRoom
	fightJoined           map[uint32]bool
}

// stop never does network I/O while holding the hub lock. The writer sends the
// close frame after cancellation and the read loop remains available for pong.
func (p *presencePeer) stop(code websocket.StatusCode, reason string) {
	p.stopOnce.Do(func() { p.closeCode = code; p.closeReason = reason; p.cancel() })
}

type presenceHub struct {
	mu    sync.Mutex
	peers map[string]*presencePeer
	// worlds indexes peers by world, then id: a room's fan-out and roster
	// walk one world's peers, not every peer of the hub. Kept by admit,
	// unindex and moveWorld, under h.mu, in step with peers.
	worlds    map[string]map[string]*presencePeer
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
	// wardReserved is the credit an open report holds out of the pool
	// (review finding 11), keyed by account and report sequence (review
	// finding 1: one report can never discard another's reservation).
	wardReserved map[wardKey]*wardReservation
	// clock is the server's (injected) time: the ward credit's expiry and
	// the cooldowns read it, so tests can move time (review finding 12).
	clock func() time.Time
	// afterFunc schedules a ward's pulses. Production hands them to
	// time.AfterFunc; the tests fire them by hand, so no ward test sleeps in
	// real time (review finding 12).
	afterFunc                func(time.Duration, func())
	fightLoad                sync.Mutex // lifecycle loading, never held by a tick
	fightRooms               map[fights.Key]*presenceFightRoom
	fightHandle              uint32
	fightLocations           map[fightLocation]fightLocationEpoch
	fightLocationOrder       map[fightLocation]uint64
	fightLocationSeq         uint64
	fightFailedWakes         map[fights.Key]bool
	fightSocket, fightAttack uint64
	fightGathers             sync.WaitGroup
	// fightSched runs every woken room (fightScheduler), from the first
	// wake until ClosePresence. fightWorkers (0: GOMAXPROCS) and
	// fightTicks (nil: the hub's own clock) are set before the first wake,
	// by the load scenario and tests.
	// sweepStop ends presenceSweep, started with the first peer.
	sweepOnce, sweepClose sync.Once
	sweepStop             chan struct{}
	sweepDone             chan struct{}
	sweepStarted          bool // published by sweepOnce before ClosePresence reads it
	pingWG                sync.WaitGroup
	fightSched            *fights.Scheduler
	fightSchedOnce        sync.Once
	fightWorkers          int
	fightTicks            <-chan time.Time
	flushMs               int
	writeCalls            atomic.Uint64
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
	return &presenceHub{sweepStop: make(chan struct{}), sweepDone: make(chan struct{}), fightLocations: map[fightLocation]fightLocationEpoch{}, fightLocationOrder: map[fightLocation]uint64{}, fightFailedWakes: map[fights.Key]bool{}, fightRooms: map[fights.Key]*presenceFightRoom{}, peers: map[string]*presencePeer{}, worlds: map[string]map[string]*presencePeer{}, accounts: map[string]*presenceAccount{}, sessions: map[string]int{}, sockets: map[*websocket.Conn]struct{}{}, drained: make(chan struct{}), config: config, abilityReady: map[string]map[string]time.Time{}, ward: map[string]*wardCredit{}, wardReserved: map[wardKey]*wardReservation{}, clock: now, afterFunc: func(d time.Duration, f func()) { time.AfterFunc(d, f) }}
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

// admit registers p as its account's peer, replacing any peer of that id
// (and that peer's index entry, whichever world it was in); callers hold
// h.mu.
func (h *presenceHub) admit(p *presencePeer) {
	if old := h.peers[p.identity.ID]; old != nil && old != p {
		h.unindex(old)
	}
	h.peers[p.identity.ID] = p
	world := h.worlds[p.identity.World]
	if world == nil {
		world = map[string]*presencePeer{}
		h.worlds[p.identity.World] = world
	}
	world[p.identity.ID] = p
}

// forget drops p from the hub's registry and index without the leave
// bookkeeping of remove; a fixture's exit. Callers hold h.mu.
func (h *presenceHub) forget(p *presencePeer) {
	if h.peers[p.identity.ID] == p {
		delete(h.peers, p.identity.ID)
	}
	h.unindex(p)
}

// unindex drops p from its world's index, if it is still the one there.
func (h *presenceHub) unindex(p *presencePeer) {
	world := h.worlds[p.identity.World]
	if world[p.identity.ID] != p {
		return
	}
	delete(world, p.identity.ID)
	if len(world) == 0 {
		delete(h.worlds, p.identity.World)
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
	if presenceEventSize(b) > presenceMaxFrameBytes || p.queuedBytes.Load()+int64(len(b)) > 262144 {
		p.stop(websocket.StatusTryAgainLater, "slow-consumer")
		return
	}
	if h.flushMs > 0 {
		if p.queuedMessages.Load() >= int64(cap(p.queue)) {
			p.stop(websocket.StatusTryAgainLater, "slow-consumer")
			return
		}
		// Charge before publishing to the writer, which can immediately
		// include this event in a frame and return its credit.
		p.queuedMessages.Add(1)
	}
	select {
	case p.queue <- b:
		p.queuedBytes.Add(int64(len(b)))
		p.flushPending.Store(true)
	default:
		if h.flushMs > 0 {
			p.queuedMessages.Add(-1)
		}
		p.stop(websocket.StatusTryAgainLater, "slow-consumer")
	}
}

func (h *presenceHub) broadcast(sender *presencePeer, v proto.Message) {
	b, err := encodePresence(v)
	h.broadcastEncoded(sender, b, err)
}

func (h *presenceHub) broadcastEncoded(sender *presencePeer, b []byte, err error) {
	h.broadcastWhere(sender, b, err, func(p *presencePeer) bool { return sharedRoom(p.area, sender.area) })
}

// broadcastWhere sends to the sender's world's peers the filter picks.
func (h *presenceHub) broadcastWhere(sender *presencePeer, b []byte, err error, pick func(*presencePeer) bool) {
	for _, p := range h.worlds[sender.identity.World] {
		if p != sender && pick(p) {
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
	h.leaveFights(p, false)
	h.unindex(p)
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
	h.leaveFights(p, false)
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
	actors := make([]*fights.Actor, 0, len(h.fightRooms))
	for _, room := range h.fightRooms {
		actors = append(actors, room.actor)
	}
	sockets := make([]*websocket.Conn, 0, len(h.sockets))
	for conn := range h.sockets {
		sockets = append(sockets, conn)
	}
	if h.slots == 0 {
		h.drainOnce.Do(func() { close(h.drained) })
	}
	h.mu.Unlock()
	for _, actor := range actors {
		actor.Stop()
	}
	for _, actor := range actors {
		<-actor.Done()
	}
	h.fightGathers.Wait()
	// Every room has exited; the workers and the clock may go. A hub that
	// never woke a room started none. The sweep goes with them (a hub that
	// never had a peer started none; the once keeps it from starting now).
	h.fightSchedOnce.Do(func() {})
	if h.fightSched != nil {
		h.fightSched.Stop()
	}
	h.sweepOnce.Do(func() {})
	h.sweepClose.Do(func() { close(h.sweepStop) })
	if h.sweepStarted {
		<-h.sweepDone
	}
	h.pingWG.Wait()
	// Every room has stopped, so no fall can arrive after this: write the
	// queued ones before the store goes (bounded; a fall left is logged).
	falls, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	_ = a.CloseFalls(falls)
	cancel()
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
	h.leaveFights(p, true)
	h.unindex(p)
	p.identity.World = world
	h.admit(p)
	p.pos = nil
	if p.area == "" {
		return
	}
	n := 0
	for _, other := range h.worlds[world] {
		if other != p && other.area == p.area {
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
	for _, other := range h.worlds[p.identity.World] {
		if other != p && sharedRoom(other.area, p.area) {
			players = append(players, other.player())
		}
	}
	slices.SortFunc(players, func(a, b *contract.PresencePlayer) int { return strings.Compare(a.AccountId, b.AccountId) })
	h.send(p, &contract.PresenceRoom{Area: p.area, Players: players})
}
