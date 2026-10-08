package wilds

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"slices"
	"sort"
	"strings"
	"testing"
	"time"

	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"google.golang.org/protobuf/proto"
)

// epochID is as long as a real one (store.Random: 64 hex characters).
var epochID = strings.Repeat("0", 64)

// encodeChunk is the stored and served bytes: the real WildsChunk message
// (entities included).
func encodeChunk(c Chunk) []byte {
	b, err := proto.Marshal(ToProto(c, epochID))
	if err != nil {
		panic(err)
	}
	return b
}

// TestProtoRoundTrip: every chunk passes lane A's validator after a binary
// round trip, and unpacks back to the generator's grids, decor and bodies.
func TestProtoRoundTrip(t *testing.T) {
	for _, e := range append(goldenEpochs(), invariantEpochs()[:10]...) {
		for _, c := range mustRegion(t, e).Chunks {
			var m contract.WildsChunk
			if err := proto.Unmarshal(encodeChunk(c), &m); err != nil {
				t.Fatal(err)
			}
			if err := chunks.Validate(&m); err != nil {
				t.Fatalf("%s %s %d,%d: %v", e.WorldSeed, e.RegionID, c.CX, c.CY, err)
			}
			for i := range c.Ground {
				g := m.Ground[i/2] >> (4 * (i % 2)) & 15
				if m.Palette[g] != c.Ground[i].String() || Walkable(&m, i%c.Size, i/c.Size) == c.Solid[i] {
					t.Fatalf("cell %d differs", i)
				}
			}
			d := m.Decor
			for i, p := range c.Decor {
				flags := d.Flags[i/4] >> (2 * (i % 4))
				if d.Kinds[d.Kind[i]] != p.Kind.String() || int(d.Tx[i]) != p.TX || int(d.Ty[i]) != p.TY || int(d.Ox[i]) != p.OX || int(d.Oy[i]) != p.OY ||
					int(d.Variant[i]) != p.Variant || (flags&1 == 1) != p.Flip || (flags&2 == 2) != p.Overhang {
					t.Fatalf("decor %d differs", i)
				}
			}
			for i, en := range c.Entities {
				back := EntityFromProto(m.Entities[i])
				if back.ID != en.ID || back.TX != en.TX || back.Tier != en.Tier || back.POI != en.POI || back.Material != en.Material || !slices.Equal(back.Enemies, en.Enemies) {
					t.Fatalf("entity %s differs", en.ID)
				}
			}
		}
	}
}

func gzipped(b []byte) int {
	var buf bytes.Buffer
	z, _ := gzip.NewWriterLevel(&buf, gzip.DefaultCompression)
	_, _ = z.Write(b)
	_ = z.Close()
	return buf.Len()
}

// Budgets (server-first.md 3.2): at most 6 KB raw per chunk, and at most
// 30 KB compressed for a region's nine (each chunk is fetched, and so
// compressed, on its own).
const (
	chunkRawBudget       = 6 * 1024
	regionCompressBudget = 30 * 1024
)

func TestChunkSizeBudget(t *testing.T) {
	var raws []int
	maxRegion := 0
	for _, e := range append(goldenEpochs(), invariantEpochs()...) {
		r := mustRegion(t, e)
		region := 0
		for _, c := range r.Chunks {
			b := encodeChunk(c)
			raws = append(raws, len(b))
			region += gzipped(b)
			if len(b) > chunkRawBudget {
				t.Errorf("%s %s %d,%d: %d bytes raw", e.WorldSeed, e.RegionID, c.CX, c.CY, len(b))
			}
		}
		maxRegion = max(maxRegion, region)
		if region > regionCompressBudget {
			t.Errorf("%s %s: %d bytes compressed for nine", e.WorldSeed, e.RegionID, region)
		}
	}
	sort.Ints(raws)
	t.Logf("chunk bytes (WildsChunk): min %d median %d max %d; region compressed max %d", raws[0], raws[len(raws)/2], raws[len(raws)-1], maxRegion)
}

// TestChunkTimeBudget: 5 ms per chunk at p95 (server-first.md 3.3).
func TestChunkTimeBudget(t *testing.T) {
	if testing.Short() || raceEnabled {
		t.Skip("timing")
	}
	var took []time.Duration
	for i := range 30 {
		for _, e := range []Epoch{innerEpoch(fmt.Sprint("time-", i)), outerEpoch(fmt.Sprint("time-", i), 1795000000)} {
			for cy := range 3 {
				for cx := range 3 {
					start := time.Now()
					if _, err := GenerateChunk(e, cx, cy); err != nil {
						t.Fatal(err)
					}
					took = append(took, time.Since(start))
				}
			}
		}
	}
	slices.Sort(took)
	p95 := took[len(took)*95/100]
	t.Logf("chunk generation: median %v, p95 %v, max %v over %d chunks", took[len(took)/2], p95, took[len(took)-1], len(took))
	if p95 > 5*time.Millisecond {
		t.Fatalf("p95 %v over the 5 ms budget", p95)
	}
}

// BenchmarkChunk is one chunk, generated and packed as stored.
func BenchmarkChunk(b *testing.B) {
	e := outerEpoch("bench", 1795000000)
	for i := 0; b.Loop(); i++ {
		c, err := GenerateChunk(e, i%3, (i/3)%3)
		if err != nil {
			b.Fatal(err)
		}
		_ = encodeChunk(c)
	}
}

// BenchmarkRegion is one region epoch: all nine chunks, as at epoch creation.
func BenchmarkRegion(b *testing.B) {
	e := outerEpoch("bench", 1795000000)
	for b.Loop() {
		r, err := GenerateRegion(e)
		if err != nil {
			b.Fatal(err)
		}
		for _, c := range r.Chunks {
			_ = encodeChunk(c)
		}
	}
}
