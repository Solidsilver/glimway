//go:build dev

package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"

	"glimway/server/internal/wilds"
)

func TestDevTerrainFindRoutes(t *testing.T) {
	x := newRig(t)
	cookie, _ := x.ready("terrain-find")
	get := func(path string, handler http.HandlerFunc, auth bool) *httptest.ResponseRecorder {
		r := httptest.NewRequest("GET", path, nil)
		if auth {
			r.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		handler(w, r)
		return w
	}
	for _, route := range []struct {
		path    string
		handler http.HandlerFunc
	}{{DevTerrainFeaturesPath, x.api.DevTerrainFeatures}, {DevTerrainMapPath, x.api.DevTerrainMap}} {
		if w := get(route.path, route.handler, false); w.Code != 401 {
			t.Fatal("auth", w.Code)
		}
		if w := get(route.path+"?recipe=bad", route.handler, true); w.Code != 400 {
			t.Fatal("recipe", w.Code)
		}
		r := httptest.NewRequest("POST", route.path, nil)
		r.AddCookie(cookie)
		w := httptest.NewRecorder()
		route.handler(w, r)
		if w.Code != 405 {
			t.Fatal("method", w.Code)
		}
	}
	path := DevTerrainFeaturesPath + "?x=12&y=30"
	w := get(path, x.api.DevTerrainFeatures, true)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var got struct {
		Recipe   string               `json:"recipe"`
		Owners   int                  `json:"owners"`
		Features []wilds.SlopeFeature `json:"features"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Recipe != wilds.SlopeRecipeV2 || got.Owners != 9 || len(got.Features) != 7 {
		t.Fatal("bounded feature reply", got)
	}
	for _, f := range got.Features {
		if f.Owner[0] < -1 || f.Owner[0] > 1 || f.Owner[1] < -1 || f.Owner[1] > 1 {
			t.Fatal("escaped surrounding owners", f)
		}
	}
	if w2 := get(path, x.api.DevTerrainFeatures, true); !reflect.DeepEqual(w.Body.Bytes(), w2.Body.Bytes()) {
		t.Fatal("warm reply changed")
	}
	for _, q := range []string{"", "?x=NaN&y=0", "?x=999999999&y=0", "?x=0&y=0&recipe=bad"} {
		if w := get(DevTerrainFeaturesPath+q, x.api.DevTerrainFeatures, true); w.Code != 400 {
			t.Fatal("invalid position", q, w.Code)
		}
	}
	for _, q := range []string{"", "?c=0", "?c=0,NaN", "?c=999999,0", "?c=" + strings.Repeat("0,0&c=", 256) + "0,0"} {
		if w := get(DevTerrainMapPath+q, x.api.DevTerrainMap, true); w.Code != 400 {
			t.Fatal("invalid map request", q, w.Code)
		}
	}
	mapPath := DevTerrainMapPath + "?c=-1,-1&c=10,12"
	m := get(mapPath, x.api.DevTerrainMap, true)
	if m.Code != 200 {
		t.Fatal(m.Code, m.Body.String())
	}
	var reply struct {
		Step   int
		Chunks []terrainMapChunk
		Marks  []terrainMapMark
	}
	if err := json.Unmarshal(m.Body.Bytes(), &reply); err != nil {
		t.Fatal(err)
	}
	if reply.Step != 4 || len(reply.Chunks) != 2 || len(reply.Chunks[0].Height) != 36 || len(reply.Chunks[0].Kind) != 36 {
		t.Fatal("not coarse", reply)
	}
	if len(m.Body.Bytes()) > 4000 {
		t.Fatal("coarse payload too large", len(m.Body.Bytes()))
	}
	if m2 := get(mapPath, x.api.DevTerrainMap, true); !reflect.DeepEqual(m.Body.Bytes(), m2.Body.Bytes()) {
		t.Fatal("cached map changed")
	}
	for _, c := range reply.Chunks {
		for _, h := range c.Height {
			if h > 15*256 {
				t.Fatal("invalid height")
			}
		}
	}
	if w := get(DevTerrainMapPath+"?c=0,0&recipe="+wilds.SlopeRecipe, x.api.DevTerrainMap, true); w.Code != 200 || w.Header().Get("X-Glimway-Terrain-Recipe") != wilds.SlopeRecipe {
		t.Fatal("v1 unavailable")
	}
}
