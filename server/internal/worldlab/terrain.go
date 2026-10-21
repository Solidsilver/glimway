package worldlab

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"math/rand/v2"
	"slices"
	"time"

	"glimway/server/internal/wilds"
	"google.golang.org/protobuf/proto"
)

type TerrainDistribution struct {
	P50 float64 `json:"p50"`
	P95 float64 `json:"p95"`
	Max float64 `json:"max"`
}

func terrainDistribution(values []float64) TerrainDistribution {
	slices.Sort(values)
	at := func(p int) float64 { return values[max(0, (len(values)*p+99)/100-1)] }
	return TerrainDistribution{at(50), at(95), values[len(values)-1]}
}

type TerrainStranded struct {
	Tiles  int    `json:"tiles"`
	Bounds [4]int `json:"tileBounds"`
}
type TerrainStrategyMetrics struct {
	ColdPlanMS         TerrainDistribution      `json:"coldPlanMs"`
	WarmChunkMS        TerrainDistribution      `json:"warmChunkMs"`
	HeightBytes        TerrainDistribution      `json:"encodedHeightBytes"`
	WholeChunkBytes    TerrainDistribution      `json:"bareWholeChunkBytes"`
	PlanBytes          int                      `json:"planStorageBytes"`
	SnapshotBytes      int                      `json:"encodedSnapshotBytes"`
	ConstraintBytes    int                      `json:"constraintManifestBytes"`
	Ramps              int                      `json:"ramps"`
	RejectedFloorTiles int                      `json:"rejectedOptionalFloorTiles"`
	Certificate        wilds.TerrainCertificate `json:"certificate"`
	Stranded           []TerrainStranded        `json:"stranded"`
	SeamMismatches     int                      `json:"mismatchedSeamTiles"`
	Digest             string                   `json:"geometrySHA256"`
	SeamEdgesCompared  int                      `json:"seamEdgesCompared"`
	SeamEdgeMismatches int                      `json:"mismatchedSeamEdges"`
}
type TerrainMetrics struct {
	Recipe     string                            `json:"recipe"`
	Seed       string                            `json:"seed"`
	FieldSeed  uint32                            `json:"fieldSeed"`
	Samples    int                               `json:"coldSamples"`
	Order      uint64                            `json:"shuffleSeed"`
	Strategies map[string]TerrainStrategyMetrics `json:"strategies"`
	Anchors    []wilds.TerrainAnchor             `json:"anchors"`
	Note       string                            `json:"note"`
}

