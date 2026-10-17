package api

import (
	"context"
	"fmt"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"glimway/content"
	"glimway/server/internal/chunks/fakegen"
	"glimway/server/internal/fights"
	contract "glimway/server/internal/gen/glimway/v1"
	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/location"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
)

func nearChunkAt(v *contract.WildsNearResult, cx, cy int) *contract.NearChunk {
	for _, n := range v.Chunks {
		if int(n.Chunk.Cx) == cx && int(n.Chunk.Cy) == cy {
			return n
		}
	}
	return nil
}

// A held chunk (roadmap 0.12) is read under its pinned epoch across the
// turning: the near read lists it as held under that epoch, names the epoch
// once it is no longer this wick's, and serves its ground changes, laid
// before the turning and after; the chunk route serves it, and its
// neighbour turns.
func TestNearReadServesHeldChunks(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.give(s.AccountID, "stone", 2)
	const cx, cy = -3, 1 // the west lots' backland
	tx, ty := local(cx, cy, [2]int{3, 14})
	x.pathOp(c, s, "lay", "before", tx, ty+1, tx, ty, "stone", 200)
	dbtx, err := x.db.DB.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = x.api.Config.Chunks.(*store.Chunks).Hold(context.Background(), dbtx, s.WorldID, cx, cy, "test-hold", "0", x.now.Load()); err != nil {
		t.Fatal(err)
	}
	if err = dbtx.Commit(); err != nil {
		t.Fatal(err)
	}
	before := x.near(c, cx, cy, 200)
	if n := nearChunkAt(before, cx, cy); n.Source != location.SourceHeld.String() || n.Epoch != before.Wick.Id || len(before.Held) != 0 {
		t.Fatalf("held in its own wick: %+v, held %v", n, before.Held)
	}
	day := content.CalendarAt(content.CalendarRules, x.now.Load())
	x.now.Store(day.NextTurning + 60)
	c, s = x.again("alice")
	after := x.near(c, cx, cy, 200)
	if after.Wick.Id == before.Wick.Id || len(after.Held) != 1 || after.Held[0].Id != before.Wick.Id {
		t.Fatalf("after the turning: wick %s, held %v", after.Wick.Id, after.Held)
	}
	if n := nearChunkAt(after, cx, cy); n.Source != "held" || n.Epoch != before.Wick.Id {
		t.Fatalf("the held chunk after the turning: %+v", n)
	}
	if n := nearChunkAt(after, cx-1, cy); n.Source != "generated" || n.Epoch != after.Wick.Id {
		t.Fatalf("its neighbour: %+v", n)
	}
	x.chunk(c, before.Wick.Id, 0, cx, cy, 200)
	x.chunk(c, before.Wick.Id, 0, cx-1, cy, 409)
	x.pathOp(c, s, "lay", "after", tx+1, ty+1, tx+1, ty, "stone", 200)
	again := x.near(c, cx, cy, 200)
	var ground *contract.ChunkGroundChanges
	for _, g := range again.Ground {
		if int(g.Chunk.Cx) == cx && int(g.Chunk.Cy) == cy {
			ground = g
		}
	}
	if ground == nil || ground.Epoch != before.Wick.Id || groundAt(ground, 3, 14) == nil || groundAt(ground, 4, 14) == nil {
		t.Fatalf("the held chunk's ground: %v", ground)
	}
	if n := count(t, x.db, "SELECT count(*) FROM world_changes WHERE epoch=? AND ends_at IS NULL", before.Wick.Id); n != 1 {
		t.Fatalf("%d held ground rows never expire, want 1", n)
	}
}

