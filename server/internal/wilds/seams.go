package wilds

import (
	"strings"
	"sync"

	"glimway/content"
)

// Seams beside the fixed block (hearthwick-2.md §5). The town and the lot
// columns are authored; the wick Wilds round them are generated. Where a
// fixed edge tile is open toward a wick chunk (a lot's open back, a
// wildgate, the South Gate, a Lot Row lane end) the generated side:
//
//   - mirrors the fixed side in its two edge tiles, as every seam does
//     (seamMirror);
//   - keeps a soft band in the next tile: at most one tile in four solid,
//     never two in a row along the edge, and detail never carves those
//     few away (they stand as the first trees);
//   - thins the land's thickets over the feather tiles past it, so the
//     woods close in over a few tiles instead of at a straight wall;
//   - keeps camps, enemies and dealt sites keepOutTiles away.
//
// Beside the block, inside ring 1, the land field leans to the lots' own
// sides: woods west of the west lots, meadow east of the east lots.
//
// Everything is read from the authored layouts, never a world's stored
// plot, so it's a pure function of content and the epoch.

const (
	softDepth    = 3 // the soft band's tile: the first past the two mirrored
	featherDepth = 8 // the last tile the thickets thin over
	keepOutTiles = 6 // camps, enemies and dealt sites stay this far off
)

// featherPermille scales the land's thicket permille at each depth past the
// soft band (index: depth - softDepth - 1).
var featherPermille = [featherDepth - softDepth]int{300, 450, 600, 750, 880}

// softTile is a generated tile within featherDepth of an open fixed edge
// tile, straight out from it: how deep, which way out, and its place along
// the edge.
type softTile struct {
	depth, dx, dy, along int
}

type seamData struct {
	soft    map[[2]int]softTile
	keepOut map[[2]int]bool
	blocks  []box   // the fixed places, touching ones merged (fp)
	aprons  []apron // the town's south mouths
}

// apron: a fixed mouth wider than a route (the South Gate and the Lot Row
// lane ends, 3 tiles) keeps its width past the mirrored rows and frays to
// the route's trodden line over a few tiles, so the path runs on without a
// step at the seam (playtest 3).
type apron struct {
	cx, ey, dy int // the mouth's middle tile, its edge row, and the way out
	half       int // tiles either side of the middle
}

const apronDepth = 8 // the last tile past the edge the apron reaches

var seams = sync.OnceValue(loadSeams)

func loadSeams() *seamData {
	S := chunkSize()
	out := &seamData{soft: map[[2]int]softTile{}, keepOut: map[[2]int]bool{}}
	generated := func(tx, ty int) bool {
		cx, cy := floorDiv(tx, S), floorDiv(ty, S)
		return FixedFootprintAt(cx, cy) == nil && EpochKindAt(cx, cy) == EpochWick
	}
	for _, p := range content.PlacesRules.GetFixed() {
		x0, y0, x1, y1 := content.FixedChunks(p)
		for cy := y0; cy <= y1; cy++ {
			for cx := x0; cx <= x1; cx++ {
				for _, d := range dirs4 {
					if !generated((cx+d[0])*S, (cy+d[1])*S) {
						continue
					}
					for off := 0; off < S; off++ {
						fx, fy := edgeTile(cx, cy, d[0], d[1], off)
						if walk, _ := fixedTile(p, fx, fy); !walk {
							continue
						}
						along := fy
						if d[0] == 0 {
							along = fx
						}
						for k := 1; k <= featherDepth; k++ {
							tx, ty := fx+d[0]*k, fy+d[1]*k
							if !generated(tx, ty) {
								break
							}
							if s, ok := out.soft[[2]int{tx, ty}]; !ok || k < s.depth {
								out.soft[[2]int{tx, ty}] = softTile{k, d[0], d[1], along}
							}
						}
						for ky := -keepOutTiles; ky <= keepOutTiles; ky++ {
							for kx := -keepOutTiles; kx <= keepOutTiles; kx++ {
								if generated(fx+kx, fy+ky) {
									out.keepOut[[2]int{fx + kx, fy + ky}] = true
								}
							}
						}
					}
				}
			}
		}
	}
	// The town's south mouths: as wide as the road there on the fixed edge.
	for _, p := range content.PlacesRules.GetFixed() {
		if p.GetId() != "hearthwick" {
			continue
		}
		for _, e := range fixedPorts(p, 0, 1) {
			tx, ty := e.end.tile()
			ey := ty - 1
			x0, _, x1, _ := content.FixedChunks(p)
			road := func(x int) bool {
				if x < x0*chunkSize() || x >= (x1+1)*chunkSize() {
					return false
				}
				walk, g := fixedTile(p, x, ey)
				return walk && !strings.HasPrefix(g.String(), "grass")
			}
			half := 0
			for road(tx-half-1) && road(tx+half+1) {
				half++
			}
			out.aprons = append(out.aprons, apron{tx, ey, 1, half})
		}
	}
	// The block: fixed places merged while any two touch or overlap.
	for _, p := range content.PlacesRules.GetFixed() {
		out.blocks = append(out.blocks, fixedBox(p))
	}
	for merged := true; merged; {
		merged = false
		for i := 0; i < len(out.blocks) && !merged; i++ {
			for j := i + 1; j < len(out.blocks); j++ {
				a, b := out.blocks[i], out.blocks[j]
				if a.grow(fp).meets(b) {
					out.blocks[i] = box{min(a.x0, b.x0), min(a.y0, b.y0), max(a.x1, b.x1), max(a.y1, b.y1)}
					out.blocks = append(out.blocks[:j], out.blocks[j+1:]...)
					merged = true
					break
				}
			}
		}
	}
	return out
}

