package wilds

import "math"

// TerrainFits copies the height lab's foot-box contract. x,y are feet in
// screen-space pixels; from is the previous stand tile. A 10x4 px hero
// follows every cardinal tile-centre edge in the certificate without a corner
// overlap. Wider bodies need their own clearance certificate.
func (p *TerrainPlan) TerrainFits(from int, x, y, hw, fh float64) bool {
	tile := func(px float64) int { return int(math.Floor(px / 16)) }
	nx, ny := tile(x), tile(y-fh/2)
	i := p.index(nx, ny)
	if i < 0 || !TerrainWalkable(p.Tiles[i]) {
		return false
	}
	if i != from {
		found := false
		for d := 0; d < 4; d++ {
			if p.Step(from, d) == i {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	for yy := tile(y - fh); yy <= tile(y-0.001); yy++ {
		for xx := tile(x - hw); xx <= tile(x+hw-0.001); xx++ {
			if xx == nx && yy == ny {
				continue
			}
			if abs(xx-nx) > 1 || abs(yy-ny) > 1 {
				return false
			}
			j := p.index(xx, yy)
			if j < 0 {
				return false
			}
			xdir, ydir := 1, 2
			if xx < nx {
				xdir = 3
			}
			if yy < ny {
				ydir = 0
			}
			if xx == nx {
				if p.Step(i, ydir) != j {
					return false
				}
				continue
			}
			if yy == ny {
				if p.Step(i, xdir) != j {
					return false
				}
				continue
			}
			a, b := p.Step(i, xdir), p.Step(i, ydir)
			if !(a >= 0 && p.Step(a, ydir) == j) && !(b >= 0 && p.Step(b, xdir) == j) {
				return false
			}
		}
	}
	return true
}
