package wilds

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// content/vectors/slopes-surface.json is the height contract both sides
// replay: the client's codec (src/game/terrain/surface.ts) decodes each
// chunk to the same kinds, walkable tiles, open steps and faces, and
// rejects the same corrupt envelopes. Rewrite it with -update.
const slopeVectorsPath = "../../../content/vectors/slopes-surface.json"

type slopeVectorChunk struct {
	Name string `json:"name"`
	CX   int    `json:"cx"`
	CY   int    `json:"cy"`
	W    int    `json:"w"`
	H    int    `json:"h"`
	B64  string `json:"b64"`
	// Per tile: kind digit (0 slope, 1 steep, 2 crag, 3 cliff).
	Kinds string `json:"kinds"`
	// Per tile: 1 walkable by the four-corner rule.
	Walkable string `json:"walkable"`
	// Per tile: hex digit of the open in-surface steps (bit d: N, E, S, W).
	Steps string `json:"steps"`
	// Per tile: hex digit of the discontinuity flags; '1' unreachable.
	Flags       string     `json:"flags"`
	Unreachable string     `json:"unreachable"`
	Overrides   int        `json:"overrides"`
	CornerSum   int        `json:"cornerSum"`
	Faces       [][5]int   `json:"faces"`
	Resolved    [][5]int   `json:"resolved"`
	Gradients   [][2]int64 `json:"gradients"`
}

type slopeVectors struct {
	Recipe string             `json:"recipe"`
	Seed   string             `json:"seed"`
	Unit   int                `json:"unit"`
	Limit  int                `json:"limit"`
	Chunks []slopeVectorChunk `json:"chunks"`
	Reject []struct {
		Name string `json:"name"`
		B64  string `json:"b64"`
	} `json:"reject"`
}

func slopeVectorOf(name string, cx, cy int, s *SlopeSurface) (slopeVectorChunk, error) {
	raw, err := EncodeSlopeChunk(s)
	if err != nil {
		return slopeVectorChunk{}, err
	}
	v := slopeVectorChunk{Name: name, CX: cx, CY: cy, W: s.W, H: s.H, B64: base64.StdEncoding.EncodeToString(raw), Overrides: len(s.Overrides)}
	p := &SlopePlan{X: cx * 24, Y: cy * 24, SlopeSurface: s}
	var kinds, walk, steps, flags, unreach strings.Builder
	for i, g := range s.Ground {
		kinds.WriteByte('0' + byte(g.Kind))
		walk.WriteByte(map[bool]byte{false: '0', true: '1'}[s.Walkable(i)])
		open := 0
		for d := 0; d < 4; d++ {
			if p.Step(i, d) >= 0 {
				open |= 1 << d
			}
		}
		steps.WriteString(fmt.Sprintf("%x", open))
		flags.WriteString(fmt.Sprintf("%x", g.Discontinuity))
		unreach.WriteByte(map[bool]byte{false: '0', true: '1'}[g.Unreachable])
		if g.Kind == SlopeCliff {
			v.Faces = append(v.Faces, [5]int{i, int(g.FaceTop), int(g.FaceBottom), int(g.FaceRow), int(g.FaceRows)})
		}
		// A handful of resolved tiles and their gradient, spread over the chunk.
		if i%97 == 0 {
			c := s.Tile(i).Corners
			v.Resolved = append(v.Resolved, [5]int{i, int(c[0]), int(c[1]), int(c[2]), int(c[3])})
			v.Gradients = append(v.Gradients, [2]int64{int64(i), SlopeGradientSquared(c)})
		}
	}
	for _, q := range s.Corners {
		v.CornerSum += int(q)
	}
	v.Kinds, v.Walkable, v.Steps, v.Flags, v.Unreachable = kinds.String(), walk.String(), steps.String(), flags.String(), unreach.String()
	return v, nil
}

