package chunks

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"google.golang.org/protobuf/proto"
)

// Hashes pin served bytes to their cache identity. A shipped layout edit
// must bump the revision and add a new hash, never rewrite an old revision.
var fixedGolden = map[string]string{
	"fixed:hearthwick@2": "60bd2eb96368c8919e2c19ca316837002b0a2e36e86e62f655af1c2a3c2ae948",
	"fixed:lots-west@3":  "81d082706f907be232a6766ed152d8c34dc2dcf01bd7abe3292c5035de0274d9",
	"fixed:lots-east@3":  "2dbad2eaf657928d11a497e7332f749e8e983856408ae54f9abca898bf64ee1a",
}

func servedBytes(t *testing.T, c *contract.WorldChunk) []byte {
	t.Helper()
	b, err := proto.MarshalOptions{Deterministic: true}.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	return b
}
func TestFixedChunkBytesPerRevision(t *testing.T) {
	for _, f := range content.PlacesRules.GetFixed() {
		epoch := FixedEpoch(f.GetLayout(), f.GetRevision())
		sum := sha256.New()
		cs, err := ComposeFixed(f, content.Layouts[f.GetLayout()])
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range cs {
			b := servedBytes(t, c)
			sum.Write(b)
			path := filepath.Join("../../../tests/fixtures", fmt.Sprintf("%s-%d-%d.bin", f.GetId(), c.Cx, c.Cy))
			if os.Getenv("UPDATE_CLIENT_FIXTURES") == "1" {
				if err := os.WriteFile(path, b, 0644); err != nil {
					t.Fatal(err)
				}
			} else {
				have, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(have, b) {
					t.Fatalf("stale fixture %s: %v; UPDATE_CLIENT_FIXTURES=1 updates it", path, err)
				}
			}
			if !bytes.Equal(b, servedBytes(t, Fixed(epoch, c.Cx, c.Cy))) {
				t.Fatal("recomposition differs")
			}
			if err := Validate(c); err != nil {
				t.Fatalf("%s: %v", path, err)
			}
		}
		if got := hex.EncodeToString(sum.Sum(nil)); fixedGolden[epoch] != got {
			t.Errorf("%s hash %s, want %s", epoch, got, fixedGolden[epoch])
		}
		if Fixed(FixedEpoch(f.GetLayout(), f.GetRevision()+1), f.GetCx(), f.GetCy()) != nil {
			t.Fatal("another revision served")
		}
	}
}
func TestFixedEpochs(t *testing.T) {
	if FixedEpoch("hearthwick", 2) != "fixed:hearthwick@2" {
		t.Fatal("epoch")
	}
	if l, r, ok := ParseFixedEpoch("fixed:hearthwick@12"); !ok || l != "hearthwick" || r != 12 {
		t.Fatal(l, r, ok)
	}
	for _, bad := range []string{"hearthwick@1", "fixed:hearthwick", "fixed:@1", "fixed:hearthwick@0", "fixed:hearthwick@01", "fixed:hearthwick@-1", "fixed:hearthwick@x", "fixed:hearthwick@99999999999"} {
		if _, _, ok := ParseFixedEpoch(bad); ok {
			t.Fatal(bad)
		}
	}
}
func TestValidateFixedChunks(t *testing.T) {
	for name, edit := range map[string]func(*contract.WorldChunk){
		"unknown layout":     func(c *contract.WorldChunk) { c.EpochId = "fixed:missing@1" },
		"another revision":   func(c *contract.WorldChunk) { c.EpochId = "fixed:hearthwick@3"; c.LayoutRevision = 3 },
		"revision mismatch":  func(c *contract.WorldChunk) { c.LayoutRevision = 3 },
		"outside place":      func(c *contract.WorldChunk) { c.Cx = 2 },
		"not fixed epoch":    func(c *contract.WorldChunk) { c.EpochId = "still-epoch" },
		"generator":          func(c *contract.WorldChunk) { c.GeneratorVersion = 3 },
		"generated geometry": func(c *contract.WorldChunk) { c.Land = "woods" },
		"decor":              func(c *contract.WorldChunk) { c.Decor = &contract.DecorList{} },
		"entity": func(c *contract.WorldChunk) {
			c.Entities = []*contract.WildsEntity{{Id: "node:0:1:0", Kind: "node", Material: "timber"}}
		},
		"terrain":       func(c *contract.WorldChunk) { c.Palette[0] = "lava" },
		"packing":       func(c *contract.WorldChunk) { c.Solid = c.Solid[1:] },
		"palette index": func(c *contract.WorldChunk) { c.Ground[0] = 0xff },
		"object kind":   func(c *contract.WorldChunk) { c.Objects[0].Kind = "dragon" },
		"object tile":   func(c *contract.WorldChunk) { c.Objects[0].Tx = 24 },
		"object id":     func(c *contract.WorldChunk) { c.Objects[1].Id = c.Objects[0].Id },
		"empty id":      func(c *contract.WorldChunk) { c.Objects[0].Id = "" },
	} {
		c := proto.Clone(Fixed("fixed:hearthwick@2", 0, 1)).(*contract.WorldChunk)
		edit(c)
		if Validate(c) == nil {
			t.Errorf("accepted %s", name)
		}
	}
	generated := func() *contract.WorldChunk {
		return &contract.WorldChunk{EpochId: "epoch", Realm: "hearthwick", Look: "tangle", Cx: 1, Cy: 0, GeneratorVersion: 3, Size: 24, Tier: 1, Land: "woods", Palette: []string{"grass_b"}, Ground: make([]byte, 288), Solid: make([]byte, 72), Decor: &contract.DecorList{}}
	}
	if err := Validate(generated()); err != nil {
		t.Fatal(err)
	}
	for _, edit := range []func(*contract.WorldChunk){func(c *contract.WorldChunk) { c.EpochId = "fixed:hearthwick@2" }, func(c *contract.WorldChunk) { c.LayoutRevision = 1 }, func(c *contract.WorldChunk) { c.Objects = []*contract.Placed{{Id: "tree:0,0", Kind: "tree"}} }} {
		c := generated()
		edit(c)
		if Validate(c) == nil {
			t.Fatal("generated chunk accepted fixed data")
		}
	}
}

