package location

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"slices"
	"sort"
	"strings"
	"testing"

	"glimway/content"
	"glimway/server/internal/wilds"
)

type vectorSource struct {
	Kind      string `json:"kind"`
	Layout    string `json:"layout"`
	Revision  int32  `json:"revision"`
	EpochKind string `json:"epochKind"`
}

type vectorPlace struct {
	ID     string       `json:"id"`
	Safe   bool         `json:"safe"`
	Ride   bool         `json:"ride"`
	Sync   bool         `json:"sync"`
	Rest   string       `json:"rest"`
	Source vectorSource `json:"source"`
}

type vectorResolve struct {
	Source string `json:"source"`
	Kind   string `json:"kind"`
	Area   string `json:"area"`
	Tile   [2]int `json:"tile"`
	Space  string `json:"space"`
	At     [2]int `json:"at"`
}

type vectorDoc struct {
	At       []vectorAt `json:"at"`
	SourceOf []struct {
		Chunk  [2]int       `json:"chunk"`
		Source vectorSource `json:"source"`
	} `json:"sourceOf"`
	OnGrid []struct {
		Chunk  [2]int `json:"chunk"`
		OnGrid bool   `json:"onGrid"`
	} `json:"onGrid"`
	Anchors []struct {
		ID    string     `json:"id"`
		OK    bool       `json:"ok"`
		Space string     `json:"space"`
		At    [2]float64 `json:"at"`
	} `json:"anchors"`
	Resolve []vectorResolve `json:"resolve"`
	Zones   struct {
		Zones json.RawMessage `json:"zones"`
		At    []vectorAt      `json:"at"`
	} `json:"zones"`
}

type vectorAt struct {
	Name  string      `json:"name"`
	Space string      `json:"space"`
	X     float64     `json:"x"`
	Y     float64     `json:"y"`
	Place vectorPlace `json:"place"`
}

