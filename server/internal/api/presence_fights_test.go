package api

import (
	"context"
	"math"
	"sync/atomic"
	"testing"
	"time"

	"buf.build/go/protovalidate"
	"database/sql"
	"github.com/coder/websocket"
	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/fights"
	chunkwire "glimway/server/internal/gen/glimway/v1"
	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
	"google.golang.org/protobuf/proto"
)

func queuedFightResult(t *testing.T, p *presencePeer) *wire.FightSwingResult {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case b := <-p.queue:
			m, err := decodePresence(b)
			if err != nil {
				t.Fatal(err)
			}
			if err = protovalidate.Validate(m); err != nil {
				t.Fatal(err)
			}
			if v := m.GetFightSwingResult(); v != nil {
				return v
			}
		case <-timer.C:
			t.Fatal("no fight result")
			return nil
		}
	}
}
func unitFightPeer(t *testing.T, h *presenceHub) *presencePeer {
	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	p := &presencePeer{identity: presenceIdentity{ID: "alice", World: "world", Magic: presenceMagic{Kit: rules.CombatKitFor(nil, "", 0)}}, ctx: ctx, cancel: cancel, queue: make(chan []byte, 64), area: "outdoors:0:0", pos: &presencePosition{X: 0, Y: 112}, fightRooms: map[uint32]*presenceFightRoom{}}
	h.admit(p)
	h.fightObserver(p)
	p.identity.Magic.Kit.CritChance = 0
	return p
}
func addUnitFightRoom(t *testing.T, a *Server, p *presencePeer, handle uint32, cx int, x float64) {
	a.presence.mu.Lock()
	defer a.presence.mu.Unlock()
	g := fights.Geometry{CX: cx, Size: 24, Open: make([]bool, 24*24)}
	for i := range g.Open {
		g.Open[i] = true
	}
	key := fights.Key{World: "world", Realm: "hearthwick", Epoch: "epoch", CX: int32(cx)}
	room := &presenceFightRoom{key: key, handle: handle, geometry: g}
	sim := fights.NewRoom(key, handle, g, []fights.Camp{{ID: "camp", Kinds: []string{"wisp"}, X: x, Y: 112}}, 1, a.presence.now(), 0)
	// No wall-clock tick in a unit socket test; inputs are FIFO commands.
	room.actor = fights.Start(sim, fights.ActorConfig{Now: a.presence.now, Ticks: make(chan time.Time), Emit: func(out fights.Output) { a.fightOutput(room, out) }, Closed: func() { a.fightClosed(room) }})
	a.presence.viewFightRoom(p, room)
	a.presence.fightRooms[key] = room
	room.actor.Submit(fights.Command{Player: &fights.Player{ID: p.identity.ID, Observer: p.fightToken, Seed: p.critSeed, X: p.pos.X, Y: p.pos.Y}})
	t.Cleanup(func() { room.actor.Stop(); <-room.actor.Done() })
}
func TestFightGatherAcrossRoomsCountersCooldownAndPredictions(t *testing.T) {
	var ms atomic.Int64
	ms.Store(100000)
	h := newPresenceHub(nil, func() time.Time { return time.UnixMilli(ms.Load()) })
	a := &Server{presence: h}
	p := unitFightPeer(t, h)
	addUnitFightRoom(t, a, p, 1, -1, -10)
	addUnitFightRoom(t, a, p, 2, 0, 10)
	s := &wire.FightSwing{Kind: wire.FightSwingKind_FIGHT_SWING_KIND_SLASH, X: 0, Y: 112, Facing: &wire.FightFacing{X: 1}, SwingCounter: math.MaxUint32, SeenTick: 1000, Predicted: []*wire.FightTarget{{Room: 1, Enemy: 0}, {Room: 2, Enemy: 0}, {Room: 999, Enemy: 12}}}
	h.mu.Lock()
	h.handleFightSwing(p, s)
	h.mu.Unlock()
	r := queuedFightResult(t, p)
	if r.SwingCounter != math.MaxUint32 || len(r.Hits) != 3 || r.Hits[0].RefusedReason != 0 || r.Hits[1].RefusedReason != 0 || r.Hits[2].RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_UNKNOWN_ENEMY {
		t.Fatal(r)
	}
	// Replay is stale. Wrapping is accepted but kit cooldown still applies.
	h.mu.Lock()
	h.handleFightSwing(p, s)
	h.mu.Unlock()
	if queuedFightResult(t, p).RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_STALE_COUNTER {
		t.Fatal("repeat accepted")
	}
	s = proto.Clone(s).(*wire.FightSwing)
	s.SwingCounter = 0
	h.mu.Lock()
	h.handleFightSwing(p, s)
	h.mu.Unlock()
	if queuedFightResult(t, p).RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_COOLDOWN {
		t.Fatal("cooldown bypassed")
	}
	ms.Add(600)
	s.SwingCounter = 1024
	s.SeenTick = 1006
	h.mu.Lock()
	h.handleFightSwing(p, s)
	h.mu.Unlock()
	if queuedFightResult(t, p).RefusedReason != 0 {
		t.Fatal("1024 counter window not accepted")
	}
	s = proto.Clone(s).(*wire.FightSwing)
	s.SwingCounter = 2049
	h.mu.Lock()
	h.handleFightSwing(p, s)
	h.mu.Unlock()
	if queuedFightResult(t, p).RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_STALE_COUNTER {
		t.Fatal("1025 counter gap accepted")
	}
	// The last accepted value did not advance on a stale counter.
	s = proto.Clone(s).(*wire.FightSwing)
	s.SwingCounter = 1025
	h.mu.Lock()
	p.pos = nil
	h.handleFightSwing(p, s)
	h.mu.Unlock()
	if queuedFightResult(t, p).RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_NOT_ALLOWED {
		t.Fatal("missing position was not refused")
	}
}
func TestFightIngressValidation(t *testing.T) {
	good := &wire.FightSwing{Kind: wire.FightSwingKind_FIGHT_SWING_KIND_SLASH, Facing: &wire.FightFacing{X: 1}}
	for _, change := range []func(*wire.FightSwing){func(s *wire.FightSwing) { s.Facing = nil }, func(s *wire.FightSwing) { s.X = math.NaN() }, func(s *wire.FightSwing) { s.Facing.X = 2 }, func(s *wire.FightSwing) { s.SeenOffsetMs = 100 }, func(s *wire.FightSwing) { s.Predicted = []*wire.FightTarget{{Room: 0}} }, func(s *wire.FightSwing) { s.Tool = true; s.Kind = wire.FightSwingKind_FIGHT_SWING_KIND_BOLT }} {
		bad := proto.Clone(good).(*wire.FightSwing)
		change(bad)
		if validateFightInput(&wire.PresenceMessage{Event: &wire.PresenceMessage_FightSwing{FightSwing: bad}}) == nil {
			t.Fatal("malformed swing accepted", bad)
		}
	}
	if validateFightInput(&wire.PresenceMessage{Event: &wire.PresenceMessage_FightSwing{FightSwing: good}}) != nil {
		t.Fatal("zero counter/tick rejected")
	}
	cast := &wire.PresenceAbility{Fight: &wire.FightCast{Facing: &wire.FightFacing{X: 1}, SeenOffsetMs: 100}}
	if validateFightInput(&wire.PresenceMessage{Event: &wire.PresenceMessage_Ability{Ability: cast}}) == nil {
		t.Fatal("malformed cast accepted")
	}
}

