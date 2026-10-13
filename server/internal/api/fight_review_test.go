package api

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"glimway/content"
	"glimway/server/internal/fights"
	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
)

// A camp a 0.8 claim cleared has no fall record. Its room must wake it down
// (its base mix as dead rows) until the row's own timer, then raise the next
// cycle; the old cycle is never claimable again.
func TestLegacyClearedCampWakesDownUntilItsTimer(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.wilds(c, "tangle")
	camp := v.kind(t, "camp")
	cx, cy := entityChunkOf(camp)
	now := x.now.Load()
	available := now + int64(content.WildsRules.Timers.CampRespawnSeconds)
	if _, err := x.db.DB.Exec("INSERT INTO entity_state(epoch,entity_id,cycle,state,available_at,by_id,at) VALUES(?,?,0,'cleared',?,?,?)", v.Epoch.Id, camp.Id, available, x.account("alice"), now); err != nil {
		t.Fatal(err)
	}
	identity, err := x.api.presenceIdentity(context.Background(), store.Hash(c.Value), false)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	S := int(content.WildsRules.GetChunkSize())
	p := &presencePeer{identity: identity, account: &presenceAccount{}, ctx: ctx, cancel: cancel, queue: make(chan []byte, 256), area: fmt.Sprintf("wilds:%d:%d", cx, cy), pos: &presencePosition{X: float64((cx*S+int(camp.Tx))*16 + 8), Y: float64((cy*S + int(camp.Ty)) * 16)}, fightRooms: map[uint32]*presenceFightRoom{}}
	x.api.presence.admit(p)
	t.Cleanup(x.api.ClosePresence)
	x.api.syncFightPresence(p)
	var join *wire.FightJoin
	for join == nil {
		if j := queuedFightFrame(t, p).GetFightJoin(); j != nil && j.RoomKey.Cx == int32(cx) && j.RoomKey.Cy == int32(cy) {
			join = j
		}
	}
	dead := map[uint32]bool{}
	for _, e := range join.Enemies {
		if e.CampId != camp.Id {
			continue
		}
		if e.Hp != 0 || e.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_DEAD {
			t.Fatal("a 0.8-cleared camp woke live", e)
		}
		dead[e.Enemy] = true
	}
	if len(dead) == 0 {
		t.Fatal("the camp's room has no rows for it", join)
	}
	// No fall, so nothing to claim: the 0.8 claim already settled cycle 0.
	if _, code := x.claim(c, s, "legacy", v.Epoch.Id, camp, 0, at(camp, 0), 409); code != "not-defeated" {
		t.Fatal("legacy cycle claimable", code)
	}
	if st := x.wilds(c, "tangle").state(camp.Id); st.State != "cleared" || st.CampClaimable {
		t.Fatalf("legacy near read %+v", st)
	}
	// At the row's timer the awake room raises cycle 1, fresh.
	x.now.Store(available)
	removed, spawned := map[uint32]bool{}, 0
	for len(removed) < len(dead) || spawned == 0 {
		d := queuedFightFrame(t, p).GetFightDelta()
		if d == nil || d.Room != join.Room {
			continue
		}
		for _, idx := range d.Removed {
			removed[idx] = dead[idx]
		}
		for _, e := range d.Spawned {
			if e.CampId == camp.Id && e.Hp > 0 && !dead[e.Enemy] {
				spawned++
			}
		}
	}
	for idx, ok := range removed {
		if !ok {
			t.Fatal("removed a row that was not the dead cycle's", idx)
		}
	}
	if w := campWake(t, x.api, s.WorldID, v.Epoch.Id, camp, x.api.presence.now()); w.Fallen || w.Cycle != 1 {
		t.Fatal("next cycle", w)
	}
}

