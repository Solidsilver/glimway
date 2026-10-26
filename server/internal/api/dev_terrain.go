//go:build dev

package api

import (
	"encoding/binary"
	"errors"
	"net/http"
	"strconv"
	"strings"

	"glimway/server/internal/wilds"
)

// Dev mode only: GET /api/dev/terrain?c=cx,cy&c=… is generated height
// terrain for Wilds chunks, for the client's dev "height terrain" switch
// (src/game/terrain). Nothing is stored and no chunk changes: the surface
// is regenerated from the caller's world seed with DevTerrainRecipe each
// time. The live server never has this route (release builds don't compile
// it); a dev server mounts it for callers with the hooks or the world lab
// (server/cmd/glimway-server/dev_routes.go).
//
// The reply (application/octet-stream) is, per asked chunk in order: int32
// cx, int32 cy (little-endian), uint16 length, then that many bytes of the
// chunk's 24×24 surface in the slopes codec (wilds.EncodeSlopeChunk, SL2).
// The recipe's id is in the X-Glimway-Terrain-Recipe header.

// DevTerrainPath is the route's path.
const DevTerrainPath = "/api/dev/terrain"

// DevTerrainRecipe is the recipe the route serves (wilds.SlopeRecipes).
const DevTerrainRecipe = wilds.SlopeRecipe

// devTerrainMost is the most chunks one request may ask for (a 7×7 window).
const devTerrainMost = 49

// A dev route's refusals are plain text (no contract error codes).
var (
	errDevTerrainAsk    = errors.New("invalid chunks")
	errDevTerrainRecipe = errors.New("unknown terrain recipe")
)

func (a *Server) DevTerrain(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	here, ok := a.DevWorldLabHere(r)
	if !ok {
		http.Error(w, "no session", http.StatusUnauthorized)
		return
	}
	asked := r.URL.Query()["c"]
	if len(asked) == 0 || len(asked) > devTerrainMost {
		http.Error(w, "invalid chunks", http.StatusBadRequest)
		return
	}
	out, err := devTerrainReply(r, here.Seed, DevTerrainRecipe, asked)
	if err != nil {
		status := http.StatusInternalServerError
		if errors.Is(err, errDevTerrainAsk) {
			status = http.StatusBadRequest
		}
		http.Error(w, err.Error(), status)
		return
	}
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("X-Glimway-Terrain-Recipe", DevTerrainRecipe)
	w.WriteHeader(200)
	_, _ = w.Write(out)
}

func devTerrainReply(r *http.Request, seed, recipe string, asked []string) ([]byte, error) {
	surfacer := wilds.SlopeRecipes[recipe]
	if surfacer == nil {
		return nil, errDevTerrainRecipe
	}
	// One sampler for the request: its node cache is bounded by what's asked.
	sampler := surfacer(seed)
	var out []byte
	for _, c := range asked {
		xs, ys, ok := strings.Cut(c, ",")
		cx, errx := strconv.Atoi(xs)
		cy, erry := strconv.Atoi(ys)
		if !ok || errx != nil || erry != nil || cx < -100000 || cx > 100000 || cy < -100000 || cy > 100000 {
			return nil, errDevTerrainAsk
		}
		s, err := sampler.Surface(r.Context(), cx*24, cy*24, 24, 24)
		if err != nil {
			return nil, err
		}
		raw, err := wilds.EncodeSlopeChunk(s)
		if err != nil {
			return nil, err
		}
		out = binary.LittleEndian.AppendUint32(out, uint32(int32(cx)))
		out = binary.LittleEndian.AppendUint32(out, uint32(int32(cy)))
		out = binary.LittleEndian.AppendUint16(out, uint16(len(raw)))
		out = append(out, raw...)
	}
	return out, nil
}
