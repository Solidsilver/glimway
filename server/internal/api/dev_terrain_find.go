//go:build dev

package api

import (
	"context"
	"encoding/json"
	"math"
	"net/http"
	"strconv"
	"sync"

	"glimway/server/internal/location"
	"glimway/server/internal/wilds"
)

const DevTerrainFeaturesPath = "/api/dev/terrain/features"
const DevTerrainMapPath = "/api/dev/terrain/map"

// Cache summaries, never whole owner surfaces. Fixed entry limits bound
// memory across worlds/recipes. The lock also bounds concurrent cold work.
var terrainFindCache = struct {
	sync.Mutex
	owners map[terrainOwnerKey][]wilds.SlopeFeature
	order  []terrainOwnerKey
}{owners: make(map[terrainOwnerKey][]wilds.SlopeFeature)}

type terrainOwnerKey struct {
	seed, recipe string
	x, y         int
}

func terrainOwner(ctx context.Context, seed, recipe string, x, y int) ([]wilds.SlopeFeature, error) {
	k := terrainOwnerKey{seed, recipe, x, y}
	terrainFindCache.Lock()
	defer terrainFindCache.Unlock()
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if v, ok := terrainFindCache.owners[k]; ok {
		return v, nil
	}
	v, err := wilds.SlopeOwnerFeatures(ctx, seed, recipe, x, y)
	if err != nil {
		return nil, err
	}
	if len(terrainFindCache.order) >= 32 {
		delete(terrainFindCache.owners, terrainFindCache.order[0])
		terrainFindCache.order = terrainFindCache.order[1:]
	}
	terrainFindCache.owners[k] = v
	terrainFindCache.order = append(terrainFindCache.order, k)
	return v, nil
}

func devTerrainSource(a *Server, w http.ResponseWriter, r *http.Request) (string, string, bool) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", 405)
		return "", "", false
	}
	here, ok := a.DevWorldLabHere(r)
	if !ok {
		http.Error(w, "no session", 401)
		return "", "", false
	}
	recipe := r.URL.Query().Get("recipe")
	if recipe == "" {
		recipe = DevTerrainRecipe
	}
	if _, err := wilds.NewSlopeSamplerRecipe(here.Seed, recipe); err != nil {
		http.Error(w, "unknown terrain recipe", 400)
		return "", "", false
	}
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Glimway-Terrain-Recipe", recipe)
	return here.Seed, recipe, true
}

func (a *Server) DevTerrainFeatures(w http.ResponseWriter, r *http.Request) {
	seed, recipe, ok := devTerrainSource(a, w, r)
	if !ok {
		return
	}
	x, ex := strconv.Atoi(r.URL.Query().Get("x"))
	y, ey := strconv.Atoi(r.URL.Query().Get("y"))
	if ex != nil || ey != nil || !location.OnGrid(int(math.Floor(float64(x)/24)), int(math.Floor(float64(y)/24))) {
		http.Error(w, "invalid position", 400)
		return
	}
	ox, oy := int(math.Floor(float64(x)/wilds.SlopeOwnerTiles)), int(math.Floor(float64(y)/wilds.SlopeOwnerTiles))
	best := map[string]wilds.SlopeFeature{}
	distance := func(f wilds.SlopeFeature) float64 { return math.Hypot(float64(f.Target[0]-x), float64(f.Target[1]-y)) }
	owners := 0
	for yy := oy - 1; yy <= oy+1; yy++ {
		for xx := ox - 1; xx <= ox+1; xx++ {
			owners++
			features, err := terrainOwner(r.Context(), seed, recipe, xx, yy)
			if err != nil {
				http.Error(w, "feature planning failed", 500)
				return
			}
			for _, f := range features {
				if !location.OnGrid(int(math.Floor(float64(f.Stand[0])/24)), int(math.Floor(float64(f.Stand[1])/24))) {
					continue
				}
				if old, ok := best[f.Kind]; !ok || distance(f) < distance(old) {
					best[f.Kind] = f
				}
			}
		}
	}
	out := []wilds.SlopeFeature{}
	for _, kind := range []string{"pass", "crest", "spire", "outcrop-top", "outcrop-foot", "hills", "tunnel"} {
		if f, ok := best[kind]; ok {
			out = append(out, f)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]any{"recipe": recipe, "owners": owners, "features": out})
}