// holdChunk holds a chunk for a lot lantern in the rig's world.
func (x *rig) holdChunk(world string, cx, cy int32) {
	x.t.Helper()
	dbtx, err := x.db.DB.BeginTx(context.Background(), nil)
	if err != nil {
		x.t.Fatal(err)
	}
	defer dbtx.Rollback()
	if _, err = x.api.Config.Chunks.(*store.Chunks).Hold(context.Background(), dbtx, world, cx, cy, "test-hold", "0", x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
	if err = dbtx.Commit(); err != nil {
		x.t.Fatal(err)
	}
}

// A place whose landmark stands in a held chunk is discovered in the
// chunk's pinned epoch after the turning: the first find is that epoch's,
// the near read names it with that epoch, and asking under this wick
// finds no such place there (this wick's land isn't served in that chunk).
func TestDiscoverInHeldChunk(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	// Place (1,0): landmark at (82,-14) in chunk (3,-1), find radius 3.
	held := x.near(c, 3, -1, 200).Wick
	x.holdChunk(s.WorldID, 3, -1)
	day := content.CalendarAt(content.CalendarRules, x.now.Load())
	x.now.Store(day.NextTurning + 60)
	c, s = x.again("alice")
	wick := x.near(c, 3, -1, 200).Wick
	if wick.Id == held.Id {
		t.Fatal("the wick didn't turn")
	}
	discover := func(key, epoch string, status int) (*contract.WildsDiscoverResult, string) {
		t.Helper()
		env, code := x.call("/api/wilds/discover", &contract.WildsDiscoverRequest{Op: op(s.Lease, key), Where: tileWhere(82, -12), Place: "place:1:0", Epoch: epoch}, c, status)
		return env.GetWildsDiscover(), code
	}
	if _, code := discover("this-wick", wick.Id, 409); code != "too-far-away" {
		t.Fatalf("found under this wick: %s", code)
	}
	r, _ := discover("held", held.Id, 200)
	if !r.First || r.Epoch != held.Id || r.Discovery.Epoch != held.Id || r.Discovery.EntityId != "place:1:0" {
		t.Fatalf("held find: %+v", r)
	}
	if n := count(t, x.db, "SELECT count(*) FROM discoveries WHERE epoch=? AND entity_id='place:1:0'", held.Id); n != 1 {
		t.Fatalf("%d discoveries under the pinned epoch", n)
	}
	v := x.near(c, 3, -1, 200)
	if len(v.Discoveries) != 1 || v.Discoveries[0].Epoch != held.Id {
		t.Fatalf("near read discoveries: %v", v.Discoveries)
	}
}

// A camp in a chunk held across a turning fights in its pinned epoch: the
// room wakes under that epoch (not closed as ended) and lives until this
// wick's turning; a swing lands; the fall, the claim, its loot and the
// respawn timer all key on the pinned epoch, and the camp can't be claimed
// under this wick.
func TestCampFightInHeldChunk(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	const cx, cy = 2, -1
	held := x.near(c, cx, cy, 200).Wick
	x.holdChunk(s.WorldID, cx, cy)
	day := content.CalendarAt(content.CalendarRules, x.now.Load())
	x.now.Store(day.NextTurning + 60)
	c, s = x.again("alice")
	after := x.near(c, cx, cy, 200)
	wick := after.Wick
	if wick.Id == held.Id {
		t.Fatal("the wick didn't turn")
	}
	var camp *contract.WildsEntity
	for _, e := range x.chunk(c, held.Id, 0, cx, cy, 200).Entities {
		if e.Kind == "camp" {
			camp = e
		}
	}
	if camp == nil {
		t.Fatal("no camp in the held chunk")
	}

	ts := startPresence(t, x, presenceTestConfig())
	var ms atomic.Int64
	ms.Store(x.now.Load() * 1000)
	x.api.presence.clock = func() time.Time { return time.UnixMilli(ms.Load()) }
	a := wsConnect(t, ts, c, s.Lease)
	a.join(fmt.Sprintf("outdoors:%d:%d", cx, cy))
	px, py := float64((cx*24+int(camp.Tx))*16-7), float64((cy*24+int(camp.Ty))*16+16)
	a.send(map[string]any{"type": "pos", "x": px, "y": py, "facing": map[string]any{"x": 1, "y": 0}, "moving": false})
	// Every camp chunk of the 3x3 wakes a room; take the held chunk's.
	var join *wire.FightJoin
	for join == nil || join.RoomKey.Cx != cx || join.RoomKey.Cy != cy {
		join = socketFight(t, a, "fightJoin").GetFightJoin()
		if join.RoomKey.Epoch != wick.Id && join.RoomKey.Epoch != held.Id && join.RoomKey.Epoch != after.Still.Id {
			t.Fatalf("a room in a third epoch: %v", join)
		}
	}
	if join.RoomKey.Epoch != held.Id || join.RoomKey.Cx != cx || join.RoomKey.Cy != cy || len(join.Enemies) != 1 {
		t.Fatalf("room in the held chunk: %v", join)
	}
	x.api.presence.mu.Lock()
	resolved := x.api.presence.fightLocations[fightLocation{world: s.WorldID, realm: content.WildsRules.GetRealm(), cx: cx, cy: cy}]
	x.api.presence.mu.Unlock()
	if resolved.key.Epoch != held.Id || resolved.endsAt != int64(wick.EndsAt.Value*1000) {
		t.Fatalf("the room lives to %d, want this wick's end %d", resolved.endsAt, int64(wick.EndsAt.Value*1000))
	}
	tick, _ := rules.FightTickAt(ms.Load())
	writeFight(t, a, &wire.FightSwing{Kind: wire.FightSwingKind_FIGHT_SWING_KIND_SLASH, X: px, Y: py, Facing: &wire.FightFacing{X: 1}, SwingCounter: 0, SeenTick: tick, Predicted: []*wire.FightTarget{{Room: join.Room, Enemy: 0}}})
	if r := socketFight(t, a, "fightSwingResult").GetFightSwingResult(); len(r.Hits) != 1 || r.Hits[0].RefusedReason != 0 {
		t.Fatalf("a swing in the held chunk: %v", r)
	}

	// The fall, as the room reports it, under the room's key.
	fellAt := x.now.Load()*1000 + 400
	if err := x.api.EnqueueFall(fights.Fall{Key: fights.Key{World: s.WorldID, Realm: content.WildsRules.GetRealm(), CX: cx, CY: cy, Epoch: held.Id}, Camp: camp.Id, Cycle: 0, At: fellAt, Witnesses: []string{x.account("alice")}}); err != nil {
		t.Fatal(err)
	}
	if err := x.api.DrainFalls(context.Background()); err != nil {
		t.Fatal(err)
	}
	if _, code := x.claim(c, s, "this-wick", wick.Id, camp, 0, at(camp, 0), 404); code == "" {
		t.Fatal("claimed under this wick")
	}
	r, _ := x.claim(c, s, "held", held.Id, camp, 0, at(camp, 0), 200)
	if r.GetEntity().GetEpoch() != held.Id || r.GetLoot() == nil {
		t.Fatalf("held camp claim: %v", r)
	}
	if n := count(t, x.db, "SELECT count(*) FROM camp_claims WHERE epoch=? AND entity_id=? AND cycle=0", held.Id, camp.Id); n != 1 {
		t.Fatalf("%d camp claims under the pinned epoch", n)
	}
	if n := count(t, x.db, "SELECT count(*) FROM fight_falls WHERE epoch=? AND entity_id=?", held.Id, camp.Id); n != 1 {
		t.Fatalf("%d falls under the pinned epoch", n)
	}
	respawn := CampRespawnAt(fellAt)
	now := time.Unix(x.now.Load(), 0)
	if w := campWake(t, x.api, s.WorldID, held.Id, camp, now); !w.Fallen || w.RespawnAt != respawn {
		t.Fatalf("the held camp at wake: %+v", w)
	}
	if w := campWake(t, x.api, s.WorldID, held.Id, camp, time.UnixMilli(respawn)); w.Fallen || w.Cycle != 1 {
		t.Fatalf("the held camp's respawn: %+v", w)
	}
}

// A hero who falls in a held chunk after the turning leaves their lantern
// there, under the chunk's pinned epoch: the near read shows it and another
// player can relight it.
func TestFallenLanternInHeldChunk(t *testing.T) {
	x := newRig(t)
	x.hero("alice", "Alice", "")
	c, s := x.ready("alice")
	const cx, cy = -3, 1
	held := x.near(c, cx, cy, 200).Wick
	x.holdChunk(s.WorldID, cx, cy)
	day := content.CalendarAt(content.CalendarRules, x.now.Load())
	x.now.Store(day.NextTurning + 60)
	c, s = x.again("alice")
	x.hero("bob", "Bob", "")
	bc, b := x.member("bob", s.WorldID)
	x.near(bc, cx, cy, 200)
	tx, ty := local(cx, cy, [2]int{3, 14})
	where := atTile(tx, ty)
	env, _ := x.call("/api/fall", &contract.FallRequest{Op: op(s.Lease, "fell"), Where: where}, c, 200)
	fell := env.GetFall()
	if fell.Lantern != "placed" || fell.Epoch != held.Id {
		t.Fatalf("a fall in the held chunk: %v", fell)
	}
	v := x.near(bc, cx, cy, 200)
	if len(v.Lanterns) != 1 || v.Lanterns[0].Id != fell.LanternId {
		t.Fatalf("the near read's lanterns: %v", v.Lanterns)
	}
	x.call("/api/wilds/lantern", &contract.WildsLanternRequest{Op: op(b.Lease, "relight"), Epoch: held.Id, OwnerId: x.account("alice"), LanternId: fell.LanternId, Where: where}, bc, 200)
	if n := count(t, x.db, "SELECT count(*) FROM lanterns WHERE id=? AND epoch=? AND lit_by IS NOT NULL", fell.LanternId, held.Id); n != 1 {
		t.Fatal("the held lantern wasn't relit")
	}
}

// A held chunk's blob still carries its own wick's rumour site, but the
// rumour isn't there (the player state drops it): the find can't be opened
// under this wick or the pinned epoch, and the near read doesn't list a
// claim on it.
func TestNoRumourFindInHeldChunk(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	r := x.rumourState(c)
	if r == nil {
		t.Fatal("no rumour")
	}
	var cx, cy int
	fmt.Sscanf(r.Site, "rumour:%d:%d", &cx, &cy)
	held := x.near(c, cx, cy, 200).Wick
	tx, ty := local(cx, cy, fakegen.Find)
	find := &contract.WildsEntity{Id: r.Site, Kind: "rumour"}
	x.claim(c, s, "open", held.Id, find, 0, tileWhere(tx, ty+1), 200)
	x.holdChunk(s.WorldID, int32(cx), int32(cy))
	if x.rumourState(bc) != nil {
		t.Fatal("a rumour in a held chunk")
	}
	if _, code := x.claim(bc, b, "held", held.Id, find, 0, tileWhere(tx, ty+1), 404); code != "entity-not-found" {
		t.Fatalf("opened in a held chunk: %s", code)
	}
	if v := x.near(c, cx, cy, 200); slices.ContainsFunc(v.PersonalClaims, func(p *contract.WildsPersonalClaim) bool { return p.EntityId == r.Site }) {
		t.Fatal("the near read lists a held chunk's rumour claim")
	}
	x.now.Store(content.CalendarAt(content.CalendarRules, x.now.Load()).NextTurning + 60)
	bc, b = x.again("bob")
	if x.near(bc, cx, cy, 200).Wick.Id == held.Id {
		t.Fatal("the wick didn't turn")
	}
	if _, code := x.claim(bc, b, "pinned", held.Id, find, 0, tileWhere(tx, ty+1), 404); code != "entity-not-found" {
		t.Fatalf("opened under the pinned epoch: %s", code)
	}
}

// A fall in a held chunk in the gap at the turning, before any request has
// made the next wick, still leaves the lantern under the pinned epoch.
func TestFallenLanternInHeldChunkAtTheTurning(t *testing.T) {
	x := newRig(t)
	x.hero("alice", "Alice", "")
	c, s := x.ready("alice")
	const cx, cy = -3, 1
	held := x.near(c, cx, cy, 200).Wick
	x.holdChunk(s.WorldID, cx, cy)
	x.now.Store(int64(held.EndsAt.Value) + 1)
	tx, ty := local(cx, cy, [2]int{3, 14})
	env, _ := x.call("/api/fall", &contract.FallRequest{Op: op(s.Lease, "fell"), Where: atTile(tx, ty)}, c, 200)
	if fell := env.GetFall(); fell.Lantern != "placed" || fell.Epoch != held.Id {
		t.Fatalf("a fall in the held chunk at the turning: %v", fell)
	}
}
