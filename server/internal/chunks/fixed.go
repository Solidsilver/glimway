package chunks

// The fixed source (docs/design/location-seam.md 0 decision 2, 1.4, 4):
// an authored layout (content/layouts/<id>.json) laid on the grid by its
// fixed place (content/places.json), sliced into chunks once, at load. A
// fixed chunk is never stored: it comes from content, under the pseudo-epoch
// "fixed:<layout>@<revision>", so a new revision is a new key in every
// cache that keys chunks by epoch (the store's LRU, the client's).

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"sync"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/wilds"
)

const fixedPrefix = "fixed:"

// FixedEpoch is the pseudo-epoch a layout's chunks are served under at a
// revision: "fixed:<layout>@<revision>".
func FixedEpoch(layout string, revision int32) string {
	return fixedPrefix + layout + "@" + strconv.Itoa(int(revision))
}

// ParseFixedEpoch reads a fixed pseudo-epoch; ok is false for any other
// epoch id (a stored epoch's is never "fixed:").
func ParseFixedEpoch(id string) (layout string, revision int32, ok bool) {
	rest, ok := strings.CutPrefix(id, fixedPrefix)
	if !ok {
		return "", 0, false
	}
	layout, rev, ok := strings.Cut(rest, "@")
	n, err := strconv.ParseInt(rev, 10, 32)
	if !ok || layout == "" || err != nil || n < 1 || strconv.FormatInt(n, 10) != rev {
		return "", 0, false
	}
	return layout, int32(n), true
}

// IsFixedEpoch: the id names the fixed source's pseudo-epoch form.
func IsFixedEpoch(id string) bool { return strings.HasPrefix(id, fixedPrefix) }

type fixedKey struct {
	epoch  string
	cx, cy int32
}

// fixedChunks are the shipped layouts' chunks, composed on first use.
var fixedChunks = sync.OnceValue(func() map[fixedKey]*contract.WorldChunk {
	out := map[fixedKey]*contract.WorldChunk{}
	for _, f := range content.PlacesRules.GetFixed() {
		cs, err := ComposeFixed(f, content.Layouts[f.GetLayout()])
		if err != nil {
			panic(err)
		}
		for _, c := range cs {
			out[fixedKey{c.EpochId, c.Cx, c.Cy}] = c
		}
	}
	return out
})

// Fixed is chunk (cx, cy) of the fixed place whose layout and revision the
// pseudo-epoch names, or nil: another revision, a chunk outside the place,
// or no such layout. The chunk is shared: callers clone before changing it.
func Fixed(epoch string, cx, cy int32) *contract.WorldChunk {
	return fixedChunks()[fixedKey{epoch, cx, cy}]
}

// ComposeFixed slices a fixed place's layout into its footprint's chunks,
// row-major. Each chunk's palette is the terrains it uses, sorted; its
// objects are the layout's whose tile it holds, in layout order, with
// chunk-local tiles. A chunk using more than 16 terrains can't be packed.
func ComposeFixed(f *content.FixedPlace, l *content.Layout) ([]*contract.WorldChunk, error) {
	if l == nil || l.GetId() != f.GetLayout() || l.GetRevision() != f.GetRevision() {
		return nil, fmt.Errorf("fixed place %s: no layout %s at revision %d", f.GetId(), f.GetLayout(), f.GetRevision())
	}
	S := int(content.WildsRules.GetChunkSize())
	ox, oy := int(f.GetOrigin().GetTx()), int(f.GetOrigin().GetTy())
	gx, gy := int(l.GetTx()), int(l.GetTy())
	x0, y0, x1, y1 := content.FixedChunks(f)
	epoch := FixedEpoch(l.GetId(), l.GetRevision())
	var out []*contract.WorldChunk
	for cy := y0; cy <= y1; cy++ {
		for cx := x0; cx <= x1; cx++ {
			// Layout tile of the chunk's north-west tile, and grid index of it.
			lx, ly := cx*S-ox, cy*S-oy
			c := &contract.WorldChunk{
				EpochId: epoch, Realm: wilds.Realm, Cx: int32(cx), Cy: int32(cy), Size: uint32(S),
				Source: contract.ChunkSource_CHUNK_SOURCE_FIXED, LayoutRevision: uint32(l.GetRevision()),
			}
			terrain := func(x, y int) string { return l.GetPalette()[l.GetGround()[ly-gy+y][lx-gx+x:lx-gx+x+1]] }
			for y := range S {
				for x := range S {
					if t := terrain(x, y); !slices.Contains(c.Palette, t) {
						c.Palette = append(c.Palette, t)
					}
				}
			}
			if len(c.Palette) > 16 {
				return nil, fmt.Errorf("layout %s chunk %d,%d: %d terrains, at most 16", l.GetId(), cx, cy, len(c.Palette))
			}
			slices.Sort(c.Palette)
			c.Ground = make([]byte, S*S/2)
			c.Solid = make([]byte, S*S/8)
			for y := range S {
				for x := range S {
					i := y*S + x
					c.Ground[i/2] |= byte(slices.Index(c.Palette, terrain(x, y))) << (4 * (i % 2))
					if l.GetSolid()[ly-gy+y][lx-gx+x] == '#' {
						c.Solid[i/8] |= 1 << (i % 8)
					}
				}
			}
			for _, o := range l.GetObjects() {
				tx, ty := int(o.GetTx())-lx, int(o.GetTy())-ly
				if tx >= 0 && ty >= 0 && tx < S && ty < S {
					c.Objects = append(c.Objects, placed(o, tx, ty))
				}
			}
			out = append(out, c)
		}
	}
	return out, nil
}

