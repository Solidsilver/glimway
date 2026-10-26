// Worldlab is a standalone, database-free view of the wilderness generator
// (server/internal/worldlab; docs/planning/wide-world/lab/README.md).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"
	"time"

	"glimway/server/internal/worldlab"
)

const defaultEpoch = worldlab.DefaultEpoch

type (
	options   = worldlab.Options
	result    = worldlab.Result
	diffStats = worldlab.DiffStats
	tileInfo  = worldlab.TileInfo
)

var (
	overlayNames = worldlab.OverlayNames
	coordinates  = worldlab.Coordinates
	validate     = worldlab.Validate
)

func main() {
	if err := run(os.Args[1:], os.Stdout); err != nil {
		fmt.Fprintln(os.Stderr, "worldlab:", err)
		os.Exit(1)
	}
}

func run(args []string, stdout io.Writer) error {
	if len(args) == 0 {
		return errors.New("usage: worldlab atlas|region|chunk|diff|serve [flags] [out.png]; use <command> -h for flags")
	}
	if args[0] == "_worker" {
		return worldlab.RunWorker(os.Stdin, stdout)
	}
	command := args[0]
	if command != "atlas" && command != "region" && command != "chunk" && command != "diff" && command != "serve" {
		return fmt.Errorf("unknown command %q", command)
	}
	fs := flag.NewFlagSet(command, flag.ContinueOnError)
	fs.SetOutput(stdout)
	o := options{View: command}
	rect, at, seedB, contentB, view, addr := "-20,-30,20,0", "0,0", "", "", "region", "127.0.0.1:8099"
	fs.StringVar(&o.Seed, "seed", "map", "world seed")
	fs.StringVar(&o.Terrain, "terrain", "", "lab-only ridge access strategy: region or chunk (region view)")
	fs.StringVar(&o.SlopeRecipe, "slope-recipe", "", "slope recipe: slopes-gen@1 (default) or slopes-gen@2")
	fs.StringVar(&o.Slopes, "slopes", "", "lab-only slopes view: height, kinds, routes, reach, tunnels (-24..23 chunks)")
	fs.IntVar(&o.TerrainSamples, "terrain-samples", 1, "cold plan samples per strategy (1..20)")
	fs.Uint64Var(&o.TerrainOrder, "terrain-order", 0, "chunk shuffle seed for independent generation and seam checks")
	fs.StringVar(&o.Epoch, "epoch", defaultEpoch, "wick epoch t:<start>:<end>; still footprints use their own epoch")
	fs.StringVar(&rect, "rect", rect, "inclusive chunk rectangle x0,y0,x1,y1")
	fs.StringVar(&at, "at", at, "chunk coordinates cx,cy")
	fs.StringVar(&o.Overlays, "overlays", "", "comma-separated land-cells,place-cells,tiers,wend,road,rumours,border,solid,reach,regions,biomes,blend,pins")
	fs.StringVar(&o.Field, "field", "", "field heatmap selector: upland,relief,wetness,warmth,quiet")
	for _, name := range overlayNames {
		fs.Bool(name, false, "enable the "+name+" overlay")
	}
	fs.IntVar(&o.Scale, "scale", 0, "pixels per chunk (atlas) or tile; default atlas/region 1, chunk 4")
	fs.IntVar(&o.Workers, "workers", min(4, runtime.GOMAXPROCS(0)), "parallel chunk workers (1..8)")
	fs.StringVar(&o.Content, "content", "content/wilds.json", "wilds content file; empty uses embedded rules")
	fs.StringVar(&seedB, "seed-b", "", "second seed for diff (default same seed)")
	fs.StringVar(&contentB, "content-b", "", "second wilds content file for diff")
	fs.StringVar(&view, "view", view, "diff view: atlas, region, chunk")
	fs.StringVar(&addr, "addr", addr, "serve address (loopback only)")
	if err := fs.Parse(args[1:]); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return nil
		}
		return err
	}
	fs.Visit(func(f *flag.Flag) {
		for _, name := range overlayNames {
			if f.Name == name && f.Value.String() == "true" {
				if o.Overlays != "" {
					o.Overlays += ","
				}
				o.Overlays += name
			}
		}
	})
	if command == "serve" {
		if fs.NArg() != 0 {
			return errors.New("serve takes no output path")
		}
		o.CompareSeed = seedB
		o.CompareContent = contentB
		return serve(addr, o)
	}
	if fs.NArg() != 1 {
		return errors.New("provide one output PNG path after all flags")
	}
	if command == "diff" {
		if o.Slopes != "" {
			return errors.New("slopes supplies its own diagnostic views; use region or atlas")
		}
		o.View = view
	}
	nums, err := coordinates(rect, 4)
	if err != nil {
		return err
	}
	copy(o.Rect[:], nums)
	if o.View == "chunk" {
		nums, err = coordinates(at, 2)
		if err != nil {
			return err
		}
		o.Rect = [4]int{nums[0], nums[1], nums[0], nums[1]}
	}
	if o.Scale == 0 {
		o.Scale = 1
		if o.View == "chunk" {
			o.Scale = 4
		}
	}
	if err := validate(o); err != nil {
		return err
	}
	if command == "diff" {
		o.Signatures = true
	}
	started := time.Now()
	a, err := worker(context.Background(), o)
	if err != nil {
		return err
	}
	var report any = a.Stats
	output := a.PNG
	if command == "diff" {
		bOpts := o
		if seedB != "" {
			bOpts.Seed = seedB
		}
		if contentB != "" {
			bOpts.Content = contentB
		}
		b, err := worker(context.Background(), bOpts)
		if err != nil {
			return err
		}
		var details diffStats
		output, details, err = worldlab.Compare(a, b, time.Since(started))
		report = details
		if err != nil {
			return err
		}
	}
	out := fs.Arg(0)
	if err := os.WriteFile(out, output, 0644); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(report, "", "  ")
	if err != nil {
		return err
	}
	if err := os.WriteFile(out+".json", append(raw, '\n'), 0644); err != nil {
		return err
	}
	_, err = fmt.Fprintln(stdout, string(raw))
	return err
}

// Each version lives in its own process; content-derived package globals are
// never mutated in the HTTP server or shared between comparison panels.
func worker(ctx context.Context, o options) (result, error) {
	if o.Content != "" {
		raw, err := os.ReadFile(o.Content)
		if err != nil {
			return result{}, fmt.Errorf("content: %w (use --content '' for embedded rules)", err)
		}
		o.Raw = raw
	}
	exe, err := os.Executable()
	if err != nil {
		return result{}, err
	}
	return worldlab.Worker{Argv: []string{exe, "_worker"}, Timeout: 2 * time.Minute}.Run(ctx, o)
}
