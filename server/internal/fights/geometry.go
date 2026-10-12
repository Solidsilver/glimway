// Package fights owns generated camp combat in physical world space. It has
// no dependency on storage, request projection, area names or presence rooms.
package fights

import (
	"glimway/content"
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
	return canStand(g.open, x, y, radius)
}

// open is a world tile's ground in this chunk; every tile off it is solid
// (the chunk's edge leashes its creatures).
func (g Geometry) open(tx, ty int) bool {
	tx, ty = tx-g.CX*g.Size, ty-g.CY*g.Size
	return tx >= 0 && ty >= 0 && tx < g.Size && ty < g.Size && g.Open[ty*g.Size+tx]
}

// canStand: a circle at world (x, y) overlaps no solid tile.
func canStand(open func(tx, ty int) bool, x, y, radius float64) bool {
	for ty := int(math.Floor((y - radius) / TilePixels)); ty <= int(math.Floor((y+radius)/TilePixels)); ty++ {
		for tx := int(math.Floor((x - radius) / TilePixels)); tx <= int(math.Floor((x+radius)/TilePixels)); tx++ {
			if open(tx, ty) {
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

// Ground is the walkable ground across chunk edges, for a hero's dash: the
// wake geometry of each chunk it holds. A chunk it does not hold (beyond
// the frontier, or not loaded) is solid.
type Ground struct {
	size   int
	chunks map[[2]int]Geometry
}

func NewGround(geometries ...Geometry) Ground {
	g := Ground{chunks: map[[2]int]Geometry{}}
	for _, c := range geometries {
		if c.Size > 0 && len(c.Open) == c.Size*c.Size && (g.size == 0 || g.size == c.Size) {
			g.size = c.Size
			g.chunks[[2]int{c.CX, c.CY}] = c
		}
	}
	return g
}
func (g Ground) open(tx, ty int) bool {
	if g.size == 0 {
		return false
	}
	cx, cy := floorDiv(tx, g.size), floorDiv(ty, g.size)
	c, ok := g.chunks[[2]int{cx, cy}]
	return ok && c.Open[(ty-cy*g.size)*g.size+tx-cx*g.size]
}
func floorDiv(a, b int) int {
	q := a / b
	if a%b != 0 && (a < 0) != (b < 0) {
		q--
	}
	return q
}

// Dash is Shadowstep's travel from the feet at (x, y) along a unit facing
// (content signatures.shadowstep: its speed for its time), in small steps
// that slide along walls as the hero's body does. The hub runs it once per
// cast over the caster's 3x3, so every room the strike reaches judges the
// same end, wherever the chunk edges fall.
func (g Ground) Dash(x, y, fx, fy float64) (float64, float64) {
	s := content.CombatRules.GetSignatures().GetShadowstep()
	dx, dy := float64(fx*s.GetDashSpeed())*s.GetDashSeconds(), float64(fy*s.GetDashSpeed())*s.GetDashSeconds()
	steps := max(1, int(math.Ceil(math.Max(math.Abs(dx), math.Abs(dy))/3)))
	for range steps {
		if nx := x + dx/float64(steps); canStand(g.open, nx, y, EnemyRadius) {
			x = nx
		}
		if ny := y + dy/float64(steps); canStand(g.open, x, ny, EnemyRadius) {
			y = ny
		}
	}
	return x, y
}

// Substeps prevent a hop or shove tunnelling through a single solid tile.
// Axis separation lets a circle slide along walls.
func (g Geometry) Move(x, y, dx, dy float64) (float64, float64) {
	x, y, _ = g.MoveBlocked(x, y, dx, dy)
	return x, y
}

// MoveBlocked also reports whether a wall stopped either axis, as an arcade
// body's `blocked` does: a beetle's charge that meets one ends dazed.
func (g Geometry) MoveBlocked(x, y, dx, dy float64) (float64, float64, bool) {
	blocked := false
	n := max(1, int(math.Ceil(math.Max(math.Abs(dx), math.Abs(dy))/3)))
	for range n {
		nx := x + dx/float64(n)
		if g.CanStand(nx, y, EnemyRadius) {
			x = nx
		} else if dx != 0 {
			blocked = true
		}
		ny := y + dy/float64(n)
		if g.CanStand(x, ny, EnemyRadius) {
			y = ny
		} else if dy != 0 {
			blocked = true
		}
	}
	return x, y, blocked
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
