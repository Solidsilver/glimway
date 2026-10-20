package main

import (
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"glimway/content"
)

// Re-exec the test binary through the real isolated worker protocol.
func TestMain(m *testing.M) {
	if len(os.Args) > 1 && os.Args[1] == "_worker" {
		if err := run(os.Args[1:], os.Stdout); err != nil {
			_, _ = io.WriteString(os.Stderr, err.Error())
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}
func testOptions(view string) options {
	return options{View: view, Seed: "lab-test", Epoch: defaultEpoch, Rect: [4]int{-5, -9, -3, -7}, Scale: 1, Workers: 2}
}
func TestRenderDeterminismAndMetrics(t *testing.T) {
	for _, view := range []string{"atlas", "region", "chunk"} {
		t.Run(view, func(t *testing.T) {
			o := testOptions(view)
			o.Signatures = true
			if view == "chunk" {
				o.Rect = [4]int{-4, -9, -4, -9}
				o.Scale = 4
			}
			a, err := render(context.Background(), o)
			if err != nil {
				t.Fatal(err)
			}
			o.Workers = 1
			b, err := render(context.Background(), o)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(a.PNG, b.PNG) {
				t.Fatal("worker count changed pixels")
			}
			cfg, err := png.DecodeConfig(bytes.NewReader(a.PNG))
			if err != nil {
				t.Fatal(err)
			}
			if cfg.Width != a.Width*a.Scale || cfg.Height != a.Height*a.Scale {
				t.Fatal("wrong image dimensions")
			}
			if view == "atlas" {
				if a.Stats.Generated != 0 || a.Stats.SolidShare != nil || a.Stats.Unreachable != nil {
					t.Fatal("atlas must only sample glimpses")
				}
			} else {
				total := 0.0
				for _, v := range a.Stats.GroundShare {
					total += v
				}
				if total < .99999 || total > 1.00001 {
					t.Fatalf("ground shares sum to %v", total)
				}
				if a.Stats.Generated != a.Stats.Chunks || a.Stats.SolidShare == nil || a.Stats.Unreachable == nil {
					t.Fatal("missing generation metrics")
				}
			}
			_, report, err := compare(a, b, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if report.(diffStats).Changed != 0 {
				t.Fatal("identical render has changed units")
			}
			if view == "atlas" {
				o.Overlays = "tiers,place-cells"
				overlaid, err := render(context.Background(), o)
				if err != nil {
					t.Fatal(err)
				}
				_, report, err := compare(a, overlaid, time.Second)
				if err != nil {
					t.Fatal(err)
				}
				if report.(diffStats).Changed != 0 {
					t.Fatal("overlays produced false changes")
				}
			}
		})
	}
}
func TestContentDiffAndIsolation(t *testing.T) {
	raw, err := content.FS.ReadFile("wilds.json")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	aPath, bPath := filepath.Join(dir, "a.json"), filepath.Join(dir, "b.json")
	if err := os.WriteFile(aPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	for _, land := range doc["lands"].([]any) {
		land.(map[string]any)["thicketPermille"] = 0
	}
	changed, err := json.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bPath, changed, 0600); err != nil {
		t.Fatal(err)
	}
	o := testOptions("region")
	o.Content = aPath
	o.Signatures = true
	a, err := worker(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	o.Content = bPath
	b, err := worker(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	_, report, err := compare(a, b, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if report.(diffStats).Changed == 0 {
		t.Fatal("content tuning did not change tiles")
	}
	o.Content = aPath
	c, err := worker(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(a.PNG, c.PNG) {
		t.Fatal("content B contaminated a later A render")
	}
	o.View = "atlas"
	o.Scale = 1
	a, err = worker(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	o.Seed = "another-world"
	b, err = worker(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	// Use a wider atlas to include land changes beyond footprint-owned cells.
	o.Rect = [4]int{-25, -30, 25, -1}
	aOpts := o
	aOpts.Seed = "lab-test"
	a, err = worker(context.Background(), aOpts)
	if err != nil {
		t.Fatal(err)
	}
	b, err = worker(context.Background(), o)
	if err != nil {
		t.Fatal(err)
	}
	_, report, err = compare(a, b, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if report.(diffStats).Changed == 0 {
		t.Fatal("seed diff did not change any glimpses")
	}
}
func TestReachAndLandRuns(t *testing.T) {
	w, h := 7, 7
	walk := make([]bool, w*h)
	valid := make([]bool, w*h)
	for i := range valid {
		valid[i] = true
	}
	walk[0] = true
	walk[1] = true
	walk[3*w+3] = true
	walk[3*w+4] = true
	img := image.NewRGBA(image.Rect(0, 0, w*4, h*4))
	if n := reach(img, walk, valid, w, h, 4, true); n != 2 {
		t.Fatalf("isolated tiles = %d, want 2", n)
	}
	valid[2*w+3] = false
	if n := reach(img, walk, valid, w, h, 4, false); n != 0 {
		t.Fatalf("fixed-ground boundary should excuse component, got %d", n)
	}
	if n := longestRun([]string{"a", "b", "a", "a", "b", "b", "a", "b", "a"}, 3, 3); n != 3 {
		t.Fatalf("axial run = %d", n)
	}
}
func TestLimits(t *testing.T) {
	for _, change := range []func(*options){func(o *options) { o.Rect = [4]int{1, 0, 0, 1} }, func(o *options) { o.Rect = [4]int{-100000, -100000, 100000, 100000} }, func(o *options) { o.Scale = 99 }, func(o *options) { o.Workers = 0 }, func(o *options) { o.Epoch = "t:2:1" }, func(o *options) { o.Overlays = "surprise" }, func(o *options) { o.Overlays = "solid" }} {
		o := testOptions("atlas")
		change(&o)
		if err := validate(o); err == nil {
			t.Fatalf("accepted invalid options: %+v", o)
		}
	}
	if err := serve("0.0.0.0:0", testOptions("atlas")); err == nil {
		t.Fatal("accepted external listener")
	}
}
func TestLocalViewer(t *testing.T) {
	raw, err := content.FS.ReadFile("wilds.json")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "wilds.json")
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	o := testOptions("atlas")
	o.Content = path
	h := handler(o)
	request := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRecorder()
		h.ServeHTTP(r, httptest.NewRequest("GET", path, nil))
		return r
	}
	if r := request("/"); r.Code != 200 || !strings.Contains(r.Body.String(), "Tile inspector") {
		t.Fatal("missing viewer")
	}
	before := request("/api/state").Body.String()
	if err := os.WriteFile(path, append(raw, '\n'), 0600); err != nil {
		t.Fatal(err)
	}
	if after := request("/api/state").Body.String(); before == after {
		t.Fatal("saved content did not change revision")
	}
	r := request("/api/render?view=region&rect=-4,-9,-4,-9&scale=1")
	if r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	var out result
	if err := json.Unmarshal(r.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	if _, err := png.DecodeConfig(bytes.NewReader(out.PNG)); err != nil {
		t.Fatal(err)
	}
	comparison := request("/api/render?view=atlas&rect=-10,-10,10,-1&scale=1&compare=1&seed-b=another")
	if comparison.Code != 200 {
		t.Fatal(comparison.Body.String())
	}
	var compared result
	if err := json.Unmarshal(comparison.Body.Bytes(), &compared); err != nil {
		t.Fatal(err)
	}
	if compared.Comparison == nil || compared.Comparison.B.Seed != "another" || len(compared.Signatures) != 0 {
		t.Fatal("invalid viewer comparison response")
	}
	r = request("/api/tile?rect=-4,-9,-4,-9&at=-73,-169")
	if r.Code != 200 {
		t.Fatal(r.Body.String())
	}
	var tile tileInfo
	if err := json.Unmarshal(r.Body.Bytes(), &tile); err != nil {
		t.Fatal(err)
	}
	if tile.Chunk != [2]int{-4, -8} || tile.Local != [2]int{23, 23} || tile.Ground == "" || tile.Land == "" {
		t.Fatalf("negative-coordinate inspector: %+v", tile)
	}
	if r := request("/api/render?rect=5,5,-5,-5"); r.Code != 400 {
		t.Fatal("bad rectangle not rejected")
	}
	req := httptest.NewRequest(http.MethodGet, "/api/state", nil)
	req.Header.Set("Origin", "https://unrelated.example")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 403 {
		t.Fatal("cross-origin request accepted")
	}
}
func TestCLIOutput(t *testing.T) {
	out := filepath.Join(t.TempDir(), "atlas.png")
	var stdout bytes.Buffer
	if err := run([]string{"atlas", "--content", "", "--rect=-2,-2,2,2", out}, &stdout); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(out + ".json"); err != nil {
		t.Fatal(err)
	}
	file, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	cfg, err := png.DecodeConfig(bytes.NewReader(file))
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Width != 5 || cfg.Height != 5 {
		t.Fatalf("inclusive rect gives %+v", cfg)
	}
	if err := run([]string{"atlas", "--content", "", "--rect=0,0,2,2", "--epoch=bad", out}, io.Discard); err == nil {
		t.Fatal("CLI accepted invalid epoch")
	}
}
