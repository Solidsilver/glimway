package api

import (
	"context"
	"database/sql"
	"net/http"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/chunks/fakegen"
	"glimway/server/internal/fights"
	chunkwire "glimway/server/internal/gen/glimway/v1"
	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

func queuedFightFrame(t *testing.T, p *presencePeer) *wire.PresenceMessage {
	t.Helper()
	select {
	case b := <-p.queue:
		m, err := decodePresence(b)
		if err != nil {
			t.Fatal(err)
		}
		return m
	case <-time.After(3 * time.Second):
		t.Fatal("no fight frame")
		return nil
	}
}
func adapterFightFixture(t *testing.T) (*rig, *presencePeer, *http.Cookie, response) {
	x := newRig(t)
	cookie, state := x.ready("alice")
	x.api.Config.Chunks = &fightChunkCounter{ChunkSource: x.api.Config.Chunks}
	identity, err := x.api.presenceIdentity(context.Background(), store.Hash(cookie.Value), false)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	p := &presencePeer{identity: identity, account: &presenceAccount{}, ctx: ctx, cancel: cancel, queue: make(chan []byte, 256), area: "outdoors:0:0", pos: &presencePosition{X: 185, Y: 208}, fightRooms: map[uint32]*presenceFightRoom{}}
	x.api.presence.admit(p)
	t.Cleanup(x.api.ClosePresence)
	return x, p, cookie, state
}
func swingForPeer(p *presencePeer, predicted ...*wire.FightTarget) *wire.FightSwing {
	tick, _ := rules.FightTickAt(100000)
	return &wire.FightSwing{Kind: wire.FightSwingKind_FIGHT_SWING_KIND_SLASH, X: p.pos.X, Y: p.pos.Y, Facing: &wire.FightFacing{X: 1}, SeenTick: tick, Predicted: predicted}
}
func blockedFightRoom(t *testing.T, a *Server, p *presencePeer, handle uint32, cx int, x float64) (*presenceFightRoom, func()) {
	g := fights.Geometry{CX: cx, Size: 24, Open: make([]bool, 24*24)}
	for i := range g.Open {
		g.Open[i] = true
	}
	key := fights.Key{World: p.identity.World, Realm: content.WildsRules.GetRealm(), Epoch: "blocked", CX: int32(cx)}
	room := &presenceFightRoom{key: key, handle: handle, geometry: g}
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	a.presence.mu.Lock()
	room.actor = fights.Start(fights.NewRoom(key, handle, g, []fights.Camp{{ID: "camp", Kinds: []string{"wisp"}, X: x, Y: 112}}, 1, a.presence.now(), 0), fights.ActorConfig{Now: a.presence.now, Ticks: make(chan time.Time), Emit: func(out fights.Output) {
		if _, ok := out.Message.(*wire.FightJoin); ok {
			close(entered)
			<-release
		}
		a.fightOutput(room, out)
	}})
	a.presence.viewFightRoom(p, room)
	a.presence.fightRooms[key] = room
	a.presence.fightObserver(p)
	room.actor.Submit(fights.Command{Player: &fights.Player{ID: p.identity.ID, Observer: p.fightToken, Seed: p.critSeed, X: p.pos.X, Y: p.pos.Y}})
	a.presence.mu.Unlock()
	<-entered
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(func() { unblock(); room.actor.Stop(); <-room.actor.Done() })
	return room, unblock
}
func TestFightPartialDispatchStillReturnsCompletedHits(t *testing.T) {
	h := newPresenceHub(nil, func() time.Time { return time.UnixMilli(100000) })
	a := &Server{presence: h}
	p := unitFightPeer(t, h)
	addUnitFightRoom(t, a, p, 1, -1, -10)
	stalled, _ := blockedFightRoom(t, a, p, 2, 0, 10)
	for range 128 {
		if !stalled.actor.Submit(fights.Command{}) {
			t.Fatal("queue did not fill")
		}
	}
	s := swingForPeer(p, &wire.FightTarget{Room: 1, Enemy: 0}, &wire.FightTarget{Room: 2, Enemy: 0})
	h.mu.Lock()
	h.handleFightSwing(p, s)
	h.mu.Unlock()
	result := queuedFightResult(t, p)
	if len(result.Hits) != 2 || result.Hits[0].Damage <= 0 || result.Hits[1].RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_UNKNOWN_ENEMY || p.ctx.Err() != nil {
		t.Fatal("partial dispatch lost result or socket", result, p.ctx.Err())
	}
	h.fightGathers.Wait()
}
func TestFightGatherTimeoutSendsCompletedAndUnknownRows(t *testing.T) {
	h := newPresenceHub(nil, func() time.Time { return time.UnixMilli(100000) })
	a := &Server{presence: h}
	p := unitFightPeer(t, h)
	// The blocked lower handle must not hide the higher handle's completed hit.
	stalled, unblock := blockedFightRoom(t, a, p, 1, -1, -10)
	addUnitFightRoom(t, a, p, 2, 0, 10)
	s := swingForPeer(p, &wire.FightTarget{Room: 1, Enemy: 0}, &wire.FightTarget{Room: 2, Enemy: 0})
	h.mu.Lock()
	h.handleFightSwing(p, s)
	h.mu.Unlock()
	var result *wire.FightSwingResult
	timer := time.NewTimer(3 * time.Second)
	defer timer.Stop()
	for result == nil {
		select {
		case b := <-p.queue:
			m, _ := decodePresence(b)
			result = m.GetFightSwingResult()
		case <-timer.C:
			t.Fatal("gather timeout dropped the result")
		}
	}
	if len(result.Hits) != 2 || result.Hits[0].RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_UNKNOWN_ENEMY || result.Hits[1].Damage <= 0 || p.ctx.Err() != nil {
		t.Fatal(result)
	}
	h.fightGathers.Wait()
	// A FIFO attack barrier proves the late original completion was processed.
	// It may send enemy frames, but must not send a second swing result.
	unblock()
	barrier := make(chan []*wire.FightHitRow, 1)
	if !stalled.actor.Submit(fights.Command{Attack: &fights.Attack{Player: p.fightToken, Swing: swingForPeer(p), Damage: 1}, Result: barrier}) {
		t.Fatal("late completion barrier rejected")
	}
	select {
	case <-barrier:
	case <-time.After(time.Second):
		t.Fatal("late room did not finish")
	}
	for {
		select {
		case b := <-p.queue:
			m, _ := decodePresence(b)
			if m.GetFightSwingResult() != nil {
				t.Fatal("duplicate late result", m)
			}
		default:
			return
		}
	}
}

func TestFightCoverRetriesAfterSleepExitWithoutClosingSocket(t *testing.T) {
	x, p, _, _ := adapterFightFixture(t)
	x.api.syncFightPresence(p)
	join := queuedFightFrame(t, p).GetFightJoin()
	if join == nil {
		t.Fatal("no initial join")
	}
	h := x.api.presence
	h.mu.Lock()
	room := p.fightRooms[join.Room]
	h.leaveFights(p, false)
	h.mu.Unlock()
	room.actor.Stop()
	<-room.actor.Done()
	exiting, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	ticks := make(chan time.Time)
	sim := fights.NewRoom(room.key, room.handle, room.geometry, nil, 1, h.now().Add(-fights.SleepAfter), 0)
	h.mu.Lock()
	room.actor = fights.Start(sim, fights.ActorConfig{Now: h.now, Ticks: ticks, Emit: func(out fights.Output) { x.api.fightOutput(room, out) }, Closed: func() { close(exiting); <-release; x.api.fightClosed(room) }})
	h.fightRooms[room.key] = room
	h.mu.Unlock()
	t.Cleanup(func() { once.Do(func() { close(release) }); room.actor.Stop(); <-room.actor.Done() })
	ticks <- h.now()
	<-exiting // admission is closed, but cache eviction has not run
	x.api.syncFightPresence(p)
	h.mu.Lock()
	pending := len(p.fightRooms)
	h.mu.Unlock()
	if p.ctx.Err() != nil || pending != 0 {
		t.Fatal("sleep race closed socket or kept unadmitted cover", p.ctx.Err(), pending)
	}
	once.Do(func() { close(release) })
	<-room.actor.Done()
	x.api.syncFightPresence(p)
	next := queuedFightFrame(t, p).GetFightJoin()
	if next == nil || next.Room == join.Room || next.RoomKey.Epoch != join.RoomKey.Epoch || p.ctx.Err() != nil {
		t.Fatal("next report did not wake fresh room", next)
	}
}
func TestFightLeaveFullQueueKeepsRoomAlive(t *testing.T) {
	h := newPresenceHub(nil, func() time.Time { return time.UnixMilli(100000) })
	a := &Server{presence: h}
	p := unitFightPeer(t, h)
	room, unblock := blockedFightRoom(t, a, p, 1, 0, 10)
	for range 128 {
		if !room.actor.Submit(fights.Command{}) {
			t.Fatal("queue did not fill")
		}
	}
	h.mu.Lock()
	h.leaveFights(p, true)
	h.mu.Unlock()
	unblock()
	reply := make(chan []*wire.FightHitRow, 1)
	deadline := time.Now().Add(time.Second)
	for !room.actor.Submit(fights.Command{Attack: &fights.Attack{Player: p.fightToken, Swing: swingForPeer(p), Damage: 1}, Result: reply}) {
		if time.Now().After(deadline) {
			t.Fatal("leave stopped actor")
		}
		time.Sleep(time.Millisecond)
	}
	select {
	case hits := <-reply:
		if len(hits) != 0 {
			t.Fatal("departed player still attacked", hits)
		}
	case <-time.After(time.Second):
		t.Fatal("room could not process next input")
	}
	select {
	case <-room.actor.Done():
		t.Fatal("leave stopped other viewers' fight")
	default:
	}
	// Pending views have not received a join, so leave must emit no ROOM_CLOSED.
	select {
	case b := <-p.queue:
		t.Fatal("first frame was a leave", b)
	default:
	}
}

type fightEpochFixture struct {
	first, second *chunkwire.WildsEpoch
	turn          int64
}

func (f *fightEpochFixture) Current(_ context.Context, _ *sql.Tx, _, _ string, now int64) (*chunkwire.WildsEpoch, error) {
	if now >= f.turn {
		return proto.Clone(f.second).(*chunkwire.WildsEpoch), nil
	}
	return proto.Clone(f.first).(*chunkwire.WildsEpoch), nil
}
func (f *fightEpochFixture) Create(ctx context.Context, tx *sql.Tx, world, kind string, now int64) (*chunkwire.WildsEpoch, error) {
	return f.Current(ctx, tx, world, kind, now)
}

type fightChunkFixture struct {
	chunks map[string]*chunkwire.WorldChunk
	calls  atomic.Int64
}

// Chunk serves the epoch's chunk at any coordinates; only (0,0) keeps its
// camp, and calls counts that camp chunk's loads.
func (f *fightChunkFixture) Chunk(_ context.Context, _ *sql.Tx, _, epoch string, _, cx, cy int32) (*chunkwire.WorldChunk, error) {
	c := proto.Clone(f.chunks[epoch]).(*chunkwire.WorldChunk)
	c.Cx, c.Cy = cx, cy
	if cx == 0 && cy == 0 {
		f.calls.Add(1)
	} else {
		c.Entities = withoutCamps(c.Entities)
	}
	return c, nil
}
func epochAdapterFixture(t *testing.T, x *rig) (*fightEpochFixture, *fightChunkFixture) {
	turn := x.now.Load() + 1
	epochs := &fightEpochFixture{first: &chunkwire.WildsEpoch{Id: "first", Kind: "still", WorldSeed: "seed", EndsAt: wrapperspb.Double(float64(turn))}, second: &chunkwire.WildsEpoch{Id: "second", Kind: "still", WorldSeed: "seed"}, turn: turn}
	source := &fightChunkFixture{chunks: map[string]*chunkwire.WorldChunk{}}
	for _, ep := range []*chunkwire.WildsEpoch{epochs.first, epochs.second} {
		chunk, err := fakegen.New().Chunk(ep, 0, 0, nil)
		if err != nil {
			t.Fatal(err)
		}
		source.chunks[ep.Id] = chunk
	}
	x.api.Config.Epochs = epochs
	x.api.Config.Chunks = source
	return epochs, source
}
func TestFightHubEpochTurnUsesNewFullKeyAndHandle(t *testing.T) {
	x, p, _, _ := adapterFightFixture(t)
	_, source := epochAdapterFixture(t, x)
	x.api.syncFightPresence(p)
	join := queuedFightFrame(t, p).GetFightJoin()
	if join == nil || join.RoomKey.Epoch != "first" {
		t.Fatal(join)
	}
	h := x.api.presence
	h.mu.Lock()
	original := p.fightRooms[join.Room]
	// A same-coordinate cache entry in another realm/layer must not win lookup.
	foreignKey := original.key
	foreignKey.Realm = "cave"
	foreignKey.Layer = 1
	h.fightRooms[foreignKey] = &presenceFightRoom{key: foreignKey, handle: 999, actor: original.actor}
	h.mu.Unlock()
	x.api.syncFightPresence(p)
	if source.calls.Load() != 1 {
		t.Fatal("exact-key cache missed", source.calls.Load())
	}
	h.mu.Lock()
	if p.fightRooms[999] != nil {
		t.Error("attached foreign realm/layer")
	}
	delete(h.fightRooms, foreignKey)
	h.mu.Unlock()
	x.now.Add(1)
	x.api.syncFightPresence(p)
	var next *wire.FightJoin
	for next == nil {
		next = queuedFightFrame(t, p).GetFightJoin()
	}
	if next.RoomKey.Epoch != "second" || next.Room == join.Room || next.RoomKey.Realm != join.RoomKey.Realm || source.calls.Load() != 2 {
		t.Fatal("stale epoch cache", next, source.calls.Load())
	}
}
func TestFightCamplessWakeCachedPerEpochAndWorld(t *testing.T) {
	for _, failure := range []string{"missing", "empty"} {
		t.Run(failure, func(t *testing.T) {
			x, p, _, _ := adapterFightFixture(t)
			_, source := epochAdapterFixture(t, x)
			bad := source.chunks["first"]
			if failure == "missing" {
				bad.Entities = bad.Entities[1:]
			} else {
				bad.Entities[0].Enemies = nil
			}
			for range 8 {
				x.api.syncFightPresence(p)
			}
			if source.calls.Load() != 1 || len(p.fightRooms) != 0 {
				t.Fatal("campless chunk was reloaded", source.calls.Load())
			}
			identity := p.identity
			identity.ID = "other-account"
			identity.World = "other-world"
			ctx, cancel := context.WithCancel(context.Background())
			q := &presencePeer{identity: identity, ctx: ctx, cancel: cancel, queue: make(chan []byte, 32), area: p.area, pos: &presencePosition{X: 185, Y: 208}}
			x.api.presence.mu.Lock()
			x.api.presence.admit(q)
			x.api.presence.mu.Unlock()
			for range 3 {
				x.api.syncFightPresence(q)
			}
			if source.calls.Load() != 2 {
				t.Fatal("negative cache crossed worlds", source.calls.Load())
			}
			x.now.Add(1)
			x.api.syncFightPresence(p)
			if queuedFightFrame(t, p).GetFightJoin() == nil || source.calls.Load() != 3 {
				t.Fatal("negative cache survived epoch end")
			}
		})
	}
}
func TestFightReportCommitRefreshesDownAndRetargets(t *testing.T) {
	x, p, c, state := adapterFightFixture(t)
	x.api.syncFightPresence(p)
	join := queuedFightFrame(t, p).GetFightJoin()
	if join == nil {
		t.Fatal("no join")
	}
	// A second real account in this world is an eligible replacement target.
	bc, bs := x.ready("bob")
	if _, err := x.db.DB.Exec("UPDATE players SET world_id=? WHERE account_id=?", p.identity.World, bs.AccountID); err != nil {
		t.Fatal(err)
	}
	identity, err := x.api.presenceIdentity(context.Background(), store.Hash(bc.Value), false)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	q := &presencePeer{identity: identity, account: &presenceAccount{}, ctx: ctx, cancel: cancel, queue: make(chan []byte, 256), area: p.area, pos: &presencePosition{X: 220, Y: 208}}
	h := x.api.presence
	h.mu.Lock()
	h.admit(q)
	h.mu.Unlock()
	x.api.syncFightPresence(q)
	queuedFightFrame(t, q)
	x.now.Add(1)
	// Two accounts at the camp: its first aggro raises one extra wisp first.
	var windup *wire.FightEvent
	for windup == nil || windup.Kind != wire.FightEventKind_FIGHT_EVENT_KIND_WINDUP_START {
		windup = queuedFightFrame(t, p).GetFightEvent()
	}
	if windup.GetTarget() != p.identity.ID {
		t.Fatal("setup did not target Alice", windup)
	}
	x.reportState(c, state, 0, state.State.Mana, map[string]any{"area": "outdoors", "x": 185, "y": 208})
	h.mu.Lock()
	down := p.identity.Magic.Down
	h.handleFightSwing(p, swingForPeer(p, &wire.FightTarget{Room: join.Room, Enemy: 0}))
	h.mu.Unlock()
	if !down || queuedFightResult(t, p).RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_NOT_ALLOWED {
		t.Fatal("committed fall did not refuse swings")
	}
	// Position/Down cover is queued before the next grid advancement.
	x.now.Add(1)
	var lock *wire.FightEvent
	for lock == nil {
		lock = queuedFightFrame(t, p).GetFightEvent()
	}
	if lock.GetTarget() != q.identity.ID {
		t.Fatal("wisp retained a fallen target", lock)
	}
}
func TestFightClosePresenceDrainsActorsAndInflightGather(t *testing.T) {
	h := newPresenceHub(nil, func() time.Time { return time.UnixMilli(100000) })
	a := &Server{presence: h}
	p := unitFightPeer(t, h)
	addUnitFightRoom(t, a, p, 1, 0, 10)
	p.identity.Magic.Kit.Class = "mage"
	swing := swingForPeer(p)
	swing.Kind = wire.FightSwingKind_FIGHT_SWING_KIND_BOLT
	h.mu.Lock()
	room := p.fightRooms[1]
	h.handleFightSwing(p, swing)
	h.mu.Unlock()
	done := make(chan struct{})
	go func() { a.ClosePresence(); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("shutdown stranded actor/gather")
	}
	select {
	case <-room.actor.Done():
	default:
		t.Fatal("live actor escaped shutdown")
	}
	h.fightGathers.Wait()
	if p.ctx.Err() == nil || len(h.fightRooms) != 0 {
		t.Fatal("shutdown left live fight resources")
	}
}
func TestFightFirstFrameIsJoin(t *testing.T) {
	h := newPresenceHub(nil, func() time.Time { return time.UnixMilli(100000) })
	a := &Server{presence: h}
	p := unitFightPeer(t, h)
	room, _ := blockedFightRoom(t, a, p, 1, 0, 10)
	delta := &wire.FightDelta{Room: 1, Tick: 1001, Changed: []*wire.FightEnemyPatch{{Enemy: 0, X: proto.Int32(11)}}}
	a.fightOutput(room, fights.Output{Message: delta})
	a.fightOutput(room, fights.Output{Message: &wire.FightEvent{Room: 1, Tick: 1001, Kind: wire.FightEventKind_FIGHT_EVENT_KIND_WINDUP_START, Enemy: proto.Uint32(0)}})
	select {
	case b := <-p.queue:
		t.Fatal("pre-join fight frame", b)
	default:
	}
	join := &wire.FightJoin{RoomKey: room.key.Wire(), Room: 1, Tick: 1001, CritSeed: p.critSeed}
	a.fightOutput(room, fights.Output{Observer: p.fightToken, Message: join})
	a.fightOutput(room, fights.Output{Message: delta})
	if queuedFightFrame(t, p).GetFightJoin() == nil || queuedFightFrame(t, p).GetFightDelta() == nil {
		t.Fatal("join did not establish patch baseline")
	}
}

type edgeFightChunk struct{ source chunks.ChunkSource }

func (e edgeFightChunk) Chunk(ctx context.Context, tx *sql.Tx, world, epoch string, layer, cx, cy int32) (*chunkwire.WorldChunk, error) {
	c, err := e.source.Chunk(ctx, tx, world, epoch, layer, cx, cy)
	if err == nil {
		c = proto.Clone(c).(*chunkwire.WorldChunk)
		for _, entity := range c.Entities {
			if entity.Id == "camp:0:0:0" {
				entity.Tx = 23
			}
		}
	}
	return c, err
}
func TestFightWildsChunkCrossingRetainsJoinAndSwingCoverage(t *testing.T) {
	x := newRig(t)
	c, state := x.ready("alice")
	x.api.Config.Chunks = edgeFightChunk{source: &fightChunkCounter{ChunkSource: x.api.Config.Chunks}}
	cfg := presenceTestConfig()
	cfg.RevalidateMs = 10000
	ts := startPresence(t, x, cfg)
	w := wsConnect(t, ts, c, state.Lease)
	w.join("outdoors:0:0")
	w.send(map[string]any{"type": "pos", "x": 365, "y": 208, "facing": map[string]any{"x": 1, "y": 0}, "moving": false})
	join := socketFight(t, w, "fightJoin").GetFightJoin()
	h := x.api.presence
	h.mu.Lock()
	peer := h.peers[x.account("alice")]
	peer.identity.Magic.Kit.CritChance = 0
	h.mu.Unlock()
	w.join("outdoors:1:0")
	w.none() // No ROOM_CLOSED and no replacement FightJoin.
	tick, _ := rules.FightTickAt(x.now.Load() * 1000)
	// The position report has not arrived yet. Retained coverage still judges
	// this first (counter 0) socket swing from its capped crossing origin.
	swing := &wire.FightSwing{Kind: wire.FightSwingKind_FIGHT_SWING_KIND_SLASH, X: 385, Y: 208, Facing: &wire.FightFacing{X: -1}, SeenTick: tick, Predicted: []*wire.FightTarget{{Room: join.Room, Enemy: 0}}}
	writeFight(t, w, swing)
	hit := socketFight(t, w, "fightSwingResult").GetFightSwingResult()
	if hit.SwingCounter != 0 || hit.RefusedReason != 0 || len(hit.Hits) != 1 || hit.Hits[0].Damage <= 0 {
		t.Fatal("crossing swing whiffed", hit)
	}
	h.mu.Lock()
	peer.lastPos = time.Time{}
	h.mu.Unlock()
	w.send(map[string]any{"type": "pos", "x": 385, "y": 208, "facing": map[string]any{"x": -1, "y": 0}, "moving": false})
	w.none()
	h.mu.Lock()
	same := peer.fightRooms[join.Room] != nil && peer.fightJoined[join.Room]
	h.mu.Unlock()
	if !same {
		t.Fatal("crossing replaced room view")
	}
	// A label alone is not physical coverage: keep it until the next position
	// actually moves beyond the camp's 3x3, then close only that view.
	w.join("outdoors:2:0")
	w.none()
	h.mu.Lock()
	peer.lastPos = time.Time{}
	h.mu.Unlock()
	w.send(map[string]any{"type": "pos", "x": 778, "y": 208, "facing": map[string]any{"x": 1, "y": 0}, "moving": false})
	closed := socketFight(t, w, "fightEvent").GetFightEvent()
	if closed.Kind != wire.FightEventKind_FIGHT_EVENT_KIND_ROOM_CLOSED || closed.Room != join.Room {
		t.Fatal(closed)
	}
	w.none()
}

func TestFightCounterStartsAtZeroOnEachReadySocket(t *testing.T) {
	x := newRig(t)
	cookie, state := x.ready("alice")
	ts := startPresence(t, x, presenceTestConfig())
	first := wsConnect(t, ts, cookie, state.Lease)
	swing := &wire.FightSwing{Kind: wire.FightSwingKind_FIGHT_SWING_KIND_SLASH, Facing: &wire.FightFacing{X: 1}, SwingCounter: 777}
	writeFight(t, first, swing)
	if socketFight(t, first, "fightSwingResult").GetFightSwingResult().RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_NOT_ALLOWED {
		t.Fatal("setup counter was not consumed")
	}
	replacement := wsConnect(t, ts, cookie, state.Lease)
	first.closeStatus(presenceReplaced)
	swing.SwingCounter = 0
	writeFight(t, replacement, swing)
	result := socketFight(t, replacement, "fightSwingResult").GetFightSwingResult()
	if result.SwingCounter != 0 || result.RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_NOT_ALLOWED {
		t.Fatal("ready did not reset socket counter", result)
	}
}