func terrainMeasure(ctx context.Context, o Options) (map[string]*wilds.TerrainPlan, *TerrainMetrics, error) {
	f := wilds.TerrainRidge{Seed: wilds.Fnv1a32(o.Seed)}
	report := &TerrainMetrics{Recipe: "ridge-access-spike@1", Seed: o.Seed, FieldSeed: f.Seed, Samples: max(1, o.TerrainSamples), Order: o.TerrainOrder, Strategies: map[string]TerrainStrategyMetrics{}, Note: "Finite 20x8 chunk access domain; crop boundaries do not certify home. Local repair keeps a two-tile rim, never demotes boundary ground, and may fail closed. Corner bowl is an adversarial fixture, not prevalence evidence. Warm region = clip+encode; warm chunk = independent local sampling+repair+encode; decode excluded. Bare whole chunk = actual undressed flat-palette WorldChunk protobuf + lab height envelope (length prefix); no decor/entities/biome overhead. Storage is a reconstructible encoded plan, not Go heap. Hero 10x4 px foot box can follow every cardinal tile-centre edge; mount clearance is not certified."}
	plans := map[string]*wilds.TerrainPlan{}
	for _, strategy := range []string{"region", "chunk"} {
		var p *wilds.TerrainPlan
		var cold []float64
		for range report.Samples {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
			start := time.Now()
			var err error
			p, err = wilds.NewTerrainSpike(f, strategy)
			if err != nil {
				return nil, nil, err
			}
			cold = append(cold, float64(time.Since(start).Nanoseconds())/1e6)
		}
		plans[strategy] = p
		m := TerrainStrategyMetrics{ColdPlanMS: terrainDistribution(cold), Ramps: p.Ramps, Certificate: p.Certificate()}
		m.RejectedFloorTiles = p.RejectedFloorTiles
		// Reconstruct independently in shuffled order, decode, and compare every
		// tile (including both sides of all chunk seams) to the cold assembly.
		order := rand.New(rand.NewPCG(o.TerrainOrder+1, o.TerrainOrder+7)).Perm(160)
		chunks := make([][]byte, 160)
		var warm, heights, whole []float64
		for _, id := range order {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
			cx, cy := id%20, id/20
			start := time.Now()
			tiles, err := wilds.GenerateTerrainChunk(f, p, cx, cy, strategy)
			if err != nil {
				return nil, nil, err
			}
			raw := wilds.EncodeTerrainHeight(tiles)
			warm = append(warm, float64(time.Since(start).Nanoseconds())/1e6)
			decoded, err := wilds.DecodeTerrainHeight(raw)
			if err != nil {
				return nil, nil, err
			}
			want, _ := p.Chunk(cx, cy)
			for i, t := range decoded {
				for d := 0; d < 4; d++ {
					seam := d == 0 && cy > 0 && i/24 == 0 || d == 1 && cx < 19 && i%24 == 23 || d == 2 && cy < 7 && i/24 == 23 || d == 3 && cx > 0 && i%24 == 0
					if seam {
						m.SeamEdgesCompared++
						if t.Edges[d] != want[i].Edges[d] {
							m.SeamEdgeMismatches++
						}
					}
				}
				if t != want[i] {
					if i%24 == 0 || i%24 == 23 || i/24 == 0 || i/24 == 23 {
						m.SeamMismatches++
					} else {
						return nil, nil, fmt.Errorf("order-dependent interior at %d,%d tile %d", cx, cy, i)
					}
				}
			}
			chunks[id] = raw
			heights = append(heights, float64(len(raw)))
			c := wilds.Chunk{CX: cx, CY: cy, Size: 24, GeneratorVersion: 3, Ground: make([]wilds.Ground, 576), Solid: make([]bool, 576), Land: "terrain-spike"}
			for i, t := range tiles {
				c.Solid[i] = !wilds.TerrainWalkable(t)
			}
			whole = append(whole, float64(proto.Size(wilds.ToProto(c, DefaultEpoch))+len(raw)+4))
		}
		hash := sha256.New()
		for _, raw := range chunks {
			hash.Write(raw)
			m.PlanBytes += len(raw) + 4
		}
		manifest, _ := json.Marshal(struct {
			Recipe  string
			Seed    uint32
			Anchors []wilds.TerrainAnchor
			Exits   []wilds.TerrainExit
		}{report.Recipe, f.Seed, p.Anchors, p.HeldExits})
		hash.Write(manifest)
		m.PlanBytes += len(manifest)
		m.Digest = hex.EncodeToString(hash.Sum(nil))
		m.SnapshotBytes = m.PlanBytes
		m.ConstraintBytes = len(manifest)
		if strategy == "chunk" {
			m.PlanBytes = 0
		}
		m.WarmChunkMS = terrainDistribution(warm)
		m.HeightBytes = terrainDistribution(heights)
		m.WholeChunkBytes = terrainDistribution(whole)
		components := map[int]*TerrainStranded{}
		for i, label := range m.Certificate.Labels {
			if label < 0 || label == m.Certificate.Home {
				continue
			}
			s := components[label]
			x, y := i%p.W, i/p.W
			if s == nil {
				s = &TerrainStranded{Bounds: [4]int{x, y, x, y}}
				components[label] = s
			}
			s.Tiles++
			s.Bounds = [4]int{min(s.Bounds[0], x), min(s.Bounds[1], y), max(s.Bounds[2], x), max(s.Bounds[3], y)}
		}
		for id := 0; id < m.Certificate.Components; id++ {
			if s := components[id]; s != nil {
				m.Stranded = append(m.Stranded, *s)
			}
		}
		report.Strategies[strategy] = m
	}
	report.Anchors = plans["region"].Anchors
	return plans, report, nil
}

