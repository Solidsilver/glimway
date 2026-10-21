package wilds

// Biome regions (~32 chunks across: terrain-decisions.md, terrain-sol.md §1,
// terrain-argon.md §1.3). Each 32-chunk lattice cell (rx, ry) has a stable
// id "r:<rx>:<ry>" and a deterministic site jittered within ±6 chunks of its
// centre. Ownership uses plain nearest-site squared distance (without dividing
// by site size, so borders are never circular arcs) after a bounded 2-octave
// coordinate warp (up to 4 chunks, wavelengths 24 and 8 chunks). Ties break by
// signed (ry, rx). A signed border-distance band drives coherent patch
// blending across region boundaries and three-region junctions.

import (
	"fmt"
	"sync"
)

const (
	// RegionChunks is the nominal width/height of a biome region lattice cell.
	RegionChunks = 32
	// RegionJitterChunks is the maximum site jitter from a cell's centre (±6 chunks).
	RegionJitterChunks = 6
	// RegionWarpCoarseChunks and RegionWarpFineChunks are the two warp wavelengths.
	RegionWarpCoarseChunks = 24
	RegionWarpFineChunks   = 8
	// RegionWarpCoarseTiles and RegionWarpFineTiles sum to 4 chunks (96 tiles) max displacement.
	RegionWarpCoarseTiles = 68
	RegionWarpFineTiles   = 28
	// BlendBandTiles is the total width of the biome border-distance blend band
	// (8 tiles on each side of the Voronoi bisector = 16 tiles total).
	BlendBandTiles     = 16
	BlendHalfBandTiles = BlendBandTiles / 2
	// WhitequietBlendHalfTiles keeps the Whitequiet margin crisp (at most 4 tiles
	// on each side of a Whitequiet border, terrain-sol.md §1).
	WhitequietBlendHalfTiles = 4
)

// RegionCoord identifies a 32-chunk region lattice cell on signed coordinates.
type RegionCoord struct {
	RX int `json:"rx"`
	RY int `json:"ry"`
}

// ID returns the stable string identifier "r:<rx>:<ry>".
func (rc RegionCoord) ID() string {
	return fmt.Sprintf("r:%d:%d", rc.RX, rc.RY)
}

// Less orders region coordinates deterministically by signed (ry, rx).
func (rc RegionCoord) Less(other RegionCoord) bool {
	if rc.RY != other.RY {
		return rc.RY < other.RY
	}
	return rc.RX < other.RX
}

// RegionSite is a region lattice cell's jittered seed point in world tiles.
type RegionSite struct {
	Coord  RegionCoord `json:"coord"`
	SX, SY int         `json:"-"`
}

// RegionSample is the region ownership and border-distance result at a world tile.
type RegionSample struct {
	Primary         RegionCoord `json:"primary"`
	Secondary       RegionCoord `json:"secondary"`
	Tertiary        RegionCoord `json:"tertiary"`
	PrimarySite     [2]int      `json:"primarySite"`
	Dist12FP        int         `json:"-"` // perpendicular distance to Primary/Secondary bisector in 1/256 tile
	Dist13FP        int         `json:"-"` // perpendicular distance to Primary/Tertiary bisector in 1/256 tile
	BorderDistTiles int         `json:"borderDistTiles"`
	InBlendBand     bool        `json:"inBlendBand"`
	TripleJunction  bool        `json:"tripleJunction"`
}

func regionTiles() int { return RegionChunks * chunkSize() }

type regionCacheKey struct {
	seed   string
	rx, ry int
}

var regionSiteCache sync.Map

// RegionSiteAt returns the deterministic jittered site for region cell (rx, ry).
func RegionSiteAt(worldSeed string, rx, ry int) RegionSite {
	key := regionCacheKey{worldSeed, rx, ry}
	if v, ok := regionSiteCache.Load(key); ok {
		return v.(RegionSite)
	}
	S := chunkSize()
	L := RegionChunks * S
	cx := rx*L + L/2
	cy := ry*L + L/2
	rng := NewRng(landformV2Hash(worldSeed, "region-site", rx, ry))
	jitter := RegionJitterChunks * S
	st := RegionSite{
		Coord: RegionCoord{RX: rx, RY: ry},
		SX:    cx + rng.Spread(jitter),
		SY:    cy + rng.Spread(jitter),
	}
	regionSiteCache.Store(key, st)
	return st
}