type townPosition struct {
	Source, Kind, Area string
	Tile               [2]int
}

func servedOpen(t *testing.T) map[[2]int]bool {
	t.Helper()
	open := map[[2]int]bool{}
	for _, f := range content.PlacesRules.GetFixed() {
		cs, err := ComposeFixed(f, content.Layouts[f.GetLayout()])
		if err != nil {
			t.Fatal(err)
		}
		for _, c := range cs {
			for i := 0; i < 576; i++ {
				if c.Solid[i/8]&(1<<(i%8)) == 0 {
					open[[2]int{int(c.Cx)*24 + i%24, int(c.Cy)*24 + i/24}] = true
				}
			}
			for _, o := range c.Objects {
				switch o.Kind {
				case "tree", "bush", "rock", "prop", "lamp":
					delete(open, [2]int{int(c.Cx)*24 + int(o.Tx), int(c.Cy)*24 + int(o.Ty)})
				}
			}
		}
	}
	return open
}
func reached(open map[[2]int]bool, from [2]int) map[[2]int]bool {
	seen := map[[2]int]bool{from: true}
	q := [][2]int{from}
	for i := 0; i < len(q); i++ {
		p := q[i]
		for _, d := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
			n := [2]int{p[0] + d[0], p[1] + d[1]}
			if open[n] && !seen[n] {
				seen[n] = true
				q = append(q, n)
			}
		}
	}
	return seen
}
func TestServedTownStandsAndTargets(t *testing.T) {
	open := servedOpen(t)
	raw, err := os.ReadFile("../../../content/vectors/location.json")
	if err != nil {
		t.Fatal(err)
	}
	var doc struct{ Positions []townPosition }
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	if len(doc.Positions) == 0 {
		t.Fatal("no positions")
	}
	for _, from := range [][2]int{{5, 60}, {2, 24}, {47, 59}, {12, 119}, {-48, 71}, {71, 72}} {
		t.Run(fmt.Sprint(from), func(t *testing.T) {
			if !open[from] {
				t.Fatal("blocked flood start")
			}
			seen := reached(open, from)
			for _, f := range content.PlacesRules.GetFixed() {
				for _, a := range f.GetAnchors() {
					p := [2]int{int(a.GetTx() + f.GetOrigin().GetTx()), int(a.GetTy() + f.GetOrigin().GetTy())}
					if !seen[p] {
						t.Errorf("anchor %s:%s %v unreachable", f.GetId(), a.GetId(), p)
					}
				}
			}
			for _, v := range doc.Positions {
				if location.ContentSpace(v.Area) != location.Outdoors {
					t.Errorf("%s not outdoors", v.Source)
				}
				switch v.Kind {
				case "stand":
					if !seen[v.Tile] {
						t.Errorf("%s %v unreachable", v.Source, v.Tile)
					}
				case "target":
					beside := false
					for _, d := range [][2]int{{1, 0}, {-1, 0}, {0, 1}, {0, -1}} {
						beside = beside || seen[[2]int{v.Tile[0] + d[0], v.Tile[1] + d[1]}]
					}
					if !beside {
						t.Errorf("%s %v has no reachable approach", v.Source, v.Tile)
					}
				default:
					t.Errorf("unknown kind %s", v.Kind)
				}
			}
			for g := 0; g < 8; g++ {
				ox, oy := LotOrigin(g)
				if !seen[[2]int{ox + 11, oy + 8}] {
					t.Errorf("lot:%d doorstep unreachable", g)
				}
			}
		})
	}
}
func TestServedTownRoadMouths(t *testing.T) {
	open := servedOpen(t)
	for x := -24; x <= 47; x++ {
		if open[[2]int{x, 24}] != (x >= 1 && x <= 3) {
			t.Errorf("north %d", x)
		}
		if open[[2]int{x, 119}] != (x <= -22 || x >= 45 || x >= 11 && x <= 13) {
			t.Errorf("south %d", x)
		}
	}
	for y := 25; y <= 119; y++ {
		for _, x := range []int{-24, 47} {
			if !open[[2]int{x, y}] {
				t.Errorf("lot row %d,%d", x, y)
			}
		}
	}
	for g := 0; g < 8; g++ {
		ox, oy := LotOrigin(g)
		back := ox
		if g%2 == 1 {
			back += 23
		}
		for y := 2; y <= 21; y++ {
			if !open[[2]int{back, oy + y}] {
				t.Errorf("back %d,%d", back, oy+y)
			}
		}
	}
	for _, y := range []int{71, 72} {
		for _, ox := range []int{-48, 48} {
			for x := ox; x < ox+24; x++ {
				if !open[[2]int{x, y}] {
					t.Errorf("wildgate %d,%d", x, y)
				}
			}
		}
	}
}
