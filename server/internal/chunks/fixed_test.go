package chunks

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"testing"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"google.golang.org/protobuf/proto"
)

// fixedGolden is every fixed chunk's served bytes per layout revision. A
// layout edit without a revision bump changes bytes some cache already
// keeps under the old pseudo-epoch: bump the revision (layout and
// places.json), then add the new revision's sum here.
var fixedGolden = map[string]string{
	"fixed:commons@3": "46376b02426205021cab08c5a626406b6a85555346e2b2e1a088e5cafb7f89f1", // S5b: the arch is a walk; Elara follows her camp cycle
	"fixed:commons@1": "31bb7cef34f631043f12fb88bee3a523bf875837c9c6d1add88ea5e7f66daf76",
	"fixed:commons@2": "01b51ecf0b5618817193a9be2a6689c2f79780b38ca539046b3d419668caf728", // S3: the arch leads outdoors
}

func commonsPlace(t *testing.T) *content.FixedPlace {
	t.Helper()
	for _, f := range content.PlacesRules.GetFixed() {
		if f.GetId() == "commons" {
			return f
		}
	}
	t.Fatal("no Commons")
	return nil
}

func servedBytes(t *testing.T, c *contract.WorldChunk) []byte {
	t.Helper()
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The fixed chunks' bytes are fixed for a layout revision, and the client's
// copies (tests/fixtures/commons-<cx>-<cy>.bin: tests/commons-fixture.ts
// builds the Commons from them) are these bytes. UPDATE_CLIENT_FIXTURES=1
// writes them.
func TestFixedChunkBytesPerRevision(t *testing.T) {
	f := commonsPlace(t)
	epoch := FixedEpoch(f.GetLayout(), f.GetRevision())
	x0, y0, x1, y1 := content.FixedChunks(f)
	sum := sha256.New()
	dir := filepath.Join("..", "..", "..", "tests", "fixtures")
	for cy := y0; cy <= y1; cy++ {
		for cx := x0; cx <= x1; cx++ {
			c := Fixed(epoch, int32(cx), int32(cy))
			if c == nil {
				t.Fatalf("no fixed chunk %d,%d", cx, cy)
			}
			b := servedBytes(t, c)
			sum.Write(b)
			path := filepath.Join(dir, fmt.Sprintf("commons-%d-%d.bin", cx, cy))
			if os.Getenv("UPDATE_CLIENT_FIXTURES") == "1" {
				if err := os.WriteFile(path, b, 0o644); err != nil {
					t.Fatal(err)
				}
				continue
			}
			have, err := os.ReadFile(path)
			if err != nil {
				t.Fatalf("%s: %v (UPDATE_CLIENT_FIXTURES=1 writes it)", path, err)
			}
			if !bytes.Equal(have, b) {
				t.Fatalf("%s is stale: UPDATE_CLIENT_FIXTURES=1 go test -run TestFixedChunkBytesPerRevision ./server/internal/chunks", path)
			}
		}
	}
	if got := hex.EncodeToString(sum.Sum(nil)); fixedGolden[epoch] != got {
		t.Fatalf("%s served %s, want %s: a layout change bumps its revision", epoch, got, fixedGolden[epoch])
	}
	// Composing again gives the same bytes.
	again, err := ComposeFixed(f, content.Layouts[f.GetLayout()])
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range again {
		if !bytes.Equal(servedBytes(t, c), servedBytes(t, Fixed(epoch, c.Cx, c.Cy))) {
			t.Fatalf("chunk %d,%d composed twice differs", c.Cx, c.Cy)
		}
	}
	// Only the current revision's pseudo-epoch and the footprint's chunks.
	if Fixed(FixedEpoch(f.GetLayout(), f.GetRevision()+1), 0, 1) != nil || Fixed(epoch, int32(x1+1), int32(y0)) != nil || Fixed("fixed:village@1", 0, 1) != nil {
		t.Fatal("a fixed chunk past the layout's revision or footprint")
	}
}

func TestFixedEpochs(t *testing.T) {
	if FixedEpoch("commons", 1) != "fixed:commons@1" {
		t.Fatal(FixedEpoch("commons", 1))
	}
	if l, r, ok := ParseFixedEpoch("fixed:commons@12"); !ok || l != "commons" || r != 12 {
		t.Fatal(l, r, ok)
	}
	for _, bad := range []string{"commons@1", "fixed:commons", "fixed:@1", "fixed:commons@0", "fixed:commons@01", "fixed:commons@-1", "fixed:commons@x", "fixed:commons@99999999999"} {
		if _, _, ok := ParseFixedEpoch(bad); ok {
			t.Fatal(bad)
		}
	}
}

// Validate takes every served fixed chunk and refuses one whose layout,
// revision or place doesn't hold, or that carries generated geometry; a
// generated chunk never takes a fixed pseudo-epoch.
func TestValidateFixedChunks(t *testing.T) {
	f := commonsPlace(t)
	cs, err := ComposeFixed(f, content.Layouts[f.GetLayout()])
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range cs {
		if err := Validate(c); err != nil {
			t.Fatalf("chunk %d,%d: %v", c.Cx, c.Cy, err)
		}
	}
	for name, edit := range map[string]func(c *contract.WorldChunk){
		"unknown layout":     func(c *contract.WorldChunk) { c.EpochId = "fixed:village@1" },
		"another revision":   func(c *contract.WorldChunk) { c.EpochId, c.LayoutRevision = "fixed:commons@1", 1 },
		"revision mismatch":  func(c *contract.WorldChunk) { c.LayoutRevision = 1 },
		"outside the place":  func(c *contract.WorldChunk) { c.Cx = 2 },
		"not a pseudo-epoch": func(c *contract.WorldChunk) { c.EpochId = "still-epoch" },
		"generator version":  func(c *contract.WorldChunk) { c.GeneratorVersion = 3 },
		"generated land":     func(c *contract.WorldChunk) { c.Land = "woods" },
		"decor":              func(c *contract.WorldChunk) { c.Decor = &contract.DecorList{} },
		"an entity": func(c *contract.WorldChunk) {
			c.Entities = []*contract.WildsEntity{{Id: "node:0:1:0", Kind: "node", Material: "timber"}}
		},
		"unknown terrain":   func(c *contract.WorldChunk) { c.Palette[0] = "lava" },
		"palette index":     func(c *contract.WorldChunk) { c.Ground[0] = 0xff },
		"cell packing":      func(c *contract.WorldChunk) { c.Solid = c.Solid[1:] },
		"object kind":       func(c *contract.WorldChunk) { c.Objects[0].Kind = "dragon" },
		"object tile":       func(c *contract.WorldChunk) { c.Objects[0].Tx = 24 },
		"object id twice":   func(c *contract.WorldChunk) { c.Objects[1].Id = c.Objects[0].Id },
		"object without id": func(c *contract.WorldChunk) { c.Objects[0].Id = "" },
	} {
		c := proto.Clone(Fixed(FixedEpoch("commons", 3), 0, 1)).(*contract.WorldChunk)
		edit(c)
		if Validate(c) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	generated := func() *contract.WorldChunk {
		return &contract.WorldChunk{EpochId: "epoch", Realm: "hearthwick", Look: "tangle", Cx: 1, Cy: 0, GeneratorVersion: 3, Size: 24, Tier: 1, Land: "woods", Palette: []string{"grass_b"}, Ground: make([]byte, 288), Solid: make([]byte, 72), Decor: &contract.DecorList{}}
	}
	if err := Validate(generated()); err != nil {
		t.Fatal(err)
	}
	for name, edit := range map[string]func(c *contract.WorldChunk){
		"fixed pseudo-epoch": func(c *contract.WorldChunk) { c.EpochId = "fixed:commons@1" },
		"layout revision":    func(c *contract.WorldChunk) { c.LayoutRevision = 1 },
		"objects":            func(c *contract.WorldChunk) { c.Objects = []*contract.Placed{{Id: "tree:0,0", Kind: "tree"}} },
	} {
		c := generated()
		edit(c)
		if Validate(c) == nil {
			t.Errorf("generated with %s: accepted", name)
		}
	}
}

// served is the Commons as its fixed chunks serve it, in layout tiles:
// what blocks a walker (the solid grid, and the trees, bushes, rocks and
// props, which stand on their tile), the objects by id and the grid's rect.
type served struct {
	x0, y0, w, h int
	solid        map[[2]int]bool
	objects      map[string]*contract.Placed
	at           map[string][2]int
}

func serveCommons(t *testing.T) served {
	t.Helper()
	f := commonsPlace(t)
	S := int(content.WildsRules.GetChunkSize())
	ox, oy := int(f.GetOrigin().GetTx()), int(f.GetOrigin().GetTy())
	x0, y0, x1, y1 := content.FixedChunks(f)
	out := served{x0: x0*S - ox, y0: y0*S - oy, w: (x1 - x0 + 1) * S, h: (y1 - y0 + 1) * S, solid: map[[2]int]bool{}, objects: map[string]*contract.Placed{}, at: map[string][2]int{}}
	for cy := y0; cy <= y1; cy++ {
		for cx := x0; cx <= x1; cx++ {
			c := Fixed(FixedEpoch(f.GetLayout(), f.GetRevision()), int32(cx), int32(cy))
			for i := range S * S {
				if c.Solid[i/8]&(1<<(i%8)) != 0 {
					out.solid[[2]int{cx*S + i%S - ox, cy*S + i/S - oy}] = true
				}
			}
			for _, o := range c.Objects {
				at := [2]int{cx*S + int(o.Tx) - ox, cy*S + int(o.Ty) - oy}
				out.objects[o.Id], out.at[o.Id] = o, at
				switch o.Kind {
				case "tree", "bush", "rock", "prop", "lamp":
					out.solid[at] = true
				}
			}
		}
	}
	return out
}

// reached is every tile a walker reaches from the tile.
func (s served) reached(from [2]int) map[[2]int]bool {
	seen := map[[2]int]bool{from: true}
	q := [][2]int{from}
	for len(q) > 0 {
		p := q[0]
		q = q[1:]
		for _, d := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
			n := [2]int{p[0] + d[0], p[1] + d[1]}
			if n[0] < s.x0 || n[1] < s.y0 || n[0] >= s.x0+s.w || n[1] >= s.y0+s.h || seen[n] || s.solid[n] {
				continue
			}
			seen[n] = true
			q = append(q, n)
		}
	}
	return seen
}

// The location test's stand/target check (location-seam.md 1.2), on the
// served Commons: every anchor, and every content position in Commons
// tiles that stands, is open ground reached from the village path; every
// target borders it. The vectors are content/vectors/location.json's
// resolve rows that name a content position.
func TestServedCommonsStandsAndTargets(t *testing.T) {
	s := serveCommons(t)
	f := commonsPlace(t)
	var west [2]int
	for _, a := range f.GetAnchors() {
		if a.GetId() == "west-path" {
			west = [2]int{int(a.GetTx()), int(a.GetTy())}
		}
	}
	reached := s.reached(west)
	for _, a := range f.GetAnchors() {
		if at := [2]int{int(a.GetTx()), int(a.GetTy())}; !reached[at] {
			t.Errorf("anchor %s %v is not open ground reached from the village path", a.GetId(), at)
		}
	}
	raw, err := os.ReadFile("../../../content/vectors/location.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct {
		Resolve []struct {
			Source, Kind, Area string
			Tile               [2]int
		}
	}
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	n := 0
	for _, v := range doc.Resolve {
		if v.Source == "" || v.Area != "commons" {
			continue
		}
		n++
		switch v.Kind {
		case "stand":
			if !reached[v.Tile] {
				t.Errorf("%s %v is not open ground reached from the village path", v.Source, v.Tile)
			}
		case "target":
			beside := false
			for _, d := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
				beside = beside || reached[[2]int{v.Tile[0] + d[0], v.Tile[1] + d[1]}]
			}
			if !beside {
				t.Errorf("%s %v has no open ground beside it", v.Source, v.Tile)
			}
		default:
			t.Errorf("%s: kind %q", v.Source, v.Kind)
		}
	}
	if n == 0 {
		t.Fatal("no content positions in Commons tiles")
	}
}