// softAt is the tile's place beside an open fixed edge, in a wick world.
func (w *world) softAt(tx, ty int) (softTile, bool) {
	if !w.wick {
		return softTile{}, false
	}
	s, ok := seams().soft[[2]int{tx, ty}]
	return s, ok && s.depth >= softDepth
}

// apronAt: is (tx, ty) on a mouth's apron? Its middle always; its sides
// ever less often with the depth, at hashed tiles, so the edge frays.
func (w *world) apronAt(tx, ty int) bool {
	if !w.wick {
		return false
	}
	for _, a := range seams().aprons {
		k := (ty - a.ey) * a.dy
		off := tx - a.cx
		if k < softDepth || k > apronDepth || off < -a.half || off > a.half {
			continue
		}
		if off == 0 || int(w.e.hash("apron", tx, ty)%1000) < 1000*(apronDepth-k)/(apronDepth-softDepth+1) {
			return true
		}
	}
	return false
}

// softSolid: may the soft band's tile at s stand solid? One tile in each
// run of four along the edge at most, at a hashed place in its run that is
// never the run's last, so two never stand side by side.
func (w *world) softSolid(s softTile) bool {
	run := floorDiv(s.along, 4)
	h := w.e.hash("soft", s.dx, s.dy, run)
	return s.along-run*4 == int(h%3) && h>>8%1000 < 750
}

// keptOut: no camp, enemy or dealt site may stand on world tile (tx, ty).
func keptOut(tx, ty int) bool { return seams().keepOut[[2]int{tx, ty}] }

// nearKeepOut: does the keep-out reach within r tiles of (tx, ty)? A
// place's clearing (and its camp) stays out of it.
func nearKeepOut(tx, ty, r int) bool {
	for y := ty - r; y <= ty+r; y++ {
		for x := tx - r; x <= tx+r; x++ {
			if keptOut(x, y) {
				return true
			}
		}
	}
	return false
}

// fixedBlocks are the fixed places, those that touch merged into one box
// (the 5×4 block of town and lot columns).
func fixedBlocks() []box { return seams().blocks }

// sideLean is the land the field leans to beside the fixed block: woods west
// of it, meadow east and south (Southfields runs on into meadow, with no
// border: playtest 3), strongest at the block and gone at ring 1's edge, in
// noisy patches (as the Wend's lean). Below a corner, the nearer side wins.
func (w *world) sideLean(tx, ty int) (int, bool) {
	if sideWoods < 0 || sideMeadow < 0 {
		return 0, false
	}
	r := int(contentRules().GetTierRingChunks()) * chunkSize()
	for _, b := range fixedBlocks() {
		x0, y0 := b.x0/fp, b.y0/fp
		x1, y1 := (b.x1-fp+1)/fp, (b.y1-fp+1)/fp
		land := sideWoods
		dx := x0 - tx
		if tx > x1 {
			land, dx = sideMeadow, tx-x1
		}
		if dy := ty - y1; dy > 0 && dy >= dx {
			land, dx = sideMeadow, dy
		}
		d := max(dx, y0-ty, ty-y1)
		if dx <= 0 || d > r {
			continue
		}
		pull := (r - d) * 1300 / r
		if w.warpY.at(tx*fp/10+77*fp, ty*fp/10)*1000>>16 < pull {
			return land, true
		}
	}
	return 0, false
}

// The lands the generator leans to beside the block: woods west, meadow
// east. Frozen here, not read from homestead.json's land.sides (how the lot
// columns are painted), so tuning the lots' look can't change world
// generation; TestV3SideLean checks the two still agree.
var (
	sideWoods  = landIndex("woods")
	sideMeadow = landIndex("meadow")
)
