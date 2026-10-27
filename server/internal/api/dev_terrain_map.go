//go:build dev

package api

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync"

	"glimway/server/internal/location"
	"glimway/server/internal/wilds"
)

// 36 samples per chunk, not a 24² surface and never SL2. Each sample is
// centre height, kind and gradient (from that tile's exact corners).
type terrainMapChunk struct {
	CX     int      `json:"cx"`
	CY     int      `json:"cy"`
	Height []uint16 `json:"height"`
	Kind   []int16  `json:"kind"`
	DX     []int16  `json:"dx"`
	DY     []int16  `json:"dy"`
}
type terrainMapMark struct {
	Kind string `json:"kind"`
	X    int    `json:"x"`
	Y    int    `json:"y"`
}

var terrainMapCache = struct {
	sync.Mutex
	chunks map[terrainOwnerKey]terrainMapChunk
	order  []terrainOwnerKey
}{chunks: make(map[terrainOwnerKey]terrainMapChunk)}

func (a *Server) DevTerrainMap(w http.ResponseWriter, r *http.Request) {
	seed, recipe, ok := devTerrainSource(a, w, r)
	if !ok {
		return
	}
	asked := r.URL.Query()["c"]
	if len(asked) == 0 || len(asked) > 256 {
		http.Error(w, "ask for 1..256 chunks", 400)
		return
	}
	coords := make([][2]int, 0, len(asked))
	for _, q := range asked {
		xs, ys, ok := strings.Cut(q, ",")
		x, ex := strconv.Atoi(xs)
		y, ey := strconv.Atoi(ys)
		if !ok || ex != nil || ey != nil || !location.OnGrid(x, y) {
			http.Error(w, "invalid chunks", 400)
			return
		}
		coords = append(coords, [2]int{x, y})
	}
	s, _ := wilds.NewSlopeSamplerRecipe(seed, recipe)
	out := make([]terrainMapChunk, 0, len(coords))
	owners := map[[2]int]bool{}
	terrainMapCache.Lock()
	defer terrainMapCache.Unlock()
	for _, xy := range coords {
		if err := r.Context().Err(); err != nil {
			return
		}
		cx, cy := xy[0], xy[1]
		key := terrainOwnerKey{seed, recipe, cx, cy}
		c, hit := terrainMapCache.chunks[key]
		if !hit {
			c = terrainMapChunk{CX: cx, CY: cy, Height: make([]uint16, 0, 36), Kind: make([]int16, 0, 36), DX: make([]int16, 0, 36), DY: make([]int16, 0, 36)}
			for y := 2; y < 24; y += 4 {
				for x := 2; x < 24; x += 4 {
					t := s.Tile(cx*24+x, cy*24+y)
					h := t.Corners
					c.Height = append(c.Height, uint16((int(h[0])+int(h[1])+int(h[2])+int(h[3]))/4))
					kind := int16(t.Kind)
					// Thin south faces must survive the coarse sampling.
					for dy := -2; dy <= 1; dy++ {
						g := s.Tile(cx*24+x, cy*24+y+dy)
						if int16(g.Kind) > kind {
							kind = int16(g.Kind)
						}
					}
					c.Kind = append(c.Kind, kind)
					c.DX = append(c.DX, int16((int(h[1])+int(h[2])-int(h[0])-int(h[3]))/2))
					c.DY = append(c.DY, int16((int(h[2])+int(h[3])-int(h[0])-int(h[1]))/2))
				}
			}
			if len(terrainMapCache.order) >= 1024 {
				delete(terrainMapCache.chunks, terrainMapCache.order[0])
				terrainMapCache.order = terrainMapCache.order[1:]
			}
			terrainMapCache.chunks[key] = c
			terrainMapCache.order = append(terrainMapCache.order, key)
		}
		out = append(out, c)
		ox, oy := intFloor(cx, 24), intFloor(cy, 24)
		owners[[2]int{ox, oy}] = true
	}
	marks := []terrainMapMark{}
	// Stable order independent of map iteration, with no feature-owner plans.
	for _, xy := range coords {
		key := [2]int{intFloor(xy[0], 24), intFloor(xy[1], 24)}
		if !owners[key] {
			continue
		}
		delete(owners, key)
		ranges, err := wilds.SlopeRangeMarkers(seed, recipe, key[0], key[1])
		if err != nil {
			http.Error(w, "markers failed", 500)
			return
		}
		for _, m := range ranges {
			marks = append(marks, terrainMapMark{m.Kind, m.Target[0], m.Target[1]})
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"recipe": recipe, "step": 4, "chunks": out, "marks": marks})
}

func intFloor(x, d int) int {
	q := x / d
	if x%d < 0 {
		q--
	}
	return q
}