// A Shadowstep that crosses a chunk edge is one dash: the hub works out its
// end over both chunks' ground, so the rooms on either side strike at the
// same end (each room alone took its edge for a wall, and neither let the
// dash cross it).
func TestShadowstepAcrossAChunkEdgeStrikesAtOneEnd(t *testing.T) {
	h := newPresenceHub(nil, func() time.Time { return time.UnixMilli(100000) })
	a := &Server{presence: h}
	p := unitFightPeer(t, h)
	p.identity.Magic.Kit.SignatureDamage = 4
	p.pos.X = -54.5
	addUnitFightRoom(t, a, p, 1, -1, -10) // west of the edge at x=0
	addUnitFightRoom(t, a, p, 2, 0, 40)   // east of it; the dash ends at x=10
	h.mu.Lock()
	h.handleFightCast(p, castFor("shadowstep", -54.5, 112, 1, 1, &wire.FightTarget{Room: 1, Enemy: 0}, &wire.FightTarget{Room: 2, Enemy: 0}))
	h.mu.Unlock()
	r := queuedFightResult(t, p)
	if len(r.Hits) != 2 || r.Hits[0].RefusedReason != 0 || r.Hits[1].RefusedReason != 0 || r.Hits[1].Damage != 4 {
		t.Fatal("the dash's end differs between the rooms", r)
	}
	h.fightGathers.Wait()
}

func TestFightLocationCacheIsBoundedAndGroundCanBeInvalidated(t *testing.T) {
	h := newPresenceHub(nil, func() time.Time { return time.UnixMilli(100000) })
	geom := fights.Geometry{Size: 24, Open: make([]bool, 24*24)}
	for i := range geom.Open {
		geom.Open[i] = true
	}
	first := fightLocation{world: "world-0", realm: "hearthwick", cx: 0}
	firstKey := fights.Key{World: first.world, Realm: first.realm, Epoch: "epoch-0", CX: first.cx}
	h.mu.Lock()
	for n := 0; n < fightLocationCacheLimit+44; n++ {
		location := fightLocation{world: fmt.Sprintf("world-%d", n), realm: "hearthwick", cx: int32(n)}
		key := fights.Key{World: location.world, Realm: location.realm, Epoch: fmt.Sprintf("epoch-%d", n), CX: location.cx}
		h.setFightLocationLocked(location, fightLocationEpoch{key: key, geometry: geom})
		h.fightFailedWakes[key] = true
	}
	if len(h.fightLocations) != fightLocationCacheLimit || len(h.fightLocationOrder) != fightLocationCacheLimit || len(h.fightFailedWakes) > fightLocationCacheLimit {
		h.mu.Unlock()
		t.Fatal("fight location caches exceeded their bounds", len(h.fightLocations), len(h.fightLocationOrder), len(h.fightFailedWakes))
	}
	if _, ok := h.fightLocations[first]; ok || h.fightFailedWakes[firstKey] {
		h.mu.Unlock()
		t.Fatal("eviction retained stale geometry or its negative wake marker")
	}
	loc := fightLocation{world: "ground-world", realm: "hearthwick", cx: 4, cy: -2}
	key := fights.Key{World: loc.world, Realm: loc.realm, Epoch: "active-epoch", CX: loc.cx, CY: loc.cy}
	other := fightLocation{world: loc.world, realm: loc.realm, cx: 5, cy: -2}
	h.setFightLocationLocked(loc, fightLocationEpoch{key: key, geometry: geom})
	h.setFightLocationLocked(other, fightLocationEpoch{key: fights.Key{World: other.world, Realm: other.realm, Epoch: key.Epoch, CX: other.cx, CY: other.cy}, geometry: geom})
	h.mu.Unlock()
	h.invalidateFightGround(loc.world, key.Epoch, loc.cx, loc.cy)
	h.mu.Lock()
	if _, ok := h.fightLocations[loc]; ok {
		h.mu.Unlock()
		t.Fatal("committed ground edit retained cached geometry")
	}
	if _, ok := h.fightLocations[other]; !ok {
		h.mu.Unlock()
		t.Fatal("ground edit invalidated a neighboring chunk")
	}
	roomLocation := fightLocation{world: "sleep-world", realm: "hearthwick", cx: 1, cy: 2}
	roomKey := fights.Key{World: roomLocation.world, Realm: roomLocation.realm, Epoch: "sleep-epoch", CX: roomLocation.cx, CY: roomLocation.cy}
	room := &presenceFightRoom{key: roomKey, handle: 7}
	h.fightLocations[roomLocation] = fightLocationEpoch{key: roomKey, geometry: geom}
	h.fightLocationOrder[roomLocation] = 1
	h.fightRooms[roomKey] = room
	h.mu.Unlock()
	a := &Server{presence: h}
	a.fightClosed(room)
	h.mu.Lock()
	_, retained := h.fightLocations[roomLocation]
	_, awake := h.fightRooms[roomKey]
	h.mu.Unlock()
	if retained || awake {
		t.Fatal("closed room kept its wake geometry/cache identity", retained, awake)
	}
}