// The served Commons keeps the seam's rules (location-seam.md 2, 3): its
// north edge is solid except over the Tangle's gate (world x 1..3); its
// footprint's margins are the verge, all standing wood; each gate in the
// fence leads to its home, its lane tile the gate's anchor; and the arch
// and the village gate are the only other ways out.
func TestServedCommonsEdgesAndGates(t *testing.T) {
	s := serveCommons(t)
	f := commonsPlace(t)
	ox := int(f.GetOrigin().GetTx())
	var open []int
	for x := s.x0; x < s.x0+s.w; x++ {
		if !s.solid[[2]int{x, s.y0}] {
			open = append(open, x+ox)
		}
	}
	if fmt.Sprint(open) != "[1 2 3]" {
		t.Fatalf("the north edge is open at world x %v, want the Tangle gate's 1..3", open)
	}
	// The old map's rect: what the verge surrounds.
	const W, H = 62, 42
	for y := s.y0; y < s.y0+s.h; y++ {
		for x := s.x0; x < s.x0+s.w; x++ {
			if (x < 0 || y < 0 || x >= W || y >= H) && !s.solid[[2]int{x, y}] {
				t.Fatalf("verge tile %d,%d is open", x, y)
			}
		}
	}
	exits := map[string]string{}
	for id, o := range s.objects {
		if o.Exit != nil {
			exits[id] = o.Exit.To
		}
	}
	gates := content.GateCapacity(f)
	if len(exits) != gates+1 || exits["exit:village"] != "village" {
		t.Fatalf("ways out: %v", exits)
	}
	for g := range gates {
		id := fmt.Sprintf("gate:%d", g)
		o := s.objects[id]
		if o == nil || o.Gate != uint32(g) || exits[id] != fmt.Sprintf("home:%d", g) || s.objects[fmt.Sprintf("sign:%d", g)] == nil || s.objects[fmt.Sprintf("shelf:%d", g)] == nil {
			t.Fatalf("gate %d: %v", g, o)
		}
		lane := s.at[id]
		if o.Side == "west" {
			lane[0]++
		} else {
			lane[0]--
		}
		space, x, y, ok := location.Anchor("commons:" + id)
		if !ok || space != location.Outdoors || [2]int{int(math.Floor(x/16)) - ox, int(math.Floor(y/16)) - int(f.GetOrigin().GetTy())} != lane {
			t.Fatalf("gate %d's anchor %v,%v is not its lane tile %v", g, x, y, lane)
		}
	}
}
