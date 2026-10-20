package api

import (
	"context"
	"database/sql"
	"net/http"
	"testing"

	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/chunks/fakegen"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

// groundIn is a near read's changes for one chunk, or nil.
func groundIn(n *contract.WildsNearResult, cx, cy int) *contract.ChunkGroundChanges {
	for _, g := range n.Ground {
		if int(g.Chunk.Cx) == cx && int(g.Chunk.Cy) == cy {
			return g
		}
	}
	return nil
}

// standAt reports the player standing on a Wilds tile (the sync's place).
func (x *rig) standAt(c *http.Cookie, s response, tx, ty int) response {
	x.t.Helper()
	w := atTile(tx, ty)
	return x.reportState(c, s, 0, 0, map[string]any{"area": w.Area, "x": w.X, "y": w.Y})
}

func (x *rig) visits(world string, cx, cy int) int {
	x.t.Helper()
	return count(x.t, x.db, "SELECT count(*) FROM chunk_visits WHERE world_id=? AND cx=? AND cy=? AND wick_start=?", world, cx, cy, store.WickStart(x.now.Load()))
}

// One visit anywhere in a chunk keeps every Common section in it through
// the turning; a branch in a chunk nobody stood in turns, each tile's stone
// crated at Pell's for whoever laid it, once. Near reads (a prefetch, the map) never
// count as a visit.
func TestCommonOneVisitKeepsUnvisitedBranchCrates(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	x.give(s.AccountID, "stone", 3)
	x.give(b.AccountID, "stone", 1)
	ax, ay := local(2, -1, [2]int{3, 14})
	bx, by := local(3, -1, [2]int{3, 14})
	x.pathOp(c, s, "lay", "trunk", ax, ay+1, ax, ay, "stone", 200)
	x.pathOp(c, s, "lay", "trunk-far", ax+15, ay+1, ax+15, ay, "stone", 200)
	x.pathOp(c, s, "lay", "branch-a", bx, by+1, bx, by, "stone", 200)
	x.pathOp(bc, b, "lay", "branch-b", bx+1, by+1, bx+1, by, "stone", 200)

	// Laying there was standing there: both chunks carry.
	x.turn()
	c, s = x.again("alice")
	n := x.near(c, 2, -1, 200)
	if g := groundIn(n, 2, -1); g == nil || g.Epoch != n.Wick.Id || len(g.Changes.Changes) != 2 {
		t.Fatal("trunk after one turning", g)
	}
	if g := groundIn(n, 3, -1); g == nil || len(g.Changes.Changes) != 2 || groundAt(g, 4, 14).GetBy() != b.AccountID {
		t.Fatal("branch after one turning", g)
	}
	if x.packQty(s.AccountID, "stone") != 0 || x.packQty(b.AccountID, "stone") != 0 || x.crated(s.AccountID, "stone") != 0 {
		t.Fatal("a carried path went to Pell's")
	}

	// This wick only Bob comes by, to a corner of the trunk's chunk.
	x.near(c, 3, -1, 200)
	if x.visits(s.WorldID, 3, -1) != 0 || x.visits(s.WorldID, 2, -1) != 0 {
		t.Fatal("a near read counted as a visit")
	}
	bc, b = x.again("bob")
	cornerX, cornerY := local(2, -1, [2]int{20, 3})
	x.standAt(bc, b, cornerX, cornerY)
	if x.visits(s.WorldID, 2, -1) != 1 || x.visits(s.WorldID, 3, -1) != 0 {
		t.Fatal("the stand's visit")
	}
	x.standAt(bc, b, cornerX+1, cornerY)
	if x.visits(s.WorldID, 2, -1) != 1 {
		t.Fatal("a second step wrote again")
	}

	x.turn()
	c, s = x.again("alice")
	n = x.near(c, 2, -1, 200)
	if g := groundIn(n, 2, -1); g == nil || len(g.Changes.Changes) != 2 {
		t.Fatal("the visited trunk turned", g)
	}
	if g := groundIn(n, 3, -1); g != nil {
		t.Fatal("the unvisited branch stayed", g)
	}
	// The branch's stone waits at Pell's, one crate for the chunk, an entry each.
	if x.packQty(s.AccountID, "stone") != 0 || x.crated(s.AccountID, "stone") != 1 || x.crated(b.AccountID, "stone") != 1 {
		t.Fatal("branch crate", x.crated(s.AccountID, "stone"), x.crated(b.AccountID, "stone"))
	}
	if n := count(t, x.db, "SELECT count(*) FROM recovery_crates WHERE source='common:3:-1' AND cx=3 AND cy=-1"); n != 1 {
		t.Fatalf("%d crates, want 1", n)
	}
	// Reading on crates nothing more; collecting at Pell's gives it once.
	x.near(c, 3, -1, 200)
	if x.crated(s.AccountID, "stone") != 1 {
		t.Fatal("crated twice")
	}
	x.collect(c, s, "collect", true, 200)
	x.collect(c, s, "collect-again", true, 200)
	if x.packQty(s.AccountID, "stone") != 1 || x.crated(s.AccountID, "stone") != 0 {
		t.Fatal("collected", x.packQty(s.AccountID, "stone"))
	}
}

// crated is what waits for the account at Pell's of one item, uncollected.
func (x *rig) crated(account, def string) int {
	x.t.Helper()
	return count(x.t, x.db, "SELECT coalesce(sum(qty),0) FROM recovery_entries WHERE account_id=? AND item_def=? AND collected_at IS NULL", account, def)
}

// Laying across a seam visits the chunk it lays in, not only the one
// the layer stands in.
func TestCommonLayAcrossSeamVisitsTarget(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.give(s.AccountID, "stone", 1)
	sx, sy := local(1, -1, [2]int{23, 14})
	x.pathOp(c, s, "lay", "seam", sx, sy, sx+1, sy, "stone", 200)
	if x.visits(s.WorldID, 2, -1) != 1 {
		t.Fatal("the target chunk wasn't visited")
	}
}

// lapsing is a holder whose holds go at every turning.
type lapsing struct{}

func (lapsing) Keeps(context.Context, *sql.Tx, store.Hold, int64) (bool, error) { return false, nil }
func (lapsing) Released(context.Context, *sql.Tx, store.Hold, int64) error       { return nil }

// Held land keeps its own paths, never carried twice nor crated; a hold
// that lapses turns its land, and its paths go to Pell's for their layers even
// though the chunk was visited (Built work is never kept as Common).
func TestCommonHeldLandNotDoubleHandled(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.give(s.AccountID, "stone", 2)
	held := x.api.Config.Chunks.(*store.Chunks)
	held.Holders["test-lapse"] = lapsing{}
	x.near(c, 2, -1, 200)
	x.holdChunk(s.WorldID, 2, -1)
	dbtx, err := x.db.DB.BeginTx(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = held.Hold(context.Background(), dbtx, s.WorldID, 3, -1, "test-lapse", "0", x.now.Load()); err != nil {
		t.Fatal(err)
	}
	if err = dbtx.Commit(); err != nil {
		t.Fatal(err)
	}
	ax, ay := local(2, -1, [2]int{3, 14})
	bx, by := local(3, -1, [2]int{3, 14})
	x.pathOp(c, s, "lay", "held", ax, ay+1, ax, ay, "stone", 200)
	x.pathOp(c, s, "lay", "lapsing", bx, by+1, bx, by, "stone", 200)
	for i := 0; i < 2; i++ {
		x.turn()
		c, s = x.again("alice")
		x.near(c, 2, -1, 200)
	}
	if n := count(t, x.db, "SELECT count(*) FROM world_changes WHERE chunk='2:-1' AND kind='ground'"); n != 1 {
		t.Fatalf("%d ground rows for the held chunk, want 1", n)
	}
	if n := count(t, x.db, "SELECT count(*) FROM world_changes WHERE chunk='3:-1' AND kind='ground'"); n != 0 {
		t.Fatalf("%d ground rows for the lapsed chunk", n)
	}
	if got := x.crated(s.AccountID, "stone"); got != 1 || x.packQty(s.AccountID, "stone") != 0 {
		t.Fatalf("stone %d: the lapsed tile is crated once, the held one never", got)
	}
}

// A carried tile clears the new wick's detail under it (a thicket grown
// back is walkable through the path); one that would lie on water or under
// a new entity waits at Pell's instead.
func TestCommonOverlayOnChangedDetail(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.give(s.AccountID, "stone", 3)
	x.instance(s.AccountID, "bench-spade", -1, "")
	first := x.near(c, 2, -1, 200).Wick.Id
	thx, thy := local(2, -1, fakegen.Thicket)
	ax, ay := local(2, -1, [2]int{3, 14})
	x.pathOp(c, s, "clear", "clear", thx, thy+1, thx, thy, "", 200)
	x.pathOp(c, s, "lay", "thicket", thx, thy+1, thx, thy, "stone", 200)
	x.pathOp(c, s, "lay", "entity", ax, ay+1, ax, ay, "stone", 200)
	x.pathOp(c, s, "lay", "water", ax+1, ay+1, ax+1, ay, "stone", 200)
	x.gen.Edit = func(e *contract.WildsEpoch, m *contract.WorldChunk) {
		if e.Id == first || m.Cx != 2 || m.Cy != -1 {
			return
		}
		m.Entities = append(m.Entities, &contract.WildsEntity{Id: "poi:2:-1:9", Kind: "poi", Tx: 3, Ty: 14, Poi: content.WildsRules.PoiIds[0]})
		i := 14*int(m.Size) + 4
		m.Ground[i/2] = m.Ground[i/2]&^(15<<(4*(i%2))) | 1<<(4*(i%2))
		m.Solid[i/8] |= 1 << (i % 8)
	}
	x.turn()
	c, s = x.again("alice")
	n := x.near(c, 2, -1, 200)
	g := groundIn(n, 2, -1)
	if g == nil || len(g.Changes.Changes) != 1 || groundAt(g, fakegen.Thicket[0], fakegen.Thicket[1]).GetChange() != "stone" {
		t.Fatal("carried", g)
	}
	m := x.chunk(c, n.Wick.Id, 0, 2, -1, 200)
	eff := chunks.NewEffective(m, g.Changes)
	if !eff.BaseSolid(fakegen.Thicket[0], fakegen.Thicket[1]) || !eff.Walkable(fakegen.Thicket[0], fakegen.Thicket[1]) {
		t.Fatal("the path doesn't clear the thicket grown back under it")
	}
	if got := x.crated(s.AccountID, "stone"); got != 2 {
		t.Fatalf("stone %d: the tiles on the entity and the water wait at Pell's", got)
	}
}

// A turning the server missed is judged in order: a wick nobody stood in
// (the server down, or nobody came) turns the chunk's paths, whatever came
// after; a visit in every missed wick keeps them.
func TestCommonMissedTurningsReplay(t *testing.T) {
	for _, visitedGap := range []bool{false, true} {
		x := newRig(t)
		c, s := x.ready("alice")
		x.give(s.AccountID, "stone", 1)
		ax, ay := local(2, -1, [2]int{3, 14})
		x.pathOp(c, s, "lay", "lay", ax, ay+1, ax, ay, "stone", 200)
		gap := content.CalendarAt(content.CalendarRules, x.now.Load()).NextTurning + 60
		if visitedGap {
			// Someone stayed connected through the first missed wick.
			dbtx, err := x.db.DB.BeginTx(context.Background(), nil)
			if err != nil {
				t.Fatal(err)
			}
			if err = store.Visit(context.Background(), dbtx, s.WorldID, 2, -1, gap); err != nil {
				t.Fatal(err)
			}
			if err = dbtx.Commit(); err != nil {
				t.Fatal(err)
			}
		}
		x.now.Store(content.CalendarAt(content.CalendarRules, gap).NextTurning + 60)
		c, s = x.again("alice")
		n := x.near(c, 2, -1, 200)
		g := groundIn(n, 2, -1)
		if visitedGap != (g != nil) || x.crated(s.AccountID, "stone") != map[bool]int{false: 1, true: 0}[visitedGap] {
			t.Fatalf("visited gap %v: ground %v, crated %d", visitedGap, g, x.crated(s.AccountID, "stone"))
		}
	}
}

// The presence socket credits only the chunk of its own room the accepted
// position stands in, once a wick: never a neighbour's room it sees, nor a
// position waiting on a join.
func TestCommonPresenceVisits(t *testing.T) {
	x := newRig(t)
	_, s := x.ready("alice")
	px, py := local(2, -1, [2]int{8, 8})
	p := x.peerAt(s.AccountID, s.WorldID, "outdoors:2:-1")
	at := func(tx, ty int) { p.pos = &presencePosition{X: float64(tx*16 + 8), Y: float64(ty*16 + 8)} }
	at(px, py)
	if cx, cy, ok := peerVisit(p); !ok || cx != 2 || cy != -1 {
		t.Fatal("own room", cx, cy, ok)
	}
	at(px+24, py)
	if _, _, ok := peerVisit(p); ok {
		t.Fatal("a position outside its room counted")
	}
	at(px, py)
	p.pendingJoin = "outdoors:3:-1"
	if _, _, ok := peerVisit(p); ok {
		t.Fatal("a position waiting on a join counted")
	}
	p.pendingJoin, p.area = "", "village"
	if _, _, ok := peerVisit(p); ok {
		t.Fatal("a town room counted")
	}
	x.api.presenceVisit(s.WorldID, 2, -1)
	x.api.visits.writes.Wait()
	if x.visits(s.WorldID, 2, -1) != 1 {
		t.Fatal("no visit written")
	}
	if _, err := x.db.DB.Exec("DELETE FROM chunk_visits"); err != nil {
		t.Fatal(err)
	}
	x.api.presenceVisit(s.WorldID, 2, -1)
	x.api.visits.writes.Wait()
	if x.visits(s.WorldID, 2, -1) != 0 {
		t.Fatal("a cached visit wrote again")
	}
	// Still standing there as the wick turns: the new wick's visit.
	x.turn()
	x.api.presenceVisit(s.WorldID, 2, -1)
	x.api.visits.writes.Wait()
	if x.visits(s.WorldID, 2, -1) != 1 {
		t.Fatal("no visit in the new wick")
	}
}