func TestFightGroundKeepsActiveRoomWakeGeometry(t *testing.T) {
	h := newPresenceHub(nil, func() time.Time { return time.UnixMilli(100000) })
	active := fights.Geometry{CX: 0, CY: 0, Size: 24, Open: make([]bool, 24*24)}
	for i := range active.Open {
		active.Open[i] = true
	}
	active.Open[1*24+2] = false // wall at world tile 2,1
	refreshed := active
	refreshed.Open = append([]bool(nil), active.Open...)
	refreshed.Open[1*24+2] = true
	key := fights.Key{World: "world", Realm: "hearthwick", Epoch: "epoch", CX: 0, CY: 0}
	room := &presenceFightRoom{key: key, handle: 1, geometry: active}
	peer := &presencePeer{identity: presenceIdentity{World: key.World}, fightRooms: map[uint32]*presenceFightRoom{room.handle: room}}
	h.mu.Lock()
	h.fightRooms[key] = room
	h.fightLocations[fightLocation{world: key.World, realm: key.Realm, layer: key.Layer, cx: key.CX, cy: key.CY}] = fightLocationEpoch{key: key, geometry: refreshed}
	ground := h.fightGround(peer, 24, 24)
	h.mu.Unlock()
	x, _ := ground.Dash(24, 24, 1, 0)
	if x > 27 {
		t.Fatal("refreshed cache geometry replaced the active room's wake-time wall", x)
	}
}

func TestFightGroundCamplessClearRefreshesDashGeometry(t *testing.T) {
	h := newPresenceHub(nil, func() time.Time { return time.UnixMilli(100000) })
	blocked := fights.Geometry{CX: 0, CY: 0, Size: 24, Open: make([]bool, 24*24)}
	for i := range blocked.Open {
		blocked.Open[i] = true
	}
	blocked.Open[1*24+2] = false // the cleared tile at world (2,1)
	cleared := blocked
	cleared.Open = append([]bool(nil), blocked.Open...)
	cleared.Open[1*24+2] = true
	key := fights.Key{World: "world", Realm: "hearthwick", Epoch: "epoch", CX: 0, CY: 0}
	location := fightLocation{world: key.World, realm: key.Realm, layer: key.Layer, cx: key.CX, cy: key.CY}
	peer := &presencePeer{identity: presenceIdentity{World: key.World}}
	h.mu.Lock()
	h.setFightLocationLocked(location, fightLocationEpoch{key: key, geometry: blocked})
	old := h.fightGround(peer, 24, 24)
	h.mu.Unlock()
	before, _ := old.Dash(24, 24, 1, 0)
	if before > 27 {
		t.Fatal("dash crossed the cached blocking tile before it was cleared", before)
	}
	h.invalidateFightGround(key.World, key.Epoch, key.CX, key.CY)
	h.mu.Lock()
	h.setFightLocationLocked(location, fightLocationEpoch{key: key, geometry: cleared})
	updated := h.fightGround(peer, 24, 24)
	h.mu.Unlock()
	after, _ := updated.Dash(24, 24, 1, 0)
	if after <= 27 {
		t.Fatal("dash still hit the obsolete campless wall after refresh", after)
	}
}

// tickedFightRoom is a unit room whose grid ticks the test drives, with its
// deltas kept, on a clock the test moves.
type tickedFightRoom struct {
	room   *presenceFightRoom
	ticks  chan time.Time
	deltas chan *wire.FightDelta
}

