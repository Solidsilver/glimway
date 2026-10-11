package wilds

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"slices"
	"strings"
	"testing"
	"time"
)

// Budgets (open-map.md section 4) and goldens for generator v3.

// goldenV3 are the chunks pinned whole: a few worlds and wicks, every
// chunk kind (the Tangle, the Whitequiet, the ring, the road, the river),
// and coordinates on both sides of zero.
func goldenV3() []struct {
	seed, season string
	cx, cy       int
} {
	var out []struct {
		seed, season string
		cx, cy       int
	}
	for _, w := range [][2]string{{"review-seed", "t:1790812800:1792022400"}, {"oak-7", "t:1792022400:1793232000"}, {"灰烬之路", "t:1795000000:1796209600"}} {
		for _, c := range [][2]int{{0, 0}, {-1, -2}, {1, -1}, {0, -3}, {1, -5}, {-4, -8}, {4, -8}, {-3, -1}, {3, 0}, {2, -6}, {-2, -5}, {0, -7}} {
			out = append(out, struct {
				seed, season string
				cx, cy       int
			}{w[0], w[1], c[0], c[1]})
		}
	}
	return out
}

// TestGoldenChunksV3 pins v3's output. A change to it is a new generator
// version, never an edit: regenerate only while v3 has no stored epochs
// (go test ./internal/wilds -run TestGoldenChunksV3 -update).
func TestGoldenChunksV3(t *testing.T) {
	got := map[string]string{}
	for _, g := range goldenV3() {
		e := epochFor(g.seed, g.season, g.cx, g.cy)
		c, err := GenerateV3(e, g.cx, g.cy, nil)
		if err != nil {
			t.Fatal(err)
		}
		got[fmt.Sprintf("%s/%s/%s/%d,%d", g.seed, e.Kind, e.Season, g.cx, g.cy)] = chunkHash(c)
	}
	const path = "testdata/golden_v3.json"
	if *updateGoldens {
		b, _ := json.MarshalIndent(got, "", "  ")
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var want map[string]string
	if err := json.Unmarshal(b, &want); err != nil {
		t.Fatal(err)
	}
	if len(want) != len(got) {
		t.Fatalf("golden has %d chunks, generated %d", len(want), len(got))
	}
	for k, h := range want {
		if got[k] != h {
			t.Errorf("chunk %s: hash %s, golden %s", k, got[k], h)
		}
	}
}

// TestChunkSizeBudgetV3: at most 6 KiB raw a chunk, as now.
func TestChunkSizeBudgetV3(t *testing.T) {
	var raws []int
	for _, ws := range v3Worlds(10) {
		for _, c := range frontierList() {
			b := encodeChunk(mustV3(t, ws[0], ws[1], c[0], c[1]))
			raws = append(raws, len(b))
			if len(b) > chunkRawBudget {
				t.Errorf("%s %v: %d bytes raw", ws[0], c, len(b))
			}
		}
	}
	slices.Sort(raws)
	t.Logf("v3 chunk bytes: min %d median %d max %d", raws[0], raws[len(raws)/2], raws[len(raws)-1])
}

// frontierTimes makes whole frontiers and returns each chunk's time and
// each frontier's.
func frontierTimes(t testing.TB, worlds int) (chunks, frontiers []time.Duration) {
	for i := range worlds {
		seed, season := fmt.Sprint("time-", i), wickSeason(1795000000+int64(i)*86400*15)
		start := time.Now()
		for _, c := range frontierList() {
			s := time.Now()
			mustV3(t, seed, season, c[0], c[1])
			chunks = append(chunks, time.Since(s))
		}
		frontiers = append(frontiers, time.Since(start))
	}
	slices.Sort(chunks)
	slices.Sort(frontiers)
	return chunks, frontiers
}

// TestChunkTimeBudgetV3: p95 ≤ 5 ms a chunk, a whole frontier (81 chunks)
// under 0.5 s. Timing runs only when asked for (GLIMWAY_PERF=1), as v2's.
func TestChunkTimeBudgetV3(t *testing.T) {
	if os.Getenv("GLIMWAY_PERF") != "1" || testing.Short() || raceEnabled {
		t.Skip("timing: GLIMWAY_PERF=1 runs it")
	}
	chunks, frontiers := frontierTimes(t, 20)
	p95 := chunks[len(chunks)*95/100]
	worst := frontiers[len(frontiers)-1]
	t.Logf("v3 chunk: median %v, p95 %v, max %v; frontier: median %v, max %v",
		chunks[len(chunks)/2], p95, chunks[len(chunks)-1], frontiers[len(frontiers)/2], worst)
	if p95 > 5*time.Millisecond {
		t.Errorf("p95 %v over the 5 ms budget", p95)
	}
	if worst > 500*time.Millisecond {
		t.Errorf("a frontier took %v, over 0.5 s", worst)
	}
}

// TestChunkTimeHeadroomV3 measures five times the budget, only in the
// opt-in performance job. Ordinary tests assert deterministic invariants.
func TestChunkTimeHeadroomV3(t *testing.T) {
	if os.Getenv("GLIMWAY_PERF") != "1" || raceEnabled || testing.Short() {
		t.Skip("timing")
	}
	chunks, frontiers := frontierTimes(t, 3)
	if p95 := chunks[len(chunks)*95/100]; p95 > 25*time.Millisecond {
		t.Errorf("p95 %v: more than five times the 5 ms budget", p95)
	}
	if worst := frontiers[len(frontiers)-1]; worst > 2500*time.Millisecond {
		t.Errorf("a frontier took %v: more than five times 0.5 s", worst)
	}
}

// BenchmarkChunkV3 is one ring chunk, generated and packed as stored.
func BenchmarkChunkV3(b *testing.B) {
	list := frontierList()
	season := wickSeason(1795000000)
	for i := 0; b.Loop(); i++ {
		c := list[i%len(list)]
		ch, err := GenerateV3(epochFor("bench", season, c[0], c[1]), c[0], c[1], nil)
		if err != nil {
			b.Fatal(err)
		}
		_ = encodeChunk(ch)
	}
}

// BenchmarkFrontierV3 is a whole 0.8 frontier, chunk by chunk.
func BenchmarkFrontierV3(b *testing.B) {
	season := wickSeason(1795000000)
	for b.Loop() {
		for _, c := range frontierList() {
			if _, err := GenerateV3(epochFor("bench", season, c[0], c[1]), c[0], c[1], nil); err != nil {
				b.Fatal(err)
			}
		}
	}
}

// Run the timing tests as a subprocess with performance explicitly disabled:
// ordinary unit runs must skip both wall-clock thresholds.
func TestGeneratorTimingIsOptIn(t *testing.T) {
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range []string{"", "0"} {
		cmd := exec.Command(binary, "-test.v", "-test.run=^TestChunkTime(Budget|Headroom)V3$")
		for _, entry := range os.Environ() {
			if !strings.HasPrefix(entry, "GLIMWAY_PERF=") {
				cmd.Env = append(cmd.Env, entry)
			}
		}
		cmd.Env = append(cmd.Env, "GLIMWAY_PERF="+value)
		output, err := cmd.CombinedOutput()
		if err != nil {
			t.Fatalf("ordinary timing run: %v\n%s", err, output)
		}
		for _, name := range []string{"TestChunkTimeBudgetV3", "TestChunkTimeHeadroomV3"} {
			if !strings.Contains(string(output), "--- SKIP: "+name) {
				t.Fatalf("%s ran without opt-in:\n%s", name, output)
			}
		}
	}
}
