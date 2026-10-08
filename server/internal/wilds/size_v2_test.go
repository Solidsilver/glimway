package wilds

import (
	"bytes"
	"compress/gzip"
	"fmt"
	"slices"
	"sort"
	"testing"
	"time"
)

// wire is a minimal protobuf encoder, enough to measure a chunk in the
// WildsChunk layout of server-first.md 3.2 before lane A's messages land.
type wire struct{ b []byte }

func (w *wire) varint(v uint64) {
	for v >= 0x80 {
		w.b = append(w.b, byte(v)|0x80)
		v >>= 7
	}
	w.b = append(w.b, byte(v))
}
func (w *wire) tag(field, typ int) { w.varint(uint64(field<<3 | typ)) }
func (w *wire) uint(field int, v uint64) {
	if v != 0 {
		w.tag(field, 0)
		w.varint(v)
	}
}
func (w *wire) sint(field int, v int) { w.uint(field, zigzag(v)) }
func (w *wire) bytes(field int, b []byte) {
	w.tag(field, 2)
	w.varint(uint64(len(b)))
	w.b = append(w.b, b...)
}
func (w *wire) str(field int, s string) {
	if s != "" {
		w.bytes(field, []byte(s))
	}
}
func (w *wire) msg(field int, m *wire) { w.bytes(field, m.b) }
func (w *wire) packed(field int, vals []uint64) {
	if len(vals) == 0 {
		return
	}
	var in wire
	for _, v := range vals {
		in.varint(v)
	}
	w.bytes(field, in.b)
}

func zigzag(v int) uint64 { return uint64((v << 1) ^ (v >> 63)) }

func tileMsg(t Tile) *wire {
	var m wire
	m.uint(1, uint64(t.TX))
	m.uint(2, uint64(t.TY))
	return &m
}

// encodeChunk writes c as WildsChunk (3.2). Enums count from 1 (0 is
// UNSPECIFIED); the epoch id is a 36-character UUID. Entities aren't in
// 3.2's message; withEntities appends them as field 18 to measure both ways.
func encodeChunk(c Chunk, withEntities bool) []byte {
	var m wire
	m.str(1, "00000000-0000-0000-0000-000000000000")
	m.str(2, c.RegionID)
	m.str(3, "hearthwick")
	m.sint(5, c.CX)
	m.sint(6, c.CY)
	m.uint(7, uint64(c.GeneratorVersion))
	m.uint(8, uint64(c.Size))
	var palette []Ground
	for _, g := range c.Ground {
		if !slices.Contains(palette, g) {
			palette = append(palette, g)
		}
	}
	slices.Sort(palette)
	for _, g := range palette {
		m.str(9, g.String())
	}
	ground := make([]byte, len(c.Ground)/2)
	solid := make([]byte, len(c.Solid)/8)
	for i, g := range c.Ground {
		ground[i/2] |= byte(slices.Index(palette, g)) << (4 * (i % 2))
	}
	for i, s := range c.Solid {
		if s {
			solid[i/8] |= 1 << (i % 8)
		}
	}
	m.bytes(10, ground)
	m.bytes(11, solid)
	for _, e := range c.Exits {
		var x wire
		x.uint(1, uint64(e.TX))
		x.uint(2, uint64(e.TY))
		x.uint(3, uint64(e.TW))
		x.uint(4, uint64(e.TH))
		x.uint(5, uint64(e.Dir)+1)
		x.str(6, e.To)
		x.msg(7, tileMsg(e.Entry))
		m.msg(12, &x)
	}
	var d wire
	var kinds []DecorKind
	for _, p := range c.Decor {
		if !slices.Contains(kinds, p.Kind) {
			kinds = append(kinds, p.Kind)
		}
	}
	for _, k := range kinds {
		d.str(1, k.String())
	}
	cols := make([][]uint64, 6)
	flags := make([]byte, (2*len(c.Decor)+7)/8)
	for i, p := range c.Decor {
		cols[0] = append(cols[0], uint64(slices.Index(kinds, p.Kind)))
		cols[1] = append(cols[1], uint64(p.TX))
		cols[2] = append(cols[2], uint64(p.TY))
		cols[3] = append(cols[3], zigzag(p.OX))
		cols[4] = append(cols[4], zigzag(p.OY))
		cols[5] = append(cols[5], uint64(p.Variant))
		if p.Flip {
			flags[2*i/8] |= 1 << (2 * i % 8)
		}
		if p.Overhang {
			flags[2*i/8] |= 2 << (2 * i % 8)
		}
	}
	for i, col := range cols {
		d.packed(i+2, col)
	}
	d.bytes(8, flags)
	m.msg(13, &d)
	for _, s := range c.Sites {
		var x wire
		x.str(1, s.ID)
		x.uint(2, uint64(slices.Index([]SiteKind{SiteEcho, SiteGiven, SiteCairn, SiteNest, SiteReeds, SitePlank}, s.Kind)+1))
		x.uint(3, uint64(s.TX))
		x.uint(4, uint64(s.TY))
		m.msg(14, &x)
	}
	m.msg(15, tileMsg(c.Spawn))
	m.str(16, c.Look)
	m.str(17, c.Mark)
	if withEntities {
		for _, e := range c.Entities {
			var x wire
			x.str(1, e.ID)
			x.str(2, e.Kind)
			x.uint(3, uint64(e.TX))
			x.uint(4, uint64(e.TY))
			for _, en := range e.Enemies {
				x.str(5, en)
			}
			x.str(6, e.Material)
			x.uint(7, uint64(e.Tier))
			x.str(8, e.POI)
			m.msg(18, &x)
		}
	}
	return m.b
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
			b := encodeChunk(c, true)
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
	t.Logf("chunk raw bytes (with entities): min %d median %d max %d; region compressed max %d", raws[0], raws[len(raws)/2], raws[len(raws)-1], maxRegion)
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

func BenchmarkChunk(b *testing.B) {
	e := outerEpoch("bench", 1795000000)
	for i := 0; b.Loop(); i++ {
		if _, err := GenerateChunk(e, i%3, (i/3)%3); err != nil {
			b.Fatal(err)
		}
	}
}

// BenchmarkRegion is one region epoch: all nine chunks, as at epoch creation.
func BenchmarkRegion(b *testing.B) {
	e := outerEpoch("bench", 1795000000)
	for b.Loop() {
		if _, err := GenerateRegion(e); err != nil {
			b.Fatal(err)
		}
	}
}