func placed(o *content.LayoutObject, tx, ty int) *contract.Placed {
	p := &contract.Placed{
		Id: o.GetId(), Kind: o.GetKind(), Tx: uint32(tx), Ty: uint32(ty), Tw: uint32(o.GetTw()), Th: uint32(o.GetTh()),
		Variant: o.GetVariant(), Frame: o.GetFrame(), Festival: o.GetFestival(),
		Gate: uint32(o.GetGate()), Side: o.GetSide(), Npc: o.GetNpc(), Spot: o.GetSpot(),
		Target: o.GetTarget(), Label: o.GetLabel(), Width: uint32(o.GetWidth()),
	}
	if a := o.GetArt(); a != nil {
		p.Art = &contract.PlacedArt{Ox: a.GetOx(), Oy: a.GetOy(), OriginLeft: a.GetOriginLeft(), Depth: a.Depth, DepthY: a.GetDepthY(), Flip: a.GetFlip(), Tint: a.Tint, Tile: a.GetTile()}
	}
	if r := o.GetProp(); r != nil {
		p.Prop = &contract.PlacedProp{H: uint32(r.GetH()), BodyW: uint32(r.GetBodyW()), BodyH: uint32(r.GetBodyH()), Light: r.GetLight()}
	}
	if e := o.GetExit(); e != nil {
		p.Exit = &contract.PlacedExit{To: e.GetTo(), EntryTx: uint32(e.GetEntryTx()), EntryTy: uint32(e.GetEntryTy()), Unlabelled: e.GetUnlabelled()}
	}
	return p
}

// placedKinds are the object kinds a fixed chunk may carry (layout.proto).
var placedKinds = []string{"tree", "bush", "rock", "overhang", "prop", "lamp", "scenery", "well", "board", "gate", "sign", "shelf", "exit", "npc-post", "repair", "gather"}

// validateFixed is Validate for a fixed chunk: its pseudo-epoch names the
// layout and revision that location.SourceOf gives its coordinates (an
// unknown layout, another revision or a chunk outside the place is
// refused), its palette names curated terrains, it carries objects of
// known kinds on its own tiles with unique ids, and nothing generated.
func validateFixed(c *contract.WorldChunk) error {
	S := uint32(content.WildsRules.GetChunkSize())
	layout, revision, ok := ParseFixedEpoch(c.EpochId)
	_, _, isPlot := PlotIdentity(c.EpochId)
	if _, gate, plot := PlotIdentity(c.EpochId); plot {
		layout, revision, ok = "homestead-lots", PlotRevision, LotAt(int(c.Cx), int(c.Cy)) == gate
	}
	if !ok || c.Size != S || c.Realm != content.WildsRules.GetRealm() || c.Layer != 0 || c.GeneratorVersion != 0 || c.LayoutRevision != uint32(revision) {
		return fmt.Errorf("invalid chunk identity")
	}
	src := location.SourceOf(int(c.Cx), int(c.Cy))
	if src.Kind != location.SourceFixed || src.Layout != layout || src.Revision != revision {
		return fmt.Errorf("unknown layout %s@%d at chunk %d,%d", layout, revision, c.Cx, c.Cy)
	}
	if (c.Look != "" && !(isPlot && c.Look == "tangle")) || c.Mark != "" || c.Tier != 0 || c.Land != "" || c.Decor != nil || len(c.Sites) > 0 || len(c.Entities) > 0 || len(c.Places) > 0 {
		return fmt.Errorf("a fixed chunk carries generated geometry")
	}
	cells := int(S * S)
	if len(c.Palette) == 0 || len(c.Palette) > 16 || len(c.Ground) != cells/2 || len(c.Solid) != cells/8 {
		return fmt.Errorf("invalid cell packing")
	}
	for _, p := range c.Palette {
		if !slices.Contains(content.CuratedTerrains, p) {
			return fmt.Errorf("unknown terrain %q", p)
		}
	}
	for _, b := range c.Ground {
		if int(b&15) >= len(c.Palette) || int(b>>4) >= len(c.Palette) {
			return fmt.Errorf("invalid palette index")
		}
	}
	ids := map[string]bool{}
	for _, o := range c.Objects {
		if o == nil || o.Id == "" || len(o.Id) > 64 || ids[o.Id] || !slices.Contains(placedKinds, o.Kind) || o.Tx >= S || o.Ty >= S {
			return fmt.Errorf("invalid object")
		}
		ids[o.Id] = true
	}
	return nil
}
