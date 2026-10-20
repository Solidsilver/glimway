package api

import (
	"encoding/json"
	"net/http"
	"os"
	"reflect"
	"strings"
	"testing"

	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/wilds"
	"google.golang.org/protobuf/encoding/protojson"
)

func (x *rig) mapLand(c *http.Cookie, keys ...[2]int) *contract.WildsMapStatus {
	x.t.Helper()
	out := &contract.WildsMapStatus{}
	if err := protojson.Unmarshal(x.mapRaw(c, keys...), out); err != nil {
		x.t.Fatal(err)
	}
	return out
}

// mapRaw is the map endpoint's answer as it goes over the wire.
func (x *rig) mapRaw(c *http.Cookie, keys ...[2]int) []byte {
	x.t.Helper()
	req := &contract.WildsMapRequest{}
	for _, k := range keys {
		req.Explored = append(req.Explored, chunkKeyProto(k[0], k[1]))
	}
	b, err := protojson.Marshal(req)
	if err != nil {
		x.t.Fatal(err)
	}
	var body map[string]any
	if err = json.Unmarshal(b, &body); err != nil {
		x.t.Fatal(err)
	}
	w := x.rawHTTP("POST", "/api/wilds/map", body, c)
	if w.Code != 200 {
		x.t.Fatalf("map status: %d %s", w.Code, w.Body.String())
	}
	return w.Body.Bytes()
}

func TestMapBuiltPrediction(t *testing.T) {
	for _, tc := range []struct {
		oil           uint32
		dim, released bool
		want          string
	}{
		{3, false, false, "held"}, {1, false, false, "held"}, {0, false, false, "dimming"}, {0, true, false, "turns"}, {1, true, false, "held"}, {2, false, true, "released"},
	} {
		if got := nextBuilt(tc.oil, tc.dim, tc.released); got != tc.want {
			t.Errorf("%+v: %s", tc, got)
		}
	}
}

func TestMapTiersExploredOnlyAndNoVisit(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	ax, ay := local(2, -1, [2]int{3, 14})
	x.give(s.AccountID, "stone", 1)
	x.pathOp(c, s, "lay", "map-path", ax, ay+1, ax, ay, "stone", 200)
	// A new wick carries the path, but nobody has visited it this wick.
	x.turn()
	c, s = x.again("alice")
	still := wilds.Footprint("tangle")
	known := [][2]int{{2, -1}, {3, -1}, {0, 1}, {int(still.GetCx()), int(still.GetCy())}}
	before := count(t, x.db, "SELECT count(*) FROM chunk_visits WHERE world_id=?", s.WorldID)
	chunksBefore := count(t, x.db, "SELECT count(*) FROM wilds_chunks")
	out := x.mapLand(c, known...)
	if count(t, x.db, "SELECT count(*) FROM wilds_chunks") != chunksBefore {
		t.Fatal("map generated terrain")
	}
	if len(out.Chunks) != 4 || len(out.Lamps) != 0 {
		t.Fatal(out)
	}
	want := []string{"common", "wild", "permanent", "still"}
	for i, land := range out.Chunks {
		if land.Tier != want[i] {
			t.Fatalf("tier %d: %v", i, land)
		}
	}
	if out.Chunks[0].Visited || out.Chunks[0].NextTurning != "paths-turn" {
		t.Fatal(out.Chunks[0])
	}
	// A map read does not adopt a visit or materialize terrain.
	if count(t, x.db, "SELECT count(*) FROM chunk_visits WHERE world_id=?", s.WorldID) != before {
		t.Fatal("map credited a visit")
	}
	x.standAt(c, s, ax+10, ay)
	out = x.mapLand(c, [2]int{2, -1})
	if !out.Chunks[0].Visited || out.Chunks[0].NextTurning != "carries" {
		t.Fatal(out)
	}
	if got := x.mapLand(c); len(got.Chunks) != 0 || len(got.Lamps) != 0 {
		t.Fatal("empty exploration revealed land", got)
	}
}