type fightChunkCounter struct {
	chunks.ChunkSource
	calls atomic.Int64
}

// Chunk keeps only camp:0:0:0, so a test follows one room, and counts that
// camp chunk's loads.
func (c *fightChunkCounter) Chunk(ctx context.Context, tx *sql.Tx, world, epoch string, layer, cx, cy int32) (*chunkwire.WorldChunk, error) {
	chunk, err := c.ChunkSource.Chunk(ctx, tx, world, epoch, layer, cx, cy)
	if err != nil {
		return nil, err
	}
	if cx == 0 && cy == 0 {
		c.calls.Add(1)
		return chunk, nil
	}
	chunk = proto.Clone(chunk).(*chunkwire.WorldChunk)
	chunk.Entities = withoutCamps(chunk.Entities)
	return chunk, nil
}
func withoutCamps(entities []*chunkwire.WildsEntity) []*chunkwire.WildsEntity {
	kept := []*chunkwire.WildsEntity{}
	for _, e := range entities {
		if e.Kind != "camp" {
			kept = append(kept, e)
		}
	}
	return kept
}
func socketFight(t *testing.T, w *wsClient, want string) *wire.PresenceMessage {
	t.Helper()
	timer := time.NewTimer(2 * time.Second)
	defer timer.Stop()
	for {
		select {
		case event := <-w.events:
			m, err := decodePresence(event.Binary)
			if err != nil {
				t.Fatal(err)
			}
			if err = protovalidate.Validate(m); err != nil {
				t.Fatal(err)
			}
			if event.Type == want {
				return m
			}
		case err := <-w.closed:
			t.Fatal(err)
			return nil
		case <-timer.C:
			t.Fatalf("no %s", want)
			return nil
		}
	}
}
func writeFight(t *testing.T, w *wsClient, m proto.Message) {
	t.Helper()
	b, err := encodePresence(m)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err = w.conn.Write(ctx, websocket.MessageBinary, b); err != nil {
		t.Fatal(err)
	}
}
func TestFightSocketWakeSharedJoinResultsLeaveAndReconnect(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, bs := x.ready("bob")
	var world string
	if err := x.db.DB.QueryRow("SELECT world_id FROM players WHERE account_id=?", x.account("alice")).Scan(&world); err != nil {
		t.Fatal(err)
	}
	if _, err := x.db.DB.Exec("UPDATE players SET world_id=? WHERE account_id=?", world, x.account("bob")); err != nil {
		t.Fatal(err)
	}
	tracker := &fightChunkCounter{ChunkSource: x.api.Config.Chunks}
	x.api.Config.Chunks = tracker
	cfg := presenceTestConfig()
	cfg.RevalidateMs = 10000
	ts := startPresence(t, x, cfg)
	var ms atomic.Int64
	ms.Store(x.now.Load() * 1000)
	x.api.presence.clock = func() time.Time { return time.UnixMilli(ms.Load()) }
	a := wsConnect(t, ts, c, s.Lease)
	a.join("outdoors:0:0")
	a.send(map[string]any{"type": "pos", "x": 185, "y": 208, "facing": map[string]any{"x": 1, "y": 0}, "moving": false})
	join := socketFight(t, a, "fightJoin").GetFightJoin()
	if join.RoomKey.World != world || join.RoomKey.Realm != content.WildsRules.GetRealm() || join.CritSeed == 0 || len(join.Enemies) != 1 || join.Enemies[0].Id != "wilds:camp:0:0:0:0" {
		t.Fatal(join)
	}
	b := wsConnect(t, ts, bc, bs.Lease)
	b.join("outdoors:1:0")
	// Adjacent chunk observers receive the same room, not another sim.
	b.send(map[string]any{"type": "pos", "x": 390, "y": 208, "facing": map[string]any{"x": -1, "y": 0}, "moving": false})
	other := socketFight(t, b, "fightJoin").GetFightJoin()
	if other.Room != join.Room || other.CritSeed == 0 {
		t.Fatal("separate room for adjacent observer", other)
	}
	if tracker.calls.Load() != 1 {
		t.Fatal("loaded geometry more than once", tracker.calls.Load())
	}
	tick, _ := rules.FightTickAt(ms.Load())
	swing := &wire.FightSwing{Kind: wire.FightSwingKind_FIGHT_SWING_KIND_SLASH, X: 185, Y: 208, Facing: &wire.FightFacing{X: 1}, SwingCounter: 0, SeenTick: tick, Predicted: []*wire.FightTarget{{Room: join.Room, Enemy: 0}}}
	writeFight(t, a, swing)
	result := socketFight(t, a, "fightSwingResult").GetFightSwingResult()
	if len(result.Hits) != 1 || result.Hits[0].RefusedReason != 0 || result.Crit != rules.FightCrit(join.CritSeed, 0, func() float64 { profile := x.profiles["alice"]; return rules.CombatKitFor(&profile, "", 0).CritChance }()) {
		t.Fatal(result)
	}
	// Hold the only DB connection: the tick and its delivery still run.
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	ms.Add(100)
	da := socketFight(t, a, "fightDelta").GetFightDelta()
	db := socketFight(t, b, "fightDelta").GetFightDelta()
	tx.Rollback()
	if !proto.Equal(da, db) || tracker.calls.Load() != 1 {
		t.Fatal("viewers disagreed or tick loaded geometry")
	}
	// A new socket gets fresh whole rows and a new seed, on the same handle.
	replacement := wsConnect(t, ts, c, s.Lease)
	fresh := socketFight(t, replacement, "fightJoin").GetFightJoin()
	if fresh.Room != join.Room || fresh.CritSeed == join.CritSeed || fresh.Enemies[0].Hp != join.Enemies[0].Hp-result.Hits[0].Damage {
		t.Fatal("reconnect lost authority", fresh)
	}
	// Its own join for the area it inherited (a reload inside the leave
	// grace names its area only after the registration's join went out)
	// announces the covered room again, on the same handle and seed.
	replacement.join("outdoors:0:0")
	again := socketFight(t, replacement, "fightJoin").GetFightJoin()
	if again.Room != join.Room || again.CritSeed != fresh.CritSeed || len(again.Enemies) != 1 {
		t.Fatal("a join for the held area did not announce the room again", again)
	}
	time.Sleep(5 * time.Millisecond) // past the test config's join cooldown
	a.closeStatus(presenceReplaced)
	replacement.send(map[string]any{"type": "join", "area": "in:village:library"})
	closed := socketFight(t, replacement, "fightEvent").GetFightEvent()
	if closed.Kind != wire.FightEventKind_FIGHT_EVENT_KIND_ROOM_CLOSED || closed.Room != join.Room {
		t.Fatal(closed)
	}
	socketFight(t, replacement, "room")
	// A cast allowAbility refuses (no position outside the Wilds) is answered NOT_ALLOWED.
	writeFight(t, replacement, &wire.PresenceAbility{Ability: "cleave", Fight: &wire.FightCast{Facing: &wire.FightFacing{X: 1}, SwingCounter: 1}})
	if socketFight(t, replacement, "fightSwingResult").GetFightSwingResult().RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_NOT_ALLOWED {
		t.Fatal("refused cast disappeared")
	}
}
func TestFightSocketRejectsInvalidWireBeforeHandling(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	ts := startPresence(t, x, presenceTestConfig())
	w := wsConnect(t, ts, c, s.Lease)
	writeFight(t, w, &wire.FightSwing{Kind: wire.FightSwingKind_FIGHT_SWING_KIND_SLASH, Facing: &wire.FightFacing{X: 2}})
	w.closeStatus(websocket.StatusPolicyViolation)
}