func addTickedFightRoom(t *testing.T, a *Server, p *presencePeer, handle uint32, cx int, x float64) tickedFightRoom {
	a.presence.mu.Lock()
	defer a.presence.mu.Unlock()
	g := fights.Geometry{CX: cx, Size: 24, Open: make([]bool, 24*24)}
	for i := range g.Open {
		g.Open[i] = true
	}
	key := fights.Key{World: "world", Realm: "hearthwick", Epoch: "epoch", CX: int32(cx)}
	tr := tickedFightRoom{room: &presenceFightRoom{key: key, handle: handle, geometry: g}, ticks: make(chan time.Time), deltas: make(chan *wire.FightDelta, 64)}
	sim := fights.NewRoom(key, handle, g, []fights.Camp{{ID: "camp", Kinds: []string{"wisp"}, X: x, Y: 112}}, 1, a.presence.now(), 0)
	tr.room.actor = fights.Start(sim, fights.ActorConfig{Now: a.presence.now, Ticks: tr.ticks, Emit: func(out fights.Output) {
		if d, ok := out.Message.(*wire.FightDelta); ok {
			tr.deltas <- d
		}
		a.fightOutput(tr.room, out)
	}, Closed: func() { a.fightClosed(tr.room) }})
	a.presence.viewFightRoom(p, tr.room)
	a.presence.fightRooms[key] = tr.room
	tr.room.actor.Submit(fights.Command{Player: &fights.Player{ID: p.identity.ID, Observer: p.fightToken, Seed: p.critSeed, X: p.pos.X, Y: p.pos.Y}})
	t.Cleanup(func() { tr.room.actor.Stop(); <-tr.room.actor.Done() })
	return tr
}

// settle waits until the room's actor has handled every command submitted so
// far. Its select may take a ready tick before a queued command, so a test
// that ticks right after a swing would otherwise race the swing (seen under
// -race in CI). An unknown Clear is a no-op that answers in input order.
func (tr tickedFightRoom) settle(t *testing.T) {
	t.Helper()
	done := make(chan fights.Cleared, 1)
	if !tr.room.actor.Submit(fights.Command{Clear: "settle", Cleared: done}) {
		t.Fatal("the room refused the barrier")
	}
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("the room never reached the barrier")
	}
}

// hurt is the enemy rows a room's deltas so far took damage on.
func (tr tickedFightRoom) hurt() int {
	n := 0
	for {
		select {
		case d := <-tr.deltas:
			for _, c := range d.Changed {
				if c.Hp != nil {
					n++
				}
			}
		default:
			return n
		}
	}
}

