// Package frontier is the bound of the open map before lamps (decision 3,
// docs/design/open-map.md 2.1, 2.6): chunks within Chebyshev distance
// frontier.reach of a footprint, and none south of frontier.southLimit. It
// is enforced at run time and never generated, because it moves in 0.9
// while chunks are immutable; lamps (lamps.md 2.1) extend Inside.
package frontier

import (
	"glimway/content"
	"glimway/server/internal/wilds"
)

// Inside is true for a chunk players may walk in and the server may make.
// world is unused in 0.8; 0.9's held chunks are per world.
func Inside(world string, cx, cy int) bool {
	f := content.WildsRules.GetFrontier()
	return cy <= int(f.GetSouthLimit()) && wilds.NearestFootprint(cx, cy) <= int(f.GetReach())
}

// Rect is the 0.8 frontier as the near read sends it: the inclusive chunk
// rectangle around the footprints, reach out, cut at the south limit. In
// 0.8 Inside is exactly this rectangle, because the footprints are stacked
// (a test pins that).
func Rect(world string) (minCx, minCy, maxCx, maxCy int) {
	f := content.WildsRules.GetFrontier()
	r := int(f.GetReach())
	for i, p := range content.WildsRules.Places {
		x0, y0 := int(p.GetCx())-r, int(p.GetCy())-r
		x1, y1 := int(p.GetCx()+p.GetWidth())-1+r, int(p.GetCy()+p.GetHeight())-1+r
		if i == 0 {
			minCx, minCy, maxCx, maxCy = x0, y0, x1, y1
			continue
		}
		minCx, minCy, maxCx, maxCy = min(minCx, x0), min(minCy, y0), max(maxCx, x1), max(maxCy, y1)
	}
	return minCx, minCy, maxCx, min(maxCy, int(f.GetSouthLimit()))
}
