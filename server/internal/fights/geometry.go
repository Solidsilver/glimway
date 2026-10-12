// Package fights owns generated camp combat in physical world space. It has
// no dependency on storage, request projection, area names or presence rooms.
package fights

import (
	"glimway/server/internal/chunks"
	"math"
)

const TilePixels = 16
const EnemyRadius = 6

// Geometry is copied at wake. Safe ground can be supplied by a position
// lookup when other outdoor places join this grid; it is another leash edge.
type Geometry struct {
	CX, CY, Size int
	Open         []bool
	Safe         func(x, y float64) bool
}

func GeometryAtWake(e chunks.Effective) Geometry {
	c := e.Chunk
	g := Geometry{CX: int(c.Cx), CY: int(c.Cy), Size: int(c.Size), Open: make([]bool, int(c.Size*c.Size))}
	for y := 0; y < g.Size; y++ {
		for x := 0; x < g.Size; x++ {
			g.Open[y*g.Size+x] = e.Walkable(x, y)
		}
	}
	return g
}

func (g Geometry) CanStand(x, y, radius float64) bool {
	if g.Safe != nil && g.Safe(x, y) {
		return false
	}
	ox, oy := float64(g.CX*g.Size*TilePixels), float64(g.CY*g.Size*TilePixels)
	x, y = x-ox, y-oy
	for ty := int(math.Floor((y - radius) / TilePixels)); ty <= int(math.Floor((y+radius)/TilePixels)); ty++ {
		for tx := int(math.Floor((x - radius) / TilePixels)); tx <= int(math.Floor((x+radius)/TilePixels)); tx++ {
			if tx >= 0 && ty >= 0 && tx < g.Size && ty < g.Size && g.Open[ty*g.Size+tx] {
				continue
			}
			qx := math.Max(float64(tx*TilePixels), math.Min(x, float64((tx+1)*TilePixels)))
			qy := math.Max(float64(ty*TilePixels), math.Min(y, float64((ty+1)*TilePixels)))
			dx, dy := x-qx, y-qy
			if float64(dx*dx)+float64(dy*dy) < radius*radius {
				return false
			}
		}
	}
	return true
}

// Substeps prevent a hop or shove tunnelling through a single solid tile.
// Axis separation lets a circle slide along walls.
func (g Geometry) Move(x, y, dx, dy float64) (float64, float64) {
	n := max(1, int(math.Ceil(math.Max(math.Abs(dx), math.Abs(dy))/3)))
	for range n {
		nx := x + dx/float64(n)
		if g.CanStand(nx, y, EnemyRadius) {
			x = nx
		}
		ny := y + dy/float64(n)
		if g.CanStand(x, ny, EnemyRadius) {
			y = ny
		}
	}
	return x, y
}

// A bolt can start in a neighbouring chunk. Only this room's geometry is
// authoritative here; chunk edges leash creatures, not projectiles.
func (g Geometry) CanBoltFly(x, y float64) bool {
	size := float64(g.Size * TilePixels)
	ox, oy := float64(g.CX*g.Size*TilePixels), float64(g.CY*g.Size*TilePixels)
	if x < ox || y < oy || x >= ox+size || y >= oy+size {
		return true
	}
	return g.CanStand(x, y, .1)
}
