// Package worldlab renders the Wilds generator from a seed: an atlas (a
// pixel per chunk), a region (a pixel per tile), one chunk, and a diff of
// two seeds or two versions of content/wilds.json, with overlays and stats
// (docs/planning/wide-world/lab/README.md). The CLI (server/cmd/worldlab)
// and a dev build's server (Lab, /api/dev/worldlab/) both use it.
//
// A version of the rules other than the embedded ones is only ever loaded
// in a fresh worker process (Worker, RunWorker): wilds.ConfigureForTools
// rewrites package globals the generator reads, so it must never run in a
// process that serves the game.
package worldlab

import (
	"bytes"
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"glimway/content"
	"glimway/server/internal/wilds"
)

// DefaultEpoch is a reproducible wick season.
const DefaultEpoch = "t:1795000000:1796209600"

// Coordinate bounds keep generator arithmetic and allocations reasonable.
const MaxCoordinate = 100000

// Limits on one render: atlas chunks, tiles in tile views, scaled pixels.
const (
	MaxAtlasChunks = 1000000
	MaxTiles       = 2400000
	MaxPixels      = 16000000
)

// OverlayNames are the overlays, in the order the CLI lists them.
var OverlayNames = []string{"land-cells", "place-cells", "tiers", "wend", "road", "rumours", "border", "solid", "reach", "regions", "biomes", "blend", "pins"}

// Options is one render or inspection. Raw, when set, is the wilds rules a
// worker installs before it starts; Content names where they came from.
type Options struct {
	// Walk: the walk lab's window (walk.go) instead of a picture.
	Walk           bool    `json:"walk,omitempty"`
	Terrain        string  `json:"terrain,omitempty"`
	Slopes         string  `json:"slopes,omitempty"` // height, kinds, routes, reach, tunnels
	TerrainSamples int     `json:"terrainSamples,omitempty"`
	TerrainOrder   uint64  `json:"terrainOrder,omitempty"`
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
	Field          string  `json:"field,omitempty"`
	Content        string  `json:"content,omitempty"`
	Raw            []byte  `json:"raw,omitempty"`
	Signatures     bool    `json:"signatures,omitempty"`
}

// Result is a render (PNG and stats together, so an image and its
// measurements are atomic) or an inspection (Tile).
type Result struct {
	Comparison *DiffStats   `json:"comparison,omitempty"`
	Walk       *TerrainWalk `json:"walk,omitempty"`
	Tile       *TileInfo    `json:"tile,omitempty"`
	PNG        []byte       `json:"png"`
	Stats      Stats        `json:"stats"`
	Signatures []uint64     `json:"signatures,omitempty"`
	Width      int          `json:"width"`
	Height     int          `json:"height"`
	Scale      int          `json:"scale"`
}

// Coordinates parses n comma-separated integers within MaxCoordinate.
func Coordinates(s string, n int) ([]int, error) {
	parts := strings.Split(s, ",")
	if len(parts) != n {
		return nil, fmt.Errorf("expected %d comma-separated coordinates", n)
	}
	out := make([]int, n)
	for i, p := range parts {
		v, err := strconv.Atoi(strings.TrimSpace(p))
		if err != nil || v < -MaxCoordinate || v > MaxCoordinate {
			return nil, fmt.Errorf("coordinate %q must be an integer in -100000..100000", p)
		}
		out[i] = v
	}
	return out, nil
}

func enabled(o Options, name string) bool {
	for _, s := range strings.Split(o.Overlays, ",") {
		if s == name {
			return true
		}
	}
	return false
}

