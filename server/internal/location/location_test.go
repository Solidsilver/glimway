package location

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
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

type vectorPosition struct {
	Source string `json:"source"`
	Kind   string `json:"kind"`
	Area   string `json:"area"`
	Tile   [2]int `json:"tile"`
}

// vectorLookups are the rows every lookup replays: for the shipped places
// at the top level, for the places laid at the schema's bounds in `bounds`.
type vectorLookups struct {
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
	Positions []vectorPosition `json:"positions"`
}

type vectorDoc struct {
	vectorLookups
	Zones struct {
		Zones json.RawMessage `json:"zones"`
		At    []vectorAt      `json:"at"`
	} `json:"zones"`
	Bounds struct {
		vectorLookups
		Fixed []json.RawMessage `json:"fixed"`
	} `json:"bounds"`
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

// withPlaces decodes the shipped places as edited, through the loader, and
// makes them the lookup's places for the rest of the test.
func withPlaces(t *testing.T, edit func(places map[string]any)) {
	t.Helper()
	raw, err := content.FS.ReadFile("places.json")
	if err != nil {
		t.Fatal(err)
	}
	var places map[string]any
	if err := json.Unmarshal(raw, &places); err != nil {
		t.Fatal(err)
	}
	edit(places)
	if raw, err = json.Marshal(places); err != nil {
		t.Fatal(err)
	}
	edited, err := content.DecodePlaces(raw)
	if err != nil {
		t.Fatal(err)
	}
	shipped := content.PlacesRules
	content.PlacesRules = edited
	t.Cleanup(func() { content.PlacesRules = shipped })
}

func decodeAny(t *testing.T, raw json.RawMessage) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

// The shipped Commons has no zones; the vectors lay two over it, through
// the loader, and ask again.
func TestAtZoneVectors(t *testing.T) {
	doc := readVectors(t)
	withPlaces(t, func(places map[string]any) {
		places["fixed"].([]any)[0].(map[string]any)["zones"] = decodeAny(t, doc.Zones.Zones)
	})
	checkAt(t, doc.Zones.At)
}

// Two places at the schema's bounds beside the Commons: every lookup near
// them, worked with big integers, so arithmetic that wraps int32 fails.
func TestBoundsVectors(t *testing.T) {
	doc := readVectors(t)
	withPlaces(t, func(places map[string]any) {
		for _, f := range doc.Bounds.Fixed {
			places["fixed"] = append(places["fixed"].([]any), decodeAny(t, f))
		}
	})
	checkAt(t, doc.Bounds.At)
	checkLookups(t, doc.Bounds.vectorLookups)
}

func TestLookupVectors(t *testing.T) {
	checkLookups(t, readVectors(t).vectorLookups)
}

// checkLookups replays the SourceOf, OnGrid and Anchor rows.
func checkLookups(t *testing.T, doc vectorLookups) {
	t.Helper()
	for _, v := range doc.SourceOf {
		if got := sourceVector(SourceOf(v.Chunk[0], v.Chunk[1])); got != v.Source {
			t.Errorf("SourceOf%v = %+v, want %+v", v.Chunk, got, v.Source)
		}
	}
	for _, v := range doc.OnGrid {
		if got := OnGrid(v.Chunk[0], v.Chunk[1]); got != v.OnGrid {
			t.Errorf("OnGrid%v = %v", v.Chunk, got)
		}
	}
	for _, v := range doc.Anchors {
		space, x, y, ok := Anchor(v.ID)
		if ok != v.OK || string(space) != v.Space || [2]float64{x, y} != v.At {
			t.Errorf("Anchor(%q) = %s %v %v %v, want %+v", v.ID, space, x, y, ok, v)
		}
	}

}

// Positions carry world tiles: a place label only maps to a saved space.
func TestTownPositionsOnTheGrid(t *testing.T) {
	for _, v := range readVectors(t).Positions {
		cx, cy := wilds.ChunkOf(v.Tile[0], v.Tile[1])
		space := ContentSpace(v.Area)
		if space != Outdoors || !OnGrid(cx, cy) || At(space, float64(v.Tile[0]*16+8), float64(v.Tile[1]*16+8)).ID != "hearthwick" {
			t.Errorf("%s is outside Hearthwick", v.Source)
		}
	}
}

func TestLotAnchors(t *testing.T) {
	for g := 0; g < 8; g++ {
		space, x, y, ok := Anchor(fmt.Sprintf("hearthwick:lot:%d", g))
		tx, ty := -23, 35+24*(g/2)
 if g%2==1 {tx=46}
		if !ok || space != Outdoors || x != float64(tx*16+8) || y != float64(ty*16+8) {
			t.Fatalf("lot %d: %s %v,%v", g, space, x, y)
		}
		if id := At(space, x, y).ID; id != "hearthwick" {
			t.Fatalf("lot %d is %s", g, id)
		}
	}
	if content.GateCapacity(fixedByID("hearthwick")) != 8 {
		t.Fatal("town must have eight lot anchors")
	}
}

// townPositions walks the content for world tiles whose place is Hearthwick,
// including inherited area ownership (fishing banks). Both twins compare
// coordinates and source paths, so a stale vector cannot conceal a move.
func townPositions(t *testing.T) map[string][2]int {
	t.Helper()
	out := map[string][2]int{}
	tile := func(v any) bool {
		m, ok := v.(map[string]any)
		if !ok {
			return false
		}
		_, x := m["tx"].(float64)
		_, y := m["ty"].(float64)
		return x && y
	}
	var walk func(path string, v any, inherited bool)
	walk = func(path string, v any, inherited bool) {
		switch v := v.(type) {
		case map[string]any:
			own := inherited
			if _, ok := v["area"]; ok {
				own = v["area"] == "hearthwick"
			}
			if _, ok := v["to"]; ok {
				own = v["to"] == "hearthwick"
			}
			if own && tile(v) {
				out[path] = [2]int{int(v["tx"].(float64)), int(v["ty"].(float64))}
			}
			keys := make([]string, 0, len(v))
			for k := range v {
				keys = append(keys, k)
			}
			sort.Strings(keys)
			for _, k := range keys {
				if tile(v[k]) && (own || k == "hearthwick") {
					m := v[k].(map[string]any)
					out[path+"."+k] = [2]int{int(m["tx"].(float64)), int(m["ty"].(float64))}
					continue
				}
				walk(path+"."+k, v[k], own)
			}
		case []any:
			for i, item := range v {
				name := fmt.Sprint(i)
				if m, ok := item.(map[string]any); ok {
					if id, ok := m["id"].(string); ok && id != "" {
						name = id
					}
				}
				walk(path+"."+name, item, inherited)
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
		walk(strings.TrimSuffix(f, ".json"), doc, false)
	}
	return out
}

func TestEveryTownPositionHasAVector(t *testing.T) {
	remaining := townPositions(t)
	for _, v := range readVectors(t).Positions {
		if strings.HasPrefix(v.Source, "layout.") || strings.Contains(v.Source, ",") {
			continue
		}
		if got, ok := remaining[v.Source]; !ok || got != v.Tile {
			t.Errorf("%s: content %v, vector %v", v.Source, got, v.Tile)
		}
		delete(remaining, v.Source)
	}
	if len(remaining) > 0 {
		t.Fatalf("town positions without vectors: %v", remaining)
	}
}

func TestOnGridIsTheBorderPlusFixedFootprints(t *testing.T) {
	for cy := -12; cy <= 6; cy++ {
		for cx := -8; cx <= 8; cx++ {
			fixed := SourceOf(cx, cy).Kind == SourceFixed
			if fixed && wilds.FootprintAt(cx, cy) != nil {
				t.Errorf("chunk %d,%d is both fixed and a Wilds footprint", cx, cy)
			}
			if got := OnGrid(cx, cy); fixed && !got {
				t.Errorf("fixed chunk %d,%d is off the grid", cx, cy)
			}
		}
	}
}

func TestOnGridStopsAtTheBorder(t *testing.T) {
	b := wilds.BorderChunks()
	for _, c := range [][2]int{{b, b}, {-b, -b}, {b, -b}, {-b, b}, {0, b}, {-b, 0}} {
		if !OnGrid(c[0], c[1]) {
			t.Errorf("chunk %v inside the border is off the grid", c)
		}
	}
	for _, c := range [][2]int{{b + 1, 0}, {0, -b - 1}, {-b - 1, b}, {b, b + 1}} {
		if OnGrid(c[0], c[1]) {
			t.Errorf("chunk %v past the border is on the grid", c)
		}
	}
}