func renderTerrain(ctx context.Context, o Options) (Result, error) {
	start := time.Now()
	plans, report, err := terrainMeasure(ctx, o)
	if err != nil {
		return Result{}, err
	}
	p := plans[o.Terrain]
	c := p.Certificate()
	w, h := (o.Rect[2]-o.Rect[0]+1)*24, (o.Rect[3]-o.Rect[1]+1)*24
	img := image.NewRGBA(image.Rect(0, 0, w*o.Scale, h*o.Scale))
	res := Result{Width: w, Height: h, Scale: o.Scale}
	if o.Signatures {
		res.Signatures = make([]uint64, w*h)
	}
	levels := []color.RGBA{{103, 137, 91, 255}, {156, 169, 101, 255}, {178, 160, 126, 255}, {211, 204, 184, 255}}
	for yy := 0; yy < h; yy++ {
		for xx := 0; xx < w; xx++ {
			x, y := o.Rect[0]*24+xx, o.Rect[1]*24+yy
			col := color.RGBA{100, 105, 114, 255}
			if x >= 0 && y >= 0 && x < p.W && y < p.H {
				i := y*p.W + x
				t := p.Tiles[i]
				col = levels[t.Top]
				if t.Kind == wilds.TerrainFace {
					col = color.RGBA{uint8(64 + int(t.FaceRow)*5), 58, 65, 255}
				}
				if enabled(o, "reach") && wilds.TerrainWalkable(t) {
					col = color.RGBA{62, 177, 101, 255}
					if c.Labels[i] != c.Home {
						col = color.RGBA{230, 40, 190, 255}
					}
				}
				if t.Kind == wilds.TerrainRamp && !enabled(o, "reach") {
					col = color.RGBA{215, 132, 52, 255}
					if t.Built {
						col = color.RGBA{229, 200, 123, 255}
					}
				}
				if t.Protected {
					col = blend(col, color.RGBA{90, 182, 235, 255})
				}
				if t.Kind == wilds.TerrainRock {
					col = color.RGBA{89, 88, 84, 255}
				}
				if t.Route && enabled(o, "road") {
					col = color.RGBA{255, 229, 86, 255}
				}
				if res.Signatures != nil {
					res.Signatures[yy*w+xx] = uint64(t.Top) | uint64(t.Kind)<<2
					for _, q := range t.Edges {
						res.Signatures[yy*w+xx] = res.Signatures[yy*w+xx]*1009 + uint64(q+1)
					}
				}
			}
			block(img, xx*o.Scale, yy*o.Scale, o.Scale, col)
			if enabled(o, "land-cells") {
				grid := color.RGBA{96, 132, 152, 255}
				for k := 0; k < o.Scale; k++ {
					if x%24 == 0 {
						img.SetRGBA(xx*o.Scale, yy*o.Scale+k, grid)
					}
					if y%24 == 0 {
						img.SetRGBA(xx*o.Scale+k, yy*o.Scale, grid)
					}
				}
			}
			// North/east/west mismatched open edges are intentional rims, not
			// seam errors. Show them even when neither tile is a south face.
			if o.Scale >= 3 && x >= 0 && y >= 0 && x < p.W && y < p.H {
				i := y*p.W + x
				if wilds.TerrainWalkable(p.Tiles[i]) {
					for _, d := range []int{0, 1, 3} {
						if p.Step(i, d) >= 0 {
							continue
						}
						for k := 0; k < o.Scale; k++ {
							px, py := xx*o.Scale+k, yy*o.Scale
							if d == 1 {
								px, py = (xx+1)*o.Scale-1, yy*o.Scale+k
							}
							if d == 3 {
								px, py = xx*o.Scale, yy*o.Scale+k
							}
							img.SetRGBA(px, py, color.RGBA{38, 38, 45, 255})
						}
					}
				}
			}
		}
	}
	for _, a := range p.Anchors {
		cross(img, (a.X-o.Rect[0]*24)*o.Scale+o.Scale/2, (a.Y-o.Rect[1]*24)*o.Scale+o.Scale/2, max(2, o.Scale), color.RGBA{255, 255, 255, 255})
	}
	var buf bytes.Buffer
	if err := png.Encode(&buf, img); err != nil {
		return Result{}, err
	}
	res.PNG = buf.Bytes()
	u := c.StrandedTiles
	res.Stats = Stats{View: "region", Seed: o.Seed, Epoch: o.Epoch, Rect: o.Rect, ChunkSize: 24, Chunks: w * h / 576, Generated: 160, LandShare: map[string]float64{}, Unreachable: &u, Milliseconds: float64(time.Since(start).Milliseconds()), Terrain: report, Note: "Terrain spike: " + o.Terrain + ". Levels green/tan/ivory, faces dark, built ramps gold, rough orange, protected cyan, anchors white. Road overlay = realized saddle/end routes. Reach = home green, stranded magenta, outside the access domain grey. Metrics always cover the full 20x8 region, even when cropped. " + report.Note}
	return res, nil
}
