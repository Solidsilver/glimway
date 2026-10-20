// Worldlab is a standalone, database-free view of the wilderness generator.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"

	"glimway/content"
	"glimway/server/internal/wilds"
)

const defaultEpoch = "t:1795000000:1796209600"

type options struct {
	CompareSeed    string  `json:"compareSeed,omitempty"`
	CompareContent string  `json:"compareContent,omitempty"`
	Inspect        *[2]int `json:"inspect,omitempty"`
	View           string  `json:"view"`
	Seed           string  `json:"seed"`
	Epoch          string  `json:"epoch"`
	Rect           [4]int  `json:"rect"`
	Scale          int     `json:"scale"`
	Workers        int     `json:"workers"`
	Overlays       string  `json:"overlays"`
	Content        string  `json:"content,omitempty"`
	Raw            []byte  `json:"raw,omitempty"`
	Signatures     bool    `json:"signatures,omitempty"`
}

type result struct {
	Comparison *diffStats `json:"comparison,omitempty"`
	Tile       *tileInfo  `json:"tile,omitempty"`
	PNG        []byte     `json:"png"`
	Stats      stats      `json:"stats"`
	Signatures []uint64   `json:"signatures,omitempty"`
	Width      int        `json:"width"`
	Height     int        `json:"height"`
	Scale      int        `json:"scale"`
}

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
		var o options
		if err := json.NewDecoder(io.LimitReader(os.Stdin, 16<<20)).Decode(&o); err != nil {
			return err
		}
		if len(o.Raw) > 0 {
			if err := wilds.ConfigureForTools(o.Raw); err != nil {
				return err
			}
		}
		if err := validate(o); err != nil {
			return err
		}
		var r result
		var err error
		if o.Inspect != nil {
			r, err = inspect(o)
		} else {
			r, err = render(context.Background(), o)
		}
		if err != nil {
			return err
		}
		return json.NewEncoder(stdout).Encode(r)
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
	fs.StringVar(&o.Epoch, "epoch", defaultEpoch, "wick epoch t:<start>:<end>; still footprints use their own epoch")
	fs.StringVar(&rect, "rect", rect, "inclusive chunk rectangle x0,y0,x1,y1")
	fs.StringVar(&at, "at", at, "chunk coordinates cx,cy")
	fs.StringVar(&o.Overlays, "overlays", "", "comma-separated land-cells,place-cells,tiers,wend,road,rumours,frontier,solid,reach")
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
		output, report, err = compare(a, b, time.Since(started))
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

func coordinates(s string, n int) ([]int, error) {
	parts := strings.Split(s, ",")
	if len(parts) != n {
		return nil, fmt.Errorf("expected %d comma-separated coordinates", n)
	}
	out := make([]int, n)
	for i, p := range parts {
		v, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil || v < -100000 || v > 100000 {
			return nil, fmt.Errorf("coordinate %q must be an integer in -100000..100000", p)
		}
		out[i] = v
	}
	return out, nil
}

var overlayNames = []string{"land-cells", "place-cells", "tiers", "wend", "road", "rumours", "frontier", "solid", "reach"}

func enabled(o options, name string) bool {
	for _, s := range strings.Split(o.Overlays, ",") {
		if s == name {
			return true
		}
	}
	return false
}
func validate(o options) error {
	if o.View != "atlas" && o.View != "region" && o.View != "chunk" {
		return errors.New("view must be atlas, region, or chunk")
	}
	for _, v := range o.Rect {
		if v < -100000 || v > 100000 {
			return errors.New("coordinates must be in -100000..100000")
		}
	}
	w, h := o.Rect[2]-o.Rect[0]+1, o.Rect[3]-o.Rect[1]+1
	if w <= 0 || h <= 0 {
		return errors.New("rectangle must have x0 <= x1 and y0 <= y1")
	}
	if o.Workers < 1 || o.Workers > 8 {
		return errors.New("workers must be in 1..8")
	}
	if o.Scale < 1 || o.Scale > 8 {
		return errors.New("scale must be in 1..8")
	}
	if o.View == "chunk" && (w != 1 || h != 1) {
		return errors.New("chunk view needs exactly one chunk")
	}
	units := w * h
	limit := 1000000
	if o.View != "atlas" {
		units *= int(content.WildsRules.GetChunkSize()) * int(content.WildsRules.GetChunkSize())
		limit = 2400000
	}
	if units > limit || units*o.Scale*o.Scale > 16000000 {
		return errors.New("render too large: atlas <= 1M chunks, tiles <= 2.4M, scaled image <= 16M pixels")
	}
	if err := validateEpoch(o.Epoch); err != nil {
		return err
	}
	for _, s := range strings.Split(o.Overlays, ",") {
		if s == "" {
			continue
		}
		known := false
		for _, n := range overlayNames {
			if n == s {
				known = true
			}
		}
		if !known {
			return fmt.Errorf("unknown overlay %q", s)
		}
	}
	if o.View == "atlas" && (enabled(o, "solid") || enabled(o, "reach")) {
		return errors.New("solid and reach require generated tiles; use region or chunk")
	}
	return nil
}

// Each version lives in its own process; content-derived package globals are
// never mutated in the HTTP server or shared between comparison panels.
func worker(ctx context.Context, o options) (result, error) {
	var out result
	if o.Content != "" {
		raw, err := os.ReadFile(o.Content)
		if err != nil {
			return out, fmt.Errorf("content: %w (use --content '' for embedded rules)", err)
		}
		o.Raw = raw
	}
	input, err := json.Marshal(o)
	if err != nil {
		return out, err
	}
	exe, err := os.Executable()
	if err != nil {
		return out, err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, exe, "_worker")
	cmd.Stdin = bytes.NewReader(input)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	raw, err := cmd.Output()
	if err != nil {
		return out, fmt.Errorf("render: %w: %s", err, strings.TrimSpace(stderr.String()))
	}
	err = json.Unmarshal(raw, &out)
	return out, err
}

func validateEpoch(epoch string) error {
	parts := strings.Split(epoch, ":")
	if len(parts) != 3 || parts[0] != "t" {
		return errors.New("epoch must be t:<start>:<end>")
	}
	start, e1 := strconv.ParseInt(parts[1], 10, 64)
	end, e2 := strconv.ParseInt(parts[2], 10, 64)
	if e1 != nil || e2 != nil || end <= start {
		return errors.New("epoch needs integer timestamps with end > start")
	}
	return nil
}