// regionWarped returns the warped tile centre in 1/256-tile (fp) units.
// Bounded to ±4 chunks (±96 tiles) total displacement along each axis.
func regionWarped(worldSeed string, tx, ty int) pt {
	S := chunkSize()
	p := tileCentre(tx, ty)
	wx1 := sampleFieldOctave(landformV2Hash(worldSeed, "region-warp:x1"), tx, ty, RegionWarpCoarseChunks*S)
	wy1 := sampleFieldOctave(landformV2Hash(worldSeed, "region-warp:y1"), tx, ty, RegionWarpCoarseChunks*S)
	wx2 := sampleFieldOctave(landformV2Hash(worldSeed, "region-warp:x2"), tx, ty, RegionWarpFineChunks*S)
	wy2 := sampleFieldOctave(landformV2Hash(worldSeed, "region-warp:y2"), tx, ty, RegionWarpFineChunks*S)

	amp1 := RegionWarpCoarseTiles * fp
	amp2 := RegionWarpFineTiles * fp
	p.x += (wx1-noiseMid)*2*amp1>>16 + (wx2-noiseMid)*2*amp2>>16
	p.y += (wy1-noiseMid)*2*amp1>>16 + (wy2-noiseMid)*2*amp2>>16
	return p
}

// RegionAt evaluates region ownership, runner-up regions, and exact bisector
// border distances at world tile (tx, ty) over a bounded 5×5 site window
// (negative coordinates included).
func RegionAt(worldSeed string, tx, ty int) RegionSample {
	L := regionTiles()
	wp := regionWarped(worldSeed, tx, ty)
	baseRX := floorDiv(wp.x, L*fp)
	baseRY := floorDiv(wp.y, L*fp)

	type cand struct {
		site RegionSite
		d2   int64
	}
	better := func(a, b cand) bool {
		if a.d2 != b.d2 {
			return a.d2 < b.d2
		}
		return a.site.Coord.Less(b.site.Coord)
	}

	var c1, c2, c3 cand
	c1.d2, c2.d2, c3.d2 = -1, -1, -1

	for dy := -2; dy <= 2; dy++ {
		for dx := -2; dx <= 2; dx++ {
			st := RegionSiteAt(worldSeed, baseRX+dx, baseRY+dy)
			sc := tileCentre(st.SX, st.SY)
			ddx, ddy := int64(wp.x-sc.x), int64(wp.y-sc.y)
			cur := cand{site: st, d2: ddx*ddx + ddy*ddy}
			if c1.d2 < 0 || better(cur, c1) {
				c3 = c2
				c2 = c1
				c1 = cur
			} else if c2.d2 < 0 || better(cur, c2) {
				c3 = c2
				c2 = cur
			} else if c3.d2 < 0 || better(cur, c3) {
				c3 = cur
			}
		}
	}

	// Exact Euclidean perpendicular distance in fp (1/256 tile) from warped
	// point wp to the unweighted Voronoi bisector between c1 and c2:
	//   dist12 = (d2^2 - d1^2) / (2 * ||s2 - s1||)
	s1 := tileCentre(c1.site.SX, c1.site.SY)
	s2 := tileCentre(c2.site.SX, c2.site.SY)
	s3 := tileCentre(c3.site.SX, c3.site.SY)

	sep12 := int64(max(1, isqrt64(int64(s2.x-s1.x)*int64(s2.x-s1.x)+int64(s2.y-s1.y)*int64(s2.y-s1.y))))
	dist12FP := int((c2.d2 - c1.d2) / (2 * sep12))

	sep13 := int64(max(1, isqrt64(int64(s3.x-s1.x)*int64(s3.x-s1.x)+int64(s3.y-s1.y)*int64(s3.y-s1.y))))
	dist13FP := int((c3.d2 - c1.d2) / (2 * sep13))

	halfBandFP := BlendHalfBandTiles * fp
	inBlend := dist12FP < halfBandFP
	triple := inBlend && dist13FP < halfBandFP

	return RegionSample{
		Primary:         c1.site.Coord,
		Secondary:       c2.site.Coord,
		Tertiary:        c3.site.Coord,
		PrimarySite:     [2]int{c1.site.SX, c1.site.SY},
		Dist12FP:        dist12FP,
		Dist13FP:        dist13FP,
		BorderDistTiles: dist12FP / fp,
		InBlendBand:     inBlend,
		TripleJunction:  triple,
	}
}