func TestMapOwnLotAndCampVisibility(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.keeper(s.AccountID) // setting a way-lamp takes the Keeper's hand
	x.claimGate(c, &s, 0)
	x.stack(s.AccountID, "hearth-oil", "", 3)
	sx, sy := atStake(0)
	x.lanternOp(c, &s, 0, sx, sy, 200)
	bc, _ := x.member("bob", s.WorldID)
	own := x.mapLand(c)
	if len(own.Chunks) != 0 || len(own.Lamps) != 1 || own.Lamps[0].Kind != lotLanternKind {
		t.Fatal("own mark without backland", own)
	}
	if other := x.mapLand(bc); len(other.Chunks) != 0 || len(other.Lamps) != 0 {
		t.Fatal("unexplored lot leaked", other)
	}
	cx, cy := chunks.BacklandChunk(0)
	lot := x.mapLand(bc, [2]int{cx, cy})
	if len(lot.Lamps) != 1 || lot.Chunks[0].Tier != "built" || lot.Chunks[0].Reserve != 1 || lot.Chunks[0].Epoch == nil {
		t.Fatal(lot)
	}
	lamp := x.carry(s.AccountID, "way-lamp")
	spots := x.campSpots(s.WorldID, campCX, campCY)
	x.campOp(c, s, &contract.CampRequest{Action: "set", ItemId: lamp, X: int32(spots[0][0]), Y: int32(spots[0][1])}, spots[1][0], spots[1][1], 200)
	if out := x.mapLand(bc); len(out.Lamps) != 0 {
		t.Fatal("unexplored camp leaked", out)
	}
	out := x.mapLand(bc, [2]int{campCX, campCY})
	if len(out.Lamps) != 1 || out.Chunks[0].Tier != "built" || out.Lamps[0].Kind != wayLampKind {
		t.Fatal(out)
	}
	// The real holder enters Dimming after its funded and warning turnings.
	x.turn()
	x.mapLand(bc)
	x.turn()
	bc, _ = x.again("bob")
	out = x.mapLand(bc, [2]int{campCX, campCY}, [2]int{cx, cy})
	for _, land := range out.Chunks {
		if land.Tier != "built" || !land.Dimming || land.NextTurning != "turns" || land.Reserve != 0 {
			t.Fatal(land)
		}
	}
	// A fresh near prefetch speaks only for the occupied chunk, never its window.
	n := x.near(bc, campCX, campCY, 200)
	if n.Land != nil && len(n.Land.Chunks) > 1 {
		t.Fatal("near exposed neighbouring tiers", n.Land)
	}
}

// A chunk whose only Common work is a communal lamp, as the map endpoint
// answers it before and after this wick's visit (review B4): the client's
// decoder reads testdata/map-lamps.json (tests/map-lamps.test.ts). The
// lamp's id and the wick are the run's own, so they're written as "post"
// and "wick". UPDATE_PROTO_FIXTURES=1 rewrites it.
func TestMapLampOnlyFixture(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	post := x.carry(s.AccountID, "way-lamp")
	spots := x.campSpots(s.WorldID, campCX, campCY)
	x.lampOp(c, s, &contract.CommunalLampRequest{Action: "post", ItemId: post, X: int32(spots[0][0]), Y: int32(spots[0][1])}, spots[1][0], spots[1][1], 200)
	capture := func(want string) json.RawMessage {
		t.Helper()
		raw := x.mapRaw(c, [2]int{campCX, campCY})
		out := &contract.WildsMapStatus{}
		if err := protojson.Unmarshal(raw, out); err != nil {
			t.Fatal(err)
		}
		if len(out.Chunks) != 1 || out.Chunks[0].Tier != "common" || out.Chunks[0].NextTurning != want || len(out.Lamps) != 1 {
			t.Fatalf("%s: %v", want, out)
		}
		raw = []byte(strings.ReplaceAll(strings.ReplaceAll(string(raw), post, "post"), out.Wick, "wick"))
		var v any
		if err := json.Unmarshal(raw, &v); err != nil {
			t.Fatal(err)
		}
		pretty, _ := json.Marshal(v)
		return pretty
	}
	fixture := map[string]json.RawMessage{"visited": capture("lamps-carry")}
	// The post carries into the next wick; nobody has been by yet.
	x.turn()
	c, _ = x.again("alice")
	fixture["unvisited"] = capture("lamps-turn")
	raw, err := json.MarshalIndent(fixture, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	path := "testdata/map-lamps.json"
	if os.Getenv("UPDATE_PROTO_FIXTURES") == "1" {
		if err = os.WriteFile(path, raw, 0644); err != nil {
			t.Fatal(err)
		}
	}
	want, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var a, b any
	if json.Unmarshal(raw, &a) != nil || json.Unmarshal(want, &b) != nil || !reflect.DeepEqual(a, b) {
		t.Fatalf("%s is stale: UPDATE_PROTO_FIXTURES=1 rewrites it", path)
	}
}
