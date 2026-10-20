package worldlab

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"testing"
	"time"
)

func testOptions(view string) Options {
	return Options{View: view, Seed: "lab-test", Epoch: DefaultEpoch, Rect: [4]int{-5, -9, -3, -7}, Scale: 1, Workers: 2}
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
			a, err := Render(context.Background(), o)
			if err != nil {
				t.Fatal(err)
			}
			o.Workers = 1
			b, err := Render(context.Background(), o)
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
			_, report, err := Compare(a, b, time.Second)
			if err != nil {
				t.Fatal(err)
			}
			if report.Changed != 0 {
				t.Fatal("identical render has changed units")
			}
			if view == "atlas" {
				o.Overlays = "tiers,place-cells"
				overlaid, err := Render(context.Background(), o)
				if err != nil {
					t.Fatal(err)
				}
				_, report, err := Compare(a, overlaid, time.Second)
				if err != nil {
					t.Fatal(err)
				}
				if report.Changed != 0 {
					t.Fatal("overlays produced false changes")
				}
			}
		})
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
	for _, change := range []func(*Options){func(o *Options) { o.Rect = [4]int{1, 0, 0, 1} }, func(o *Options) { o.Rect = [4]int{-100000, -100000, 100000, 100000} }, func(o *Options) { o.Scale = 99 }, func(o *Options) { o.Workers = 0 }, func(o *Options) { o.Epoch = "t:2:1" }, func(o *Options) { o.Overlays = "surprise" }, func(o *Options) { o.Overlays = "solid" }} {
		o := testOptions("atlas")
		change(&o)
		if err := Validate(o); err == nil {
			t.Fatalf("accepted invalid Options: %+v", o)
		}
	}
}