// A bolt (a mage's basic bolt, and a Fingersnap) sent to two adjacent rooms
// lands once: on the nearest enemy along its flight, whichever room ticks
// first. The other copy answers at once, so the one result for the counter
// comes without waiting for the bolt's lifetime or the gather's deadline.
func TestBoltLandsOnceAcrossAdjacentRooms(t *testing.T) {
	for _, kind := range []string{"bolt", "fingersnap"} {
		for _, westFirst := range []bool{true, false} {
			t.Run(fmt.Sprintf("%s/west-first=%v", kind, westFirst), func(t *testing.T) {
				var clock atomic.Int64
				clock.Store(100000)
				h := newPresenceHub(nil, func() time.Time { return time.UnixMilli(clock.Load()) })
				a := &Server{presence: h}
				p := unitFightPeer(t, h)
				p.pos.X = -60
				p.identity.Magic.Kit.Class = "mage"
				p.identity.Magic.Kit.MeleeDamage = 3
				p.identity.Magic.Kit.SignatureDamage = 4
				west := addTickedFightRoom(t, a, p, 1, -1, -10) // reached at sample 9
				east := addTickedFightRoom(t, a, p, 2, 0, 20)   // at sample 19, in reach too
				predicted := []*wire.FightTarget{{Room: 1, Enemy: 0}, {Room: 2, Enemy: 0}}
				tick, _ := rules.FightTickAt(clock.Load())
				h.mu.Lock()
				damage := 3.0
				if kind == "bolt" {
					h.handleFightSwing(p, &wire.FightSwing{Kind: wire.FightSwingKind_FIGHT_SWING_KIND_BOLT, X: -60, Y: 112, Facing: &wire.FightFacing{X: 1}, SwingCounter: 5, SeenTick: tick, Predicted: predicted})
				} else {
					damage = 4
					h.handleFightCast(p, castFor("fingersnap", -60, 112, 1, 5, predicted...))
				}
				h.mu.Unlock()
				west.settle(t)
				east.settle(t)
				order := []tickedFightRoom{west, east}
				if !westFirst {
					order = []tickedFightRoom{east, west}
				}
				began := time.Now()
				for _, ms := range []int64{100100, 100200, 100300} {
					clock.Store(ms)
					for _, room := range order {
						room.ticks <- time.UnixMilli(ms)
					}
				}
				r := queuedFightResult(t, p)
				if time.Since(began) > time.Second {
					t.Fatal("the result waited for the gather's deadline")
				}
				if r.SwingCounter != 5 || len(r.Hits) != 2 || r.Hits[0].Room != 1 || r.Hits[0].Damage != damage || r.Hits[0].RefusedReason != 0 || r.Hits[1].Room != 2 || r.Hits[1].Damage != 0 {
					t.Fatal("not one impact on the nearest enemy", r)
				}
				clock.Store(100400)
				for _, room := range order {
					room.ticks <- time.UnixMilli(100400)
				}
				// Ticks are handed over synchronously; wait for the deltas.
				deadline := time.Now().Add(time.Second)
				w := 0
				for w == 0 && time.Now().Before(deadline) {
					w += west.hurt()
					time.Sleep(5 * time.Millisecond)
				}
				if w != 1 || east.hurt() != 0 {
					t.Fatal("damage landed in the wrong rooms", w)
				}
				select {
				case b := <-p.queue:
					if m, _ := decodePresence(b); m.GetFightSwingResult() != nil {
						t.Fatal("a second result for one counter", m)
					}
				default:
				}
			})
		}
	}
}

// The writer's queue is keyed by the room's full identity: two falls that
// share epoch, camp and cycle but not realm or layer stay two queued falls,
// each read back exactly (with only its own witnesses) while the writer is
// held, and a third variant reads as no fall.
func TestQueuedFallReadsByTheFullKey(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	v := x.wilds(c, "tangle")
	camp := v.kind(t, "camp")
	gate := gateFalls(x.api)
	defer closeFalls(t, x.api)
	at := x.now.Load() * 1000
	here := campFall(s.WorldID, v.Epoch.Id, camp, 0, at, "alice")
	other := campFall(s.WorldID, v.Epoch.Id, camp, 0, at+5, "bob")
	other.Key.Realm, other.Key.Layer = "elsewhere", 1
	for _, f := range []fights.Fall{here, other} {
		if err := x.api.EnqueueFall(f); err != nil {
			t.Fatal(err)
		}
	}
	read := func(f fights.Fall) (store.FallRecord, bool) {
		t.Helper()
		tx, err := x.db.DB.BeginTx(context.Background(), nil)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		rec, ok, err := x.api.ReadFallInTx(context.Background(), tx, fallRecord(f).Key)
		if err != nil {
			t.Fatal(err)
		}
		return rec, ok
	}
	if rec, ok := read(here); !ok || rec.FellAt != at || len(rec.Witnesses) != 1 || rec.Witnesses[0] != "alice" {
		t.Fatal("this realm's queued fall", rec, ok)
	}
	if rec, ok := read(other); !ok || rec.FellAt != at+5 || len(rec.Witnesses) != 1 || rec.Witnesses[0] != "bob" {
		t.Fatal("the other realm's queued fall", rec, ok)
	}
	third := here
	third.Key.Layer = 1
	if rec, ok := read(third); ok {
		t.Fatal("a layer with no fall read one", rec)
	}
	close(gate)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := x.api.DrainFalls(ctx); err != nil {
		t.Fatal(err)
	}
}
