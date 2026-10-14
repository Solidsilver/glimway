package api

import (
	"fmt"
	"slices"
	"testing"

	"glimway/server/internal/chunks"
	"glimway/server/internal/frontier"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"glimway/server/internal/wildsgen"

	"google.golang.org/protobuf/proto"
)

// The open map against generator v3 itself (the production default): the
// whole frontier made on demand through near reads, every stored chunk
// valid and under budget, seams to the Tangle, the rumour and its find, a
// first find, and a path laid and lifted on real ground.
func TestOpenMapWithGeneratorV3(t *testing.T) {
	x := newRig(t)
	x.api.Config.Epochs.(*store.Chunks).Generator = wildsgen.V3{}
	x.api.Config.WildsGenerator = wildsgen.V3{}
	c, s := x.ready("alice")
	gate := x.near(c, 0, 0, 200)
	if gate.Still.GeneratorVersion != 3 || gate.Wick.GeneratorVersion != 3 || len(gate.Entities) == 0 {
		t.Fatal("gate window", gate.Still, len(gate.Entities))
	}
	for _, at := range [][2]int{{-4, -8}, {4, -8}, {-4, 0}, {4, 0}, {2, -1}, {-2, -2}, {0, -6}, {-3, -4}, {3, -4}} {
		x.near(c, at[0], at[1], 200)
	}
	x0, y0, x1, y1 := frontier.Rect("")
	if n := count(t, x.db, "SELECT count(*) FROM wilds_chunks"); n != (x1-x0+1)*(y1-y0+1) {
		t.Fatalf("%d chunks made", n)
	}
	rows, err := x.db.DB.Query("SELECT epoch_id,cx,cy,length(blob),blob FROM wilds_chunks")
	if err != nil {
		t.Fatal(err)
	}
	largest, total := 0, 0
	for rows.Next() {
		var epoch string
		var cx, cy, size int
		var blob []byte
		if err = rows.Scan(&epoch, &cx, &cy, &size, &blob); err != nil {
			t.Fatal(err)
		}
		m := &contract.WorldChunk{}
		if err = proto.Unmarshal(blob, m); err != nil || chunks.Validate(m) != nil || int(m.Cx) != cx || int(m.Cy) != cy {
			t.Fatalf("stored chunk %d,%d: %v %v", cx, cy, err, chunks.Validate(m))
		}
		if want := gate.Wick.Id; wilds.EpochKindAt(cx, cy) == "still" {
			want = gate.Still.Id
			if epoch != want {
				t.Fatalf("chunk %d,%d under the wrong epoch", cx, cy)
			}
		} else if epoch != want {
			t.Fatalf("chunk %d,%d under the wrong epoch", cx, cy)
		}
		largest, total = max(largest, size), total+size
	}
	rows.Close()
	if largest > 6*1024 {
		t.Fatalf("a stored chunk of %d bytes", largest)
	}
	t.Logf("81 stored chunks: %d bytes, the largest %d", total, largest)

	// The rumour: in the state, and its find in the chunk it names.
	r := x.rumourState(c)
	if r == nil || r.Epoch != gate.Wick.Id || r.Ring < 1 || r.Ring > 3 {
		t.Fatal("rumour", r)
	}
	var cx, cy int
	fmt.Sscanf(r.Site, "rumour:%d:%d", &cx, &cy)
	m := x.chunk(c, gate.Wick.Id, 0, cx, cy, 200)
	i := slices.IndexFunc(m.Sites, func(site *contract.StorySite) bool { return site.Id == r.Site })
	if i < 0 || m.Sites[i].Kind != contract.SiteKind_SITE_KIND_RUMOUR {
		t.Fatal("the rumour's find isn't in its chunk", r.Site)
	}
	ftx, fty := cx*24+int(m.Sites[i].Tx), cy*24+int(m.Sites[i].Ty)
	got, _ := x.claim(c, s, "rumour", gate.Wick.Id, &contract.WildsEntity{Id: r.Site}, 0, tileWhere(ftx, fty), 200)
	if got.Entity.Id != r.Site || !x.rumourState(c).Opened {
		t.Fatal("opened", got)
	}

	// First to find: the rumour's own place, from its landmark's tile.
	var px, py int
	fmt.Sscanf(r.Place, "place:%d:%d", &px, &py)
	place, ok := wilds.PlaceAt(wildsgen.Epoch(gate.Wick), px, py)
	if !ok {
		t.Fatal("no place", r.Place)
	}
	lx, ly := place.CX*24+place.TX, place.CY*24+place.TY
	env, _ := x.call("/api/wilds/discover", &contract.WildsDiscoverRequest{Op: op(s.Lease, "find"), Where: tileWhere(lx, ly+1), Place: r.Place, Epoch: gate.Wick.Id}, c, 200)
	if d := env.GetWildsDiscover(); !d.First || d.Discovery.EntityId != r.Place || d.Discovery.PoiId != place.Kind {
		t.Fatal("discover", d)
	}

	// A stone laid and lifted on open land near the gate.
	x.give(s.AccountID, "stone", 1)
	tangle := x.chunk(c, gate.Still.Id, 0, 0, 0, 200)
	e := chunks.NewEffective(tangle, nil)
	lay := [2]int{-1, -1}
	for y := 4; y < 20 && lay[0] < 0; y++ {
		for xx := 4; xx < 20; xx++ {
			if e.Walkable(xx, y) && e.Walkable(xx, y+1) && e.Ground(xx, y).GetSurface() == "land" && len(chunks.DecorKindsAt(tangle, xx, y)) == 0 &&
				!slices.ContainsFunc(tangle.Entities, func(en *contract.WildsEntity) bool { return int(en.Tx) == xx && int(en.Ty) == y }) &&
				!slices.ContainsFunc(tangle.Sites, func(st *contract.StorySite) bool { return int(st.Tx) == xx && int(st.Ty) == y }) {
				lay = [2]int{xx, y}
				break
			}
		}
	}
	if lay[0] < 0 {
		t.Fatal("no open land in the gate's chunk")
	}
	if _, code := x.pathOp(c, s, "lay", "lay", lay[0], lay[1]+1, lay[0], lay[1], "stone", 200); code != "" {
		t.Fatal(code)
	}
	stone := x.packQty(s.AccountID, "stone")
	if env, _ := x.pathOp(c, s, "lift", "lift", lay[0], lay[1]+1, lay[0], lay[1], "", 200); int(env.GetWildsLift().Materials["stone"]) != stone+1 {
		t.Fatal("lift refund")
	}
}
