package wilds

import (
	"context"
	"fmt"
	"slices"
)

type SlopeCornerOverride struct {
	Tile    int
	Corners [4]uint16 // NW, NE, SE, SW; tile-owned, never written into the grid
}

// SlopeSurface is the canonical field-coordinate geometry. The row-major
// (W+1)x(H+1) Uint16 grid remains intact underneath sorted sparse overrides.
// Ground has no cover data or projected coordinates. Tile resolves a view.
type SlopeSurface struct {
	W, H      int
	Corners   []uint16
	Overrides []SlopeCornerOverride
	Ground    []SlopeGroundData
}

func (s *SlopeSurface) gridCorners(i int) [4]uint16 {
	j := i/s.W*(s.W+1) + i%s.W
	return [4]uint16{s.Corners[j], s.Corners[j+1], s.Corners[j+s.W+2], s.Corners[j+s.W+1]}
}
func (s *SlopeSurface) Tile(i int) SlopeTile {
	c := s.gridCorners(i)
	if len(s.Overrides) > 0 {
		j, ok := slices.BinarySearchFunc(s.Overrides, i, func(o SlopeCornerOverride, index int) int { return o.Tile - index })
		if ok {
			c = s.Overrides[j].Corners
		}
	}
	return SlopeTile{Corners: c, SlopeGroundData: s.Ground[i]}
}

// Walkable evaluates the resolved field patch with the shared integer rule.
// No screen coordinates, projection, cover, or centre-gradient sample enters it.
func (s *SlopeSurface) Walkable(i int) bool {
	return i >= 0 && i < len(s.Ground) && s.Ground[i].Kind == SlopeGround && SlopeGradientSquared(s.Tile(i).Corners) <= SlopeWalkLimit*SlopeWalkLimit
}

// SlopeCornerOwner names the chunk starting at that world corner's cell.
// At x=cx*24 or y=cy*24, the eastern/southern chunk owns the border corner;
// the southeast chunk owns a four-chunk junction. All other users replicate
// the owner's pure world-coordinate sample, never a neighbour's mutable data.
func SlopeCornerOwner(x, y int) (int, int) { return floorDiv(x, 24), floorDiv(y, 24) }

// Surface samples every boundary corner, including east and south. Sampling
// the 8-tile field cells needs their globally aligned bracketing nodes (at
// most 8 tiles beyond a requested corner). Scarp metadata may read a lip up
// to 6 rows north. No chunk-relative interpolation, averaging or quantization
// is allowed. Field supports never depend on a generated neighbour.
func (s *SlopeSampler) Surface(ctx context.Context, x, y, w, h int) (*SlopeSurface, error) {
	if w <= 0 || h <= 0 || w > 2400000/h {
		return nil, fmt.Errorf("slope surface needs 1..2400000 tiles")
	}
	f := &SlopeSurface{W: w, H: h, Corners: make([]uint16, (w+1)*(h+1)), Ground: make([]SlopeGroundData, w*h)}
	for yy := 0; yy <= h; yy++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		for xx := 0; xx <= w; xx++ {
			f.Corners[yy*(w+1)+xx] = s.Corner(x+xx, y+yy)
		}
	}
	for yy := 0; yy < h; yy++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		for xx := 0; xx < w; xx++ {
			i := yy*w + xx
			f.Ground[i] = s.tile(x+xx, y+yy, f.gridCorners(i)).SlopeGroundData
		}
	}
	return f, nil
}

// Clip copies a canonical subwindow, retaining the original border corners
// and remapping tile-owned overrides. Offsets are in field tiles.
func (s *SlopeSurface) Clip(x, y, w, h int) (*SlopeSurface, error) {
	if x < 0 || y < 0 || x >= s.W || y >= s.H || w <= 0 || h <= 0 || w > s.W-x || h > s.H-y {
		return nil, fmt.Errorf("slope crop outside surface")
	}
	f := &SlopeSurface{W: w, H: h, Corners: make([]uint16, (w+1)*(h+1)), Ground: make([]SlopeGroundData, w*h)}
	for yy := 0; yy <= h; yy++ {
		copy(f.Corners[yy*(w+1):(yy+1)*(w+1)], s.Corners[(y+yy)*(s.W+1)+x:][:w+1])
	}
	for yy := 0; yy < h; yy++ {
		copy(f.Ground[yy*w:(yy+1)*w], s.Ground[(y+yy)*s.W+x:][:w])
	}
	for _, o := range s.Overrides {
		ox, oy := o.Tile%s.W, o.Tile/s.W
		if ox >= x && ox < x+w && oy >= y && oy < y+h {
			o.Tile = (oy-y)*w + ox - x
			f.Overrides = append(f.Overrides, o)
		}
	}
	return f, nil
}
