package wilds

import (
	"fmt"
	"math"

	"glimway/content"
)

// The open map's coordinates (docs/design/open-map.md 2.1): world tiles and
// chunks are signed, north is -y, and chunk (0, 0) is the one the Commons
// gate opens into. Tile (x, y) lies in chunk (floor(x/S), floor(y/S)) and
// pixel (px, py) on tile (floor(px/16), floor(py/16)). Everything here reads
// content/wilds.json; src/lib/wilds/coords.ts is the twin, and both replay
// content/vectors/wilds-coords.json.

// FloorDiv is a/b rounded toward minus infinity (Go's / truncates); b > 0.
func FloorDiv(a, b int) int {
	q := a / b
	if a%b != 0 && a < 0 {
		q--
	}
	return q
}

// ChunkOf is the chunk a world tile lies in.
func ChunkOf(tx, ty int) (cx, cy int) {
	S := int(content.WildsRules.GetChunkSize())
	return FloorDiv(tx, S), FloorDiv(ty, S)
}

// LocalOf is a world tile's place inside its chunk, 0..S-1 each way.
func LocalOf(tx, ty int) (lx, ly int) {
	S := int(content.WildsRules.GetChunkSize())
	cx, cy := ChunkOf(tx, ty)
	return tx - cx*S, ty - cy*S
}

// TileOfPixel is the world tile under a world pixel position. Positions are
// doubles on the wire (Where, saved places), so it floors after dividing:
// -0.5 is tile -1, never 0 (an int conversion would truncate toward zero).
// Callers check the position is finite and in range at the request boundary.
func TileOfPixel(px, py float64) (tx, ty int) {
	return int(math.Floor(px / tilePx)), int(math.Floor(py / tilePx))
}

// Footprint is the named footprint with the id ("tangle", "whitequiet"),
// or nil.
func Footprint(id string) *content.WildsPlace {
	for _, p := range content.WildsRules.Places {
		if p.GetId() == id {
			return p
		}
	}
	return nil
}

// FootprintAt is the footprint holding chunk (cx, cy), or nil.
func FootprintAt(cx, cy int) *content.WildsPlace {
	for _, p := range content.WildsRules.Places {
		if FootprintDistance(p, cx, cy) == 0 {
			return p
		}
	}
	return nil
}

// FootprintDistance is the Chebyshev distance in chunks from (cx, cy) to the
// footprint's nearest chunk: 0 inside it.
func FootprintDistance(p *content.WildsPlace, cx, cy int) int {
	x0, y0 := int(p.GetCx()), int(p.GetCy())
	x1, y1 := x0+int(p.GetWidth())-1, y0+int(p.GetHeight())-1
	dx := max(x0-cx, cx-x1, 0)
	dy := max(y0-cy, cy-y1, 0)
	return max(dx, dy)
}

// NearestFootprint is the least FootprintDistance to any footprint.
func NearestFootprint(cx, cy int) int {
	d := -1
	for _, p := range content.WildsRules.Places {
		if e := FootprintDistance(p, cx, cy); d < 0 || e < d {
			d = e
		}
	}
	return d
}

// Ring is how many rings of tierRingChunks a chunk lies past the
// footprints (decision 9): 0 inside one, 1 for the first ring, and so on.
func Ring(cx, cy int) int {
	n := int(content.WildsRules.GetTierRingChunks())
	return (NearestFootprint(cx, cy) + n - 1) / n
}

// Tier is a chunk's tier of difficulty (decision 9): its footprint's, else
// 2 + Ring, capped at the last content tier.
func Tier(cx, cy int) int {
	if p := FootprintAt(cx, cy); p != nil {
		return int(p.GetTier())
	}
	return min(2+Ring(cx, cy), len(content.WildsRules.Tiers))
}

// EpochKindAt is the epoch kind a chunk is made in: its footprint's, else
// "wick" (everything in the Beyond turns at the wick, decision 18). 0.9's
// held chunks are lane work on top of this (chunkEpoch).
func EpochKindAt(cx, cy int) string {
	if p := FootprintAt(cx, cy); p != nil {
		return p.GetEpochKind()
	}
	return "wick"
}

// CellOf is the cell holding chunk (cx, cy) (design 2.2 pass 1): the Tangle
// is cell (0, 0) and the Whitequiet (0, -1).
func CellOf(cx, cy int) (x, y int) {
	c := content.WildsRules.GetCells()
	n := int(c.GetCellChunks())
	return FloorDiv(cx-int(c.GetOriginCx()), n), FloorDiv(cy-int(c.GetOriginCy()), n)
}

// CellPlaceID is the id of a cell's place: "place:<cellX>:<cellY>".
func CellPlaceID(x, y int) string { return fmt.Sprintf("place:%d:%d", x, y) }

// FootprintCell is true when the cell is a footprint's (it holds the
// footprint's fixed sites, never a place).
func FootprintCell(x, y int) bool {
	c := content.WildsRules.GetCells()
	n := int(c.GetCellChunks())
	return FootprintAt(int(c.GetOriginCx())+x*n, int(c.GetOriginCy())+y*n) != nil
}