func readVectors(t *testing.T) vectorDoc {
	t.Helper()
	raw, err := os.ReadFile("../../../content/vectors/location.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc vectorDoc
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	return doc
}

func sourceVector(s Source) vectorSource {
	return vectorSource{Kind: s.Kind.String(), Layout: s.Layout, Revision: s.Revision, EpochKind: s.EpochKind}
}

func checkAt(t *testing.T, vectors []vectorAt) {
	t.Helper()
	for _, v := range vectors {
		p := At(Space(v.Space), v.X, v.Y)
		got := vectorPlace{ID: p.ID, Safe: p.Safe, Ride: p.Ride, Sync: p.Sync, Rest: string(p.Rest), Source: sourceVector(p.Source)}
		if got != v.Place {
			t.Errorf("%s: At(%s, %v, %v) = %+v, want %+v", v.Name, v.Space, v.X, v.Y, got, v.Place)
		}
	}
}

func TestAtVectors(t *testing.T) {
	checkAt(t, readVectors(t).At)
}

// The shipped Commons has no zones; the vectors lay two over it, through
// the loader, and ask again.
func TestAtZoneVectors(t *testing.T) {
	doc := readVectors(t)
	raw, err := content.FS.ReadFile("places.json")
	if err != nil {
		t.Fatal(err)
	}
	var places map[string]any
	if err := json.Unmarshal(raw, &places); err != nil {
		t.Fatal(err)
	}
	var zones any
	if err := json.Unmarshal(doc.Zones.Zones, &zones); err != nil {
		t.Fatal(err)
	}
	places["fixed"].([]any)[0].(map[string]any)["zones"] = zones
	if raw, err = json.Marshal(places); err != nil {
		t.Fatal(err)
	}
	zoned, err := content.DecodePlaces(raw)
	if err != nil {
		t.Fatal(err)
	}
	shipped := content.PlacesRules
	content.PlacesRules = zoned
	t.Cleanup(func() { content.PlacesRules = shipped })
	checkAt(t, doc.Zones.At)
}

func TestSourceAndGridVectors(t *testing.T) {
	doc := readVectors(t)
	for _, v := range doc.SourceOf {
		if got := sourceVector(SourceOf(v.Chunk[0], v.Chunk[1])); got != v.Source {
			t.Errorf("SourceOf%v = %+v, want %+v", v.Chunk, got, v.Source)
		}
	}
	for _, v := range doc.OnGrid {
		if got := OnGrid("w", v.Chunk[0], v.Chunk[1]); got != v.OnGrid {
			t.Errorf("OnGrid%v = %v", v.Chunk, got)
		}
	}
}

func TestAnchorVectors(t *testing.T) {
	for _, v := range readVectors(t).Anchors {
		space, x, y, ok := Anchor(v.ID)
		if ok != v.OK || string(space) != v.Space || [2]float64{x, y} != v.At {
			t.Errorf("Anchor(%q) = %s %v %v %v, want %+v", v.ID, space, x, y, ok, v)
		}
	}
}

func TestResolveVectors(t *testing.T) {
	for _, v := range readVectors(t).Resolve {
		space, tx, ty := Resolve(v.Area, v.Tile[0], v.Tile[1])
		if string(space) != v.Space || [2]int{tx, ty} != v.At {
			t.Errorf("Resolve(%s, %v) = %s %d %d, want %s %v", v.Area, v.Tile, space, tx, ty, v.Space, v.At)
		}
	}
}

// Every anchor and every content position in Commons tiles lands on the
// grid in the Commons (the stand/target check against the Commons' solid
// ground is the node test's, which can build today's Commons; the served
// layout brings it to Go).
func TestCommonsPositionsOnTheGrid(t *testing.T) {
	check := func(what string, space Space, px, py float64) {
		t.Helper()
		tx, ty := wilds.TileOfPixel(px, py)
		cx, cy := wilds.ChunkOf(tx, ty)
		if space != Outdoors || !OnGrid("w", cx, cy) || At(space, px, py).ID != "commons" {
			t.Errorf("%s: %s tile %d,%d is off the grid or out of the Commons", what, space, tx, ty)
		}
	}
	for _, f := range content.PlacesRules.GetFixed() {
		for _, a := range f.GetAnchors() {
			id := f.GetId() + ":" + a.GetId()
			space, x, y, ok := Anchor(id)
			if !ok {
				t.Fatalf("anchor %s does not resolve", id)
			}
			check(id, space, x, y)
		}
	}
	for _, v := range readVectors(t).Resolve {
		if v.Source == "" {
			continue
		}
		space, tx, ty := Resolve(v.Area, v.Tile[0], v.Tile[1])
		check(v.Source, space, float64(tx*16+8), float64(ty*16+8))
	}
}

// The gate anchors are the lane tiles beside the homestead gates
// (content/homestead.json "commons"), one for each gate the frozen Commons
// holds: gate:0 up to the capacity, no gaps.
func TestGateAnchorsFollowTheLane(t *testing.T) {
	lane := content.HomeRules.GetCommons()
	commons := fixedByID("commons")
	gates := 0
	for _, a := range commons.GetAnchors() {
		if strings.HasPrefix(a.GetId(), "gate:") {
			gates++
		}
	}
	if gates < int(lane.GetSpareGates()) {
		t.Fatalf("%d gate anchors, fewer than the %d spare gates", gates, lane.GetSpareGates())
	}
	rows := lane.GetGateRows()
	for g := range gates {
		row, last := g/2, len(rows)-1
		ty := int(rows[min(row, last)])
		if row > last {
			ty += (row - last) * int(lane.GetRowPitch())
		}
		tx := int(lane.GetFenceX()[g%2]) + 1
		if g%2 == 1 {
			tx = int(lane.GetFenceX()[1]) - 1
		}
		i := slices.IndexFunc(commons.GetAnchors(), func(a *content.PlaceAnchor) bool { return a.GetId() == fmt.Sprintf("gate:%d", g) })
		if i < 0 {
			t.Fatalf("no anchor gate:%d", g)
		}
		if a := commons.GetAnchors()[i]; int(a.GetTx()) != tx || int(a.GetTy()) != ty {
			t.Errorf("gate:%d at %d,%d, want the lane tile %d,%d", g, a.GetTx(), a.GetTy(), tx, ty)
		}
	}
}

// commonsPositions walks the content files for positions in Commons tiles:
// an object whose `area` (or a door's `to`) is "commons" holding tx/ty
// itself or in a child object, and a {tx, ty} object keyed "commons" (the
// story's boards). Paths name list entries by id: the walk is the node
// test's, word for word, so both refuse the same missing vector.
func commonsPositions(t *testing.T) []string {
	t.Helper()
	var out []string
	tile := func(v any) bool {
		m, ok := v.(map[string]any)
		if !ok {
			return false
		}
		_, x := m["tx"].(float64)
		_, y := m["ty"].(float64)
		return x && y
	}
	var walk func(path string, v any)
	walk = func(path string, v any) {
		switch v := v.(type) {
		case map[string]any:
			own := v["area"] == "commons" || v["to"] == "commons"
			if own && tile(v) {
				out = append(out, path)
			}
			keys := make([]string, 0, len(v))
			for k := range v {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if tile(v[k]) && (own || k == "commons") {
					out = append(out, path+"."+k)
					continue
				}
				walk(path+"."+k, v[k])
			}
		case []any:
			for i, item := range v {
				name := fmt.Sprint(i)
				if m, ok := item.(map[string]any); ok {
					if id, ok := m["id"].(string); ok && id != "" {
						name = id
					}
				}
				walk(path+"."+name, item)
			}
		}
	}
	files, err := fs.Glob(content.FS, "*.json")
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range files {
		if f == "places.json" {
			continue
		}
		raw, err := content.FS.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var doc any
		if err := json.Unmarshal(raw, &doc); err != nil {
			t.Fatal(err)
		}
		walk(strings.TrimSuffix(f, ".json"), doc)
	}
	sort.Strings(out)
	return out
}

func TestEveryCommonsPositionHasAVector(t *testing.T) {
	var vectors []string
	for _, v := range readVectors(t).Resolve {
		if v.Source != "" {
			vectors = append(vectors, v.Source)
		}
	}
	sort.Strings(vectors)
	if got := commonsPositions(t); !slices.Equal(got, vectors) {
		t.Fatalf("content positions in Commons tiles %v, vectors %v", got, vectors)
	}
}

func TestOnGridIsTheFrontierPlusFixedFootprints(t *testing.T) {
	for cy := -12; cy <= 6; cy++ {
		for cx := -8; cx <= 8; cx++ {
			fixed := SourceOf(cx, cy).Kind == SourceFixed
			if fixed && wilds.FootprintAt(cx, cy) != nil {
				t.Errorf("chunk %d,%d is both fixed and a Wilds footprint", cx, cy)
			}
			if got := OnGrid("w", cx, cy); fixed && !got {
				t.Errorf("fixed chunk %d,%d is off the grid", cx, cy)
			}
		}
	}
}
