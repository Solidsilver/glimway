// Package land generates a homestead's wild land. The server is its only
// generator: it validates placement and gathering against this land and
// serves it to the client (GET /api/homestead/land/<gate>, named by
// CellNames). testdata/lands.json pins the output, so no existing home's
// land ever moves.
package land

import (
	"glimway/content"
	"glimway/server/internal/wilds"
)

// Tile kinds (the same numbers as LAND in the TypeScript generator).
const (
	Grass byte = iota
	Tree
	Stump
	Boulder
	Water
	Ford
	Slope
	Edge
	Path
)

// Chars is one character per kind, for goldens and debugging.
const Chars = ".TSBw~/#="

// CellNames name the kinds on the wire (the client's LAND vocabulary), by kind value.
var CellNames = [...]string{"grass", "tree", "stump", "boulder", "water", "ford", "slope", "edge", "path"}

type Land struct {
	Width, Height int
	// Row-major kinds.
	Tiles []byte
}

// Seed is the land seed of a gate in a world (the world's id, not its secret seed).
func Seed(worldID string, gate int, cfg *content.HomeLand) uint32 {
	return wilds.Hash(worldID, "homestead-land", int(cfg.GetGenerator()), gate)
}

// Generate builds the land for a seed.
func Generate(seed uint32, cfg *content.HomeLand) Land {
	W, H := int(cfg.GetWidth()), int(cfg.GetHeight())
	tiles := make([]byte, W*H)
	at := func(x, y int) byte { return tiles[y*W+x] }
	put := func(x, y int, k byte) { tiles[y*W+x] = k }
	site, gate := cfg.GetSite(), cfg.GetGate()
	siteBottom := int(site.GetY()) + int(site.GetH())
	for y := 0; y < H; y++ {
		for x := 0; x < W; x++ {
			if x == 0 || y == 0 || x == W-1 || y == H-1 {
				put(x, y, Edge)
			} else {
				put(x, y, Grass)
			}
		}
	}
	for y := siteBottom; y < H; y++ {
		for x := int(gate.GetX()); x < int(gate.GetX())+int(gate.GetW()); x++ {
			put(x, y, Path)
		}
	}
	protected := func(x, y int) bool {
		return (x >= int(site.GetX())-1 && x <= int(site.GetX())+int(site.GetW()) && y >= int(site.GetY())-1 && y <= siteBottom) ||
			(x >= int(gate.GetX())-1 && x <= int(gate.GetX())+int(gate.GetW()) && y >= siteBottom)
	}
	rng := wilds.NewRng(seed)
	if rng.NextInt(1000) < int(cfg.GetStreamPermille()) {
		side := rng.NextInt(2)
		lo, hi := 2, 9
		if side != 0 {
			lo, hi = W-10, W-3
		}
		x := lo + rng.NextInt(hi-lo+1)
		ford := 3 + rng.NextInt(H-6)
		for y := 1; y < H-1; y++ {
			if at(x, y) == Grass && !protected(x, y) {
				if y == ford {
					put(x, y, Ford)
				} else {
					put(x, y, Water)
				}
			}
			r := rng.NextInt(4)
			if r == 0 && x > lo {
				x--
			} else if r == 1 && x < hi {
				x++
			}
		}
	}
	if rng.NextInt(1000) < int(cfg.GetSlopePermille()) {
		y0 := 2 + rng.NextInt(3)
		x0 := 2 + rng.NextInt(W/3)
		n := 8 + rng.NextInt(10)
		x1 := min(x0+n, W-2)
		for y := y0; y <= y0+1; y++ {
			for x := x0; x < x1; x++ {
				if at(x, y) == Grass && !protected(x, y) {
					put(x, y, Slope)
				}
			}
		}
	}
	scatter := func(n int, kind byte) {
		for i := 0; i < n; i++ {
			x := 1 + rng.NextInt(W-2)
			y := 1 + rng.NextInt(H-2)
			if at(x, y) == Grass && !protected(x, y) {
				put(x, y, kind)
			}
		}
	}
	scatter(int(cfg.GetTrees()), Tree)
	scatter(int(cfg.GetStumps()), Stump)
	scatter(int(cfg.GetBoulders()), Boulder)
	return Land{W, H, tiles}
}

// At is the kind at a tile (Edge off the map).
func (l Land) At(x, y int) byte {
	if x < 0 || y < 0 || x >= l.Width || y >= l.Height {
		return Edge
	}
	return l.Tiles[y*l.Width+x]
}

// Rows is the land as text rows (see Chars).
func (l Land) Rows() []string {
	out := make([]string, l.Height)
	for y := 0; y < l.Height; y++ {
		b := make([]byte, l.Width)
		for x := 0; x < l.Width; x++ {
			b[x] = Chars[l.At(x, y)]
		}
		out[y] = string(b)
	}
	return out
}

// Clearable obstacles: Silas clears trees, stumps and boulders for embers.
func Clearable(k byte) bool { return k == Tree || k == Stump || k == Boulder }

// Buildable ground (light permitting).
func Buildable(k byte) bool { return k == Grass || k == Path }

// Effective is what stands on a tile once cleared tiles are counted.
func (l Land) Effective(cleared map[[2]int]bool, x, y int) byte {
	k := l.At(x, y)
	if Clearable(k) && cleared[[2]int{x, y}] {
		return Grass
	}
	return k
}

// Light holds land: the home's own lamp or a named lantern post.
type Light struct{ X, Y, Radius int }

// Lit reports whether a tile is within any light (integer distance).
func Lit(lights []Light, x, y int) bool {
	for _, l := range lights {
		dx, dy := x-l.X, y-l.Y
		if dx*dx+dy*dy <= l.Radius*l.Radius {
			return true
		}
	}
	return false
}
