//go:build dev

package api

import (
	"context"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"glimway/server/internal/wilds"
)

// The dev terrain route answers each asked chunk's surface, regenerated
// from the caller's world seed, in the slopes codec, in the order asked.
// Nothing is stored. No session: no terrain.
func TestDevTerrainServesChunkSurfaces(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("terrain-hero")
	var seed string
	if err := x.db.DB.QueryRow("SELECT w.seed FROM players p JOIN worlds w ON w.id=p.world_id WHERE p.account_id=?", x.accounts["terrain-hero"]).Scan(&seed); err != nil {
		t.Fatal(err)
	}
	get := func(query string, cookie bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, DevTerrainPath+query, nil)
		if cookie {
			r.AddCookie(c)
		}
		w := httptest.NewRecorder()
		x.api.DevTerrain(w, r)
		return w
	}
	w := get("?c=5,-19&c=-1,-1&c=16,-19", true)
	if w.Code != 200 || w.Header().Get("X-Glimway-Terrain-Recipe") != wilds.SlopeRecipeV2 {
		t.Fatalf("terrain: %d %s", w.Code, w.Body.String())
	}
	body := w.Body.Bytes()
	for _, want := range [][2]int{{5, -19}, {-1, -1}, {16, -19}} {
		if len(body) < 10 {
			t.Fatal("short reply")
		}
		cx, cy, n := int(int32(binary.LittleEndian.Uint32(body))), int(int32(binary.LittleEndian.Uint32(body[4:]))), int(binary.LittleEndian.Uint16(body[8:]))
		if cx != want[0] || cy != want[1] || len(body) < 10+n {
			t.Fatal("chunk order or length", cx, cy, n)
		}
		got, err := wilds.DecodeSlopeChunk(body[10 : 10+n])
		if err != nil {
			t.Fatal(err)
		}
		sampler, err := wilds.NewSlopeSamplerRecipe(seed, wilds.SlopeRecipeV2)
		if err != nil {
			t.Fatal(err)
		}
		fresh, err := sampler.Surface(context.Background(), cx*24, cy*24, 24, 24)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, fresh) {
			t.Fatal("served surface differs from the seed's", cx, cy)
		}
		body = body[10+n:]
	}
	if len(body) != 0 {
		t.Fatal("trailing bytes")
	}
	if w := get("?c=0,0", false); w.Code != 401 {
		t.Fatal("no session:", w.Code)
	}
	for _, q := range []string{"", "?c=a,b", "?c=1", "?c=" + strings.Repeat("0,0&c=", 49) + "0,0"} {
		if w := get(q, true); w.Code != 400 {
			t.Fatal("bad ask", q, w.Code)
		}
	}
	r := httptest.NewRequest(http.MethodPost, DevTerrainPath+"?c=0,0", nil)
	r.AddCookie(c)
	rec := httptest.NewRecorder()
	x.api.DevTerrain(rec, r)
	if rec.Code != http.StatusMethodNotAllowed {
		t.Fatal("POST:", rec.Code)
	}
}

// slopes-gen@1 stays selectable; an unknown recipe is refused.
func TestDevTerrainRecipeIsSelectable(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("terrain-v1")
	r := httptest.NewRequest(http.MethodGet, DevTerrainPath+"?c=0,0&recipe="+wilds.SlopeRecipe, nil)
	r.AddCookie(c)
	w := httptest.NewRecorder()
	x.api.DevTerrain(w, r)
	if w.Code != 200 || w.Header().Get("X-Glimway-Terrain-Recipe") != wilds.SlopeRecipe {
		t.Fatal("v1:", w.Code)
	}
	r = httptest.NewRequest(http.MethodGet, DevTerrainPath+"?c=0,0&recipe=slopes-gen@9", nil)
	r.AddCookie(c)
	w = httptest.NewRecorder()
	x.api.DevTerrain(w, r)
	if w.Code != 400 {
		t.Fatal("unknown recipe:", w.Code)
	}
}