// Validate refuses a render outside the limits, before any work.
func Validate(o Options) error {
	if o.Slopes != "" {
		if len(o.Raw) > 0 && !bytes.Equal(o.Raw, embeddedRules()) {
			return errors.New("slopes uses embedded rules")
		}
		if o.Walk || o.Terrain != "" || o.Inspect != nil || o.Signatures || o.Field != "" || o.Overlays != "" || o.CompareSeed != "" || o.CompareContent != "" {
			return errors.New("slopes takes its own diagnostic view, seed and crop")
		}
		if o.View != "region" && o.View != "atlas" {
			return errors.New("slopes requires region or atlas view")
		}
		if o.Slopes != "height" && o.Slopes != "kinds" && o.Slopes != "routes" && o.Slopes != "reach" && o.Slopes != "tunnels" {
			return errors.New("slopes must be height, kinds, routes, reach or tunnels")
		}
		if o.Rect[0] < -24 || o.Rect[1] < -24 || o.Rect[2] > 23 || o.Rect[3] > 23 {
			return errors.New("slopes crop must be inside its certified -24..23 chunk domain")
		}
	}
	if o.Walk {
		// A fixed window with the embedded rules: only the seed and season vary.
		if o.Terrain != "" || o.Inspect != nil || len(o.Raw) > 0 {
			return errors.New("the walk takes only a seed and an epoch")
		}
		if len(o.Seed) == 0 || len(o.Seed) > 200 {
			return errors.New("seed must be 1..200 characters")
		}
		return ValidateEpoch(o.Epoch)
	}
	if o.Terrain != "" {
		if o.Terrain != "region" && o.Terrain != "chunk" {
			return errors.New("terrain must be region or chunk")
		}
		if o.View != "region" || o.Inspect != nil {
			return errors.New("terrain spike requires region view and has no live-world tile inspection")
		}
		if o.TerrainSamples < 0 || o.TerrainSamples > 20 {
			return errors.New("terrain samples must be in 0..20")
		}
	}
	if o.View != "atlas" && o.View != "region" && o.View != "chunk" {
		return errors.New("view must be atlas, region, or chunk")
	}
	for _, v := range o.Rect {
		if v < -MaxCoordinate || v > MaxCoordinate {
			return errors.New("coordinates must be in -100000..100000")
		}
	}
	if o.Inspect != nil {
		for _, v := range o.Inspect {
			if v < -MaxCoordinate*64 || v > MaxCoordinate*64 {
				return errors.New("tile coordinates out of range")
			}
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
	limit := MaxAtlasChunks
	if o.View != "atlas" {
		size := int(content.WildsRules.GetChunkSize())
		if o.Terrain != "" || o.Slopes != "" {
			size = wilds.TerrainChunkSize
		}
		units *= size * size
		limit = MaxTiles
	}
	if units > limit || units*o.Scale*o.Scale > MaxPixels {
		return errors.New("render too large: atlas <= 1M chunks, tiles <= 2.4M, scaled image <= 16M pixels")
	}
	if err := ValidateEpoch(o.Epoch); err != nil {
		return err
	}
	if len(o.Seed) == 0 || len(o.Seed) > 200 {
		return errors.New("seed must be 1..200 characters")
	}
	if err := validateFieldOption(o); err != nil {
		return err
	}
	for _, s := range strings.Split(o.Overlays, ",") {
		if s == "" {
			continue
		}
		if !isKnownOverlay(s) {
			return fmt.Errorf("unknown overlay %q", s)
		}
	}
	if o.View == "atlas" && (enabled(o, "solid") || enabled(o, "reach")) {
		return errors.New("solid and reach require generated tiles; use region or chunk")
	}
	return nil
}

// ValidateEpoch accepts a wick season t:<start>:<end>.
func ValidateEpoch(epoch string) error {
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

// TileInfo is what one tile holds, and the nearest open tile in its chunk
// to stand on (Stand; nil when the chunk has none or is authored ground).
type TileInfo struct {
	Tile            [2]int            `json:"tile"`
	Chunk           [2]int            `json:"chunk"`
	Local           [2]int            `json:"local"`
	Epoch           wilds.Epoch       `json:"epoch"`
	Region          string            `json:"region,omitempty"`
	RegionCoord     [2]int            `json:"regionCoord,omitempty"`
	Biome           string            `json:"biome,omitempty"`
	RegionBiome     string            `json:"regionBiome,omitempty"`
	SecondaryRegion string            `json:"secondaryRegion,omitempty"`
	SecondaryBiome  string            `json:"secondaryBiome,omitempty"`
	BorderDistTiles int               `json:"borderDistTiles"`
	InBlendBand     bool              `json:"inBlendBand,omitempty"`
	TripleJunction  bool              `json:"tripleJunction,omitempty"`
	Blended         bool              `json:"blended,omitempty"`
	Pin             *wilds.RegionPin  `json:"pin,omitempty"`
	Fields          *wilds.Fields     `json:"fields,omitempty"`
	Land            string            `json:"land"`
	ChunkLand       string            `json:"chunkLand"`
	Ground          string            `json:"ground"`
	Solid           bool              `json:"solid"`
	Entities        []wilds.Entity    `json:"entitiesOnTile"`
	ChunkEntities   []wilds.Entity    `json:"chunkEntities"`
	Sites           []wilds.Site      `json:"sitesOnTile"`
	Places          []wilds.PlaceMark `json:"placesOnTile"`
	Fixed           string            `json:"fixed,omitempty"`
	Stand           *[2]int           `json:"stand,omitempty"`
	// OnGrid: the caller's world lets a hero stand in this chunk (the lab
	// sets it from the world border (location.OnGrid); a worker never does).
	OnGrid *bool `json:"onGrid,omitempty"`
}

// Inspect reads one tile (o.Inspect, world tile coordinates).
func Inspect(o Options) (Result, error) {
	tx, ty := o.Inspect[0], o.Inspect[1]
	cx, cy := wilds.ChunkOf(tx, ty)
	lx, ly := wilds.LocalOf(tx, ty)
	info := &TileInfo{Tile: *o.Inspect, Chunk: [2]int{cx, cy}, Local: [2]int{lx, ly}, Epoch: epoch(o, cx, cy), Entities: []wilds.Entity{}, Sites: []wilds.Site{}, Places: []wilds.PlaceMark{}}
	if p := wilds.FixedFootprintAt(cx, cy); p != nil {
		info.Fixed = p.GetId()
		enrichTileInfo(o.Seed, info)
		return Result{Tile: info}, nil
	}
	c, err := wilds.GenerateV3(info.Epoch, cx, cy, nil)
	if err != nil {
		return Result{}, err
	}
	info.Land = wilds.LandAt(wilds.WickEpoch(o.Seed, o.Epoch), tx, ty)
	info.ChunkLand = c.Land
	baseGround := content.WildsRules.Grounds[int(c.Ground[ly*c.Size+lx])].GetId()
	surface := content.WildsRules.Grounds[int(c.Ground[ly*c.Size+lx])].GetSurface()
	thicket := landThicketPermille(info.Land)
	enrichTileInfo(o.Seed, info)
	groundID, _, solid, _ := wilds.BiomeTileLook(o.Seed, tx, ty, baseGround, c.Solid[ly*c.Size+lx], surface, thicket, nil)
	info.Ground = groundID
	info.Solid = solid
	info.ChunkEntities = c.Entities
	for _, e := range c.Entities {
		if e.TX == lx && e.TY == ly {
			info.Entities = append(info.Entities, e)
		}
	}
	for _, s := range c.Sites {
		if s.TX == lx && s.TY == ly {
			info.Sites = append(info.Sites, s)
		}
	}
	for _, p := range c.Places {
		if p.TX == lx && p.TY == ly {
			info.Places = append(info.Places, p)
		}
	}
	best := -1
	for i, solid := range c.Solid {
		if solid {
			continue
		}
		dx, dy := i%c.Size-lx, i/c.Size-ly
		if d := dx*dx + dy*dy; best < 0 || d < best {
			best = d
			info.Stand = &[2]int{tx + dx, ty + dy}
		}
	}
	return Result{Tile: info}, nil
}

// RunWorker is a worker process's whole life: read one Options, install
// its rules if it brings any, render or inspect, and write the Result.
func RunWorker(stdin io.Reader, stdout io.Writer) error {
	var o Options
	if err := json.NewDecoder(io.LimitReader(stdin, 16<<20)).Decode(&o); err != nil {
		return err
	}
	if len(o.Raw) > 0 {
		if err := wilds.ConfigureForTools(o.Raw); err != nil {
			return err
		}
	}
	if err := Validate(o); err != nil {
		return err
	}
	var r Result
	var err error
	if o.Inspect != nil {
		r, err = Inspect(o)
	} else {
		r, err = Render(context.Background(), o)
	}
	if err != nil {
		return err
	}
	return json.NewEncoder(stdout).Encode(r)
}

// Worker runs one render in a fresh process: Argv re-executes a binary
// whose entry calls RunWorker. Nice > 0 lowers its priority before it
// reads its work; Env is added to the parent's.
type Worker struct {
	Argv    []string
	Nice    int
	Env     []string
	Timeout time.Duration
}

// Run renders o in a fresh process. An abandoned ctx kills it.
func (wk Worker) Run(ctx context.Context, o Options) (Result, error) {
	var out Result
	input, err := json.Marshal(o)
	if err != nil {
		return out, err
	}
	if wk.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, wk.Timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, wk.Argv[0], wk.Argv[1:]...)
	if len(wk.Env) > 0 {
		cmd.Env = append(cmd.Environ(), wk.Env...)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return out, err
	}
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if wk.Nice > 0 {
		ownGroup(cmd)
	}
	if err = cmd.Start(); err != nil {
		return out, err
	}
	if wk.Nice > 0 {
		lower(cmd.Process.Pid, wk.Nice)
	}
	_, werr := stdin.Write(input)
	stdin.Close()
	if err = cmd.Wait(); err != nil {
		if ctx.Err() != nil {
			return out, fmt.Errorf("render stopped: %w", ctx.Err())
		}
		return out, fmt.Errorf("render: %s", cmp.Or(strings.TrimSpace(stderr.String()), err.Error()))
	}
	if werr != nil {
		return out, werr
	}
	err = json.Unmarshal(stdout.Bytes(), &out)
	return out, err
}
