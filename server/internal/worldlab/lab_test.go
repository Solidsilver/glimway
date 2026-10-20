package worldlab

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"glimway/content"
	"glimway/server/internal/wilds"
)

// The test binary is its own worker, as the server binary is the lab's.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "_nice" {
		niceWorker()
		os.Exit(0)
	}
	if len(os.Args) > 1 && os.Args[1] == "_worker" {
		if err := RunWorker(os.Stdin, os.Stdout); err != nil {
			_, _ = io.WriteString(os.Stderr, err.Error())
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func testLab(t *testing.T) *Lab {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	return NewLab([]string{exe, "_worker"}, func(*http.Request) (Here, bool) {
		return Here{World: "w", Seed: "here-world", Epoch: DefaultEpoch}, true
	}, func(world string, cx, _ int) bool { return world == "w" && cx > -5 })
}

func post(t *testing.T, l *Lab, name string, body any) *httptest.ResponseRecorder {
	t.Helper()
	raw, ok := body.([]byte)
	if !ok {
		var err error
		if raw, err = json.Marshal(body); err != nil {
			t.Fatal(err)
		}
	}
	w := httptest.NewRecorder()
	l.ServeHTTP(w, httptest.NewRequest(http.MethodPost, Prefix+name, bytes.NewReader(raw)))
	return w
}

// tunedRules is the embedded rules with no thickets anywhere.
func tunedRules(t *testing.T) string {
	var doc map[string]any
	if err := json.Unmarshal(embeddedRules(), &doc); err != nil {
		t.Fatal(err)
	}
	for _, land := range doc["lands"].([]any) {
		land.(map[string]any)["thicketPermille"] = 0
	}
	raw, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	return string(raw)
}

func TestLabState(t *testing.T) {
	w := httptest.NewRecorder()
	testLab(t).ServeHTTP(w, httptest.NewRequest(http.MethodGet, Prefix+"state", nil))
	var st struct {
		Seed, Epoch, Rules string
		ChunkSize          int
		Here               *Here
	}
	if err := json.Unmarshal(w.Body.Bytes(), &st); err != nil || w.Code != 200 {
		t.Fatal(w.Code, err)
	}
	if st.Seed != "here-world" || st.Here == nil || st.Rules != string(embeddedRules()) || st.ChunkSize != int(content.WildsRules.GetChunkSize()) {
		t.Fatalf("state %+v", st)
	}
}

// The CLI's limits hold, and a request too big is refused before any work.
func TestLabLimits(t *testing.T) {
	l := testLab(t)
	for _, req := range []map[string]any{
		{"view": "atlas", "seed": "s", "epoch": DefaultEpoch, "rect": []int{-1000, -1000, 1000, 1000}, "scale": 1},
		{"view": "region", "seed": "s", "epoch": DefaultEpoch, "rect": []int{-40, -40, 40, 40}, "scale": 1},
		{"view": "region", "seed": "s", "epoch": DefaultEpoch, "rect": []int{0, 0, 29, 29}, "scale": 8},
		{"view": "atlas", "seed": "s", "epoch": DefaultEpoch, "rect": []int{0, 0, 1, 1}, "scale": 1, "overlays": "solid"},
		{"view": "atlas", "seed": "", "epoch": DefaultEpoch, "rect": []int{0, 0, 1, 1}, "scale": 1},
		{"view": "atlas", "seed": "s", "epoch": "bad", "rect": []int{0, 0, 1, 1}, "scale": 1},
		{"view": "atlas", "seed": "s", "epoch": DefaultEpoch, "rect": []int{0, 0, 1, 1}, "scale": 1, "b": map[string]any{"seed": strings.Repeat("x", 300)}},
		{"view": "atlas", "seed": "s", "epoch": DefaultEpoch, "rect": []int{0, 0, 1, 1}, "scale": 1, "rules": "{not json"},
		{"view": "atlas", "seed": "s", "epoch": DefaultEpoch, "rect": []int{0, 0, 1, 1}, "scale": 1, "surprise": true},
	} {
		if w := post(t, l, "render", req); w.Code != http.StatusBadRequest {
			t.Fatalf("%v: %d %.200s", req, w.Code, w.Body)
		}
	}
	big := []byte(`{"rules":"` + strings.Repeat("x", maxBody) + `"}`)
	if w := post(t, l, "render", big); w.Code != http.StatusRequestEntityTooLarge {
		t.Fatal("an oversized body:", w.Code)
	}
	if w := post(t, l, "check", map[string]string{"rules": "{}"}); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "rules") {
		t.Fatal("empty rules passed the check:", w.Code, w.Body)
	}
	if w := post(t, l, "check", map[string]string{"rules": tunedRules(t)}); w.Code != 200 {
		t.Fatal("tuned rules failed the check:", w.Body)
	}
	w := httptest.NewRecorder()
	l.ServeHTTP(w, httptest.NewRequest(http.MethodGet, Prefix+"render", nil))
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatal("a GET render:", w.Code)
	}
}

type labAnswer struct {
	Result
	Error string `json:"error"`
}