func buildSlopeVectors(t *testing.T) slopeVectors {
	t.Helper()
	out := slopeVectors{Recipe: SlopeRecipe, Seed: "map", Unit: SlopeHeightUnit, Limit: SlopeWalkLimit}
	// Generated chunks: the first (scanning rows from the north-west of
	// home's window) with each feature, and a flat one.
	want := []string{"flat", "hills", "cliff", "crag", "steep", "spire"}
	found := map[string]bool{}
	sampler := NewSlopeSampler("map")
	for cy := -24; cy <= 23 && len(found) < len(want); cy++ {
		for cx := -24; cx <= 23 && len(found) < len(want); cx++ {
			s, err := sampler.Surface(context.Background(), cx*24, cy*24, 24, 24)
			if err != nil {
				t.Fatal(err)
			}
			has := map[string]bool{}
			uniform := true
			for _, q := range s.Corners {
				uniform = uniform && q == s.Corners[0]
			}
			has["flat"] = uniform
			has["hills"] = !uniform
			for _, g := range s.Ground {
				has["cliff"] = has["cliff"] || g.Kind == SlopeCliff
				has["crag"] = has["crag"] || g.Kind == SlopeCrag
				has["steep"] = has["steep"] || g.Kind == SlopeSteep
				has["spire"] = has["spire"] || g.Unreachable
				has["hills"] = has["hills"] && g.Kind == SlopeGround
			}
			for _, name := range want {
				if has[name] && !found[name] {
					found[name] = true
					v, err := slopeVectorOf(name, cx, cy, s)
					if err != nil {
						t.Fatal(err)
					}
					out.Chunks = append(out.Chunks, v)
					// The chunk east of a cliff: the seam's shared corners.
					if name == "cliff" {
						e, err := sampler.Surface(context.Background(), (cx+1)*24, cy*24, 24, 24)
						if err != nil {
							t.Fatal(err)
						}
						v, err := slopeVectorOf("cliff-east", cx+1, cy, e)
						if err != nil {
							t.Fatal(err)
						}
						out.Chunks = append(out.Chunks, v)
					}
				}
			}
		}
	}
	if len(found) != len(want) {
		t.Fatal("vector features not found near home", found)
	}
	// A synthetic override: a raised tile behind explicit discontinuities.
	probe := &SlopeSurface{W: 3, H: 3, Corners: make([]uint16, 16), Ground: make([]SlopeGroundData, 9), Overrides: []SlopeCornerOverride{{Tile: 4, Corners: [4]uint16{256, 256, 256, 256}}}}
	probe.Ground[4].Discontinuity = 15
	probe.Ground[1].Discontinuity = 1 << 2
	probe.Ground[3].Discontinuity = 1 << 1
	probe.Ground[5].Discontinuity = 1 << 3
	probe.Ground[7].Discontinuity = 1 << 0
	v, err := slopeVectorOf("override-probe", 0, 0, probe)
	if err != nil {
		t.Fatal(err)
	}
	out.Chunks = append(out.Chunks, v)
	// Corrupt envelopes both decoders must refuse.
	raw, _ := base64.StdEncoding.DecodeString(v.B64)
	reject := func(name string, b []byte) {
		if _, err := DecodeSlopeChunk(b); err == nil {
			t.Fatal("vector reject decodes", name)
		}
		out.Reject = append(out.Reject, struct {
			Name string `json:"name"`
			B64  string `json:"b64"`
		}{name, base64.StdEncoding.EncodeToString(b)})
	}
	reject("truncated", raw[:len(raw)-1])
	reject("trailing", append(bytes.Clone(raw), 0))
	bad := bytes.Clone(raw)
	bad[2] = 1
	reject("version", bad)
	bad = bytes.Clone(raw)
	bad[3] = 0
	reject("zero-width", bad)
	// Uniform 3x3: header 6, uniform corner 2, kinds 3, then the flag mask.
	bad = bytes.Clone(raw)
	bad[11] |= 0x80
	reject("unknown-plane", bad)
	bad = bytes.Clone(raw)
	bad[11] |= 2
	reject("cliff-flag", bad)
	// The override's corners changed to the grid's own (a no-op override).
	bad = bytes.Clone(raw)
	for i := len(bad) - 8; i < len(bad); i++ {
		bad[i] = 0
	}
	reject("noop-override", bad)
	// A walkable tile steeper than the limit: its corner (0,0,64,0) trap.
	steep := &SlopeSurface{W: 1, H: 1, Corners: []uint16{0, 0, 0, 65}, Ground: make([]SlopeGroundData, 1)}
	steep.Ground[0].Kind = SlopeSteep
	b, err := EncodeSlopeChunk(steep)
	if err != nil {
		t.Fatal(err)
	}
	b[14] = 0 // header 6, four corners 8: the kind back to slope
	reject("too-steep", b)
	return out
}

func TestSlopesSharedVectors(t *testing.T) {
	v := buildSlopeVectors(t)
	got, err := json.MarshalIndent(v, "", " ")
	if err != nil {
		t.Fatal(err)
	}
	got = append(got, '\n')
	if *updateGoldens {
		if err := os.WriteFile(slopeVectorsPath, got, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	had, err := os.ReadFile(slopeVectorsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(had, got) {
		t.Fatal("content/vectors/slopes-surface.json is stale: go test ./server/internal/wilds -run TestSlopesSharedVectors -update")
	}
}