func answer(t *testing.T, w *httptest.ResponseRecorder) labAnswer {
	t.Helper()
	var a labAnswer
	if err := json.Unmarshal(w.Body.Bytes(), &a); err != nil || w.Code != 200 {
		t.Fatal(w.Code, w.Body.String(), err)
	}
	return a
}

// Rendering an edited variant never changes what this process's own
// generator makes, and the lab's embedded render is the generator's own.
func TestLabVariantIsolation(t *testing.T) {
	l := testLab(t)
	before, err := wilds.GenerateV3(wilds.WickEpoch("lab-test", DefaultEpoch), -4, -9, nil)
	if err != nil {
		t.Fatal(err)
	}
	rules := content.WildsRules
	region := map[string]any{"view": "region", "seed": "lab-test", "epoch": DefaultEpoch, "rect": []int{-5, -9, -3, -7}, "scale": 1}
	plain := answer(t, post(t, l, "render", region))
	region["rules"] = tunedRules(t)
	tuned := answer(t, post(t, l, "render", region))
	if bytes.Equal(plain.PNG, tuned.PNG) || tuned.Stats.Content != "edited" || plain.Stats.Content != "embedded" {
		t.Fatal("the edited rules made no difference", tuned.Stats.Content)
	}
	if content.WildsRules != rules {
		t.Fatal("a variant render replaced this process's rules")
	}
	after, err := wilds.GenerateV3(wilds.WickEpoch("lab-test", DefaultEpoch), -4, -9, nil)
	if err != nil {
		t.Fatal(err)
	}
	if !equalChunks(before, after) {
		t.Fatal("a variant render changed this process's generator")
	}
	own, err := Render(context.Background(), Options{View: "region", Seed: "lab-test", Epoch: DefaultEpoch, Rect: [4]int{-5, -9, -3, -7}, Scale: 1, Workers: 1})
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(own.PNG, plain.PNG) {
		t.Fatal("the lab's embedded render differs from this process's generator")
	}
	// Embedded vs edited, side by side.
	delete(region, "rules")
	region["b"] = map[string]any{"rules": tunedRules(t)}
	diff := answer(t, post(t, l, "render", region))
	if diff.Comparison == nil || diff.Comparison.Changed == 0 || diff.Comparison.B.Content != "edited" || len(diff.Signatures) != 0 {
		t.Fatalf("diff %+v", diff.Comparison)
	}
	// Tiles, both versions.
	tile := map[string]any{"seed": "lab-test", "epoch": DefaultEpoch, "at": []int{-73, -169}}
	w := post(t, l, "tile", tile)
	var info TileInfo
	if err := json.Unmarshal(w.Body.Bytes(), &info); err != nil || w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if info.Chunk != [2]int{-4, -8} || info.Ground == "" || info.Stand == nil || info.OnGrid == nil || !*info.OnGrid {
		t.Fatalf("tile %+v", info)
	}
	// Outside the caller's world: no standing there.
	far := post(t, l, "tile", map[string]any{"seed": "lab-test", "epoch": DefaultEpoch, "at": []int{-140, -169}})
	if err := json.Unmarshal(far.Body.Bytes(), &info); err != nil || info.OnGrid == nil || *info.OnGrid {
		t.Fatal("a chunk off the caller's grid:", far.Body.String())
	}
	tile["rules"] = tunedRules(t)
	if w := post(t, l, "tile", tile); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
}

func equalChunks(a, b wilds.Chunk) bool {
	ra, _ := json.Marshal(a)
	rb, _ := json.Marshal(b)
	return bytes.Equal(ra, rb)
}

// A repeat render is the cached answer; a busy lab says so.
func TestLabCacheAndSlots(t *testing.T) {
	l := testLab(t)
	atlas := map[string]any{"view": "atlas", "seed": "cache", "epoch": DefaultEpoch, "rect": []int{-10, -10, 10, 10}, "scale": 2}
	first := post(t, l, "render", atlas)
	second := post(t, l, "render", atlas)
	if first.Code != 200 || second.Header().Get("X-Worldlab-Cache") != "hit" || !bytes.Equal(first.Body.Bytes(), second.Body.Bytes()) {
		t.Fatal("no cache hit", first.Code, second.Header())
	}
	for range labSlots {
		l.slots <- struct{}{}
	}
	l.wait = 50 * time.Millisecond
	atlas["seed"] = "busy"
	if w := post(t, l, "render", atlas); w.Code != http.StatusServiceUnavailable {
		t.Fatal("a full lab took another render:", w.Code)
	}
	c := newCache(100)
	c.put("a", make([]byte, 20))
	c.put("b", make([]byte, 20))
	c.get("a")
	for _, k := range []string{"c", "d", "e"} {
		c.put(k, make([]byte, 20))
	}
	c.put("f", make([]byte, 20))
	if _, ok := c.get("b"); ok {
		t.Fatal("the least recent entry stayed")
	}
	if _, ok := c.get("a"); !ok || c.size > 100 {
		t.Fatal("cache order or size wrong", c.size)
	}
}
