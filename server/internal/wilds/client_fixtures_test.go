package wilds

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"google.golang.org/protobuf/proto"
)

// The client's chunk fixtures (tests/fixtures/wilds-*.bin): real v3 chunks
// of one world, so the client's tests read what the server serves. A
// Tangle chunk (still epoch), a 2x2 block of the Whitequiet (wick epoch,
// neighbours for the client's seam test), and the first chunk of the
// Beyond with a dark lamp stone and the first with a ford.
// UPDATE_CLIENT_FIXTURES=1 writes them; otherwise this checks they're
// current (a generator change is a new version and new fixtures).
const (
	fixtureSeed      = "client-fixtures"
	fixtureStillID   = "fixture-still"
	fixtureWickID    = "fixture-wick"
	fixtureSeasonSec = 1791000000
)

func TestClientFixtures(t *testing.T) {
	season := wickSeason(fixtureSeasonSec)
	gen := func(cx, cy int) ([]byte, Chunk) {
		e, id := WickEpoch(fixtureSeed, season), fixtureWickID
		if EpochKindAt(cx, cy) == EpochStill {
			e, id = StillEpoch(fixtureSeed), fixtureStillID
		}
		var kept []Kept
		// A wick chunk beside the Tangle reads the kept Tangle's edges.
		if e.Kind == EpochWick {
			for dy := -1; dy <= 1; dy++ {
				for dx := -1; dx <= 1; dx++ {
					if (dx != 0 || dy != 0) && EpochKindAt(cx+dx, cy+dy) == EpochStill {
						k, err := GenerateV3(StillEpoch(fixtureSeed), cx+dx, cy+dy, nil)
						if err != nil {
							t.Fatal(err)
						}
						kept = append(kept, Kept{CX: cx + dx, CY: cy + dy, Chunk: ToProto(k, fixtureStillID)})
					}
				}
			}
		}
		ch, err := GenerateV3(e, cx, cy, kept)
		if err != nil {
			t.Fatal(err)
		}
		b, err := proto.MarshalOptions{Deterministic: true}.Marshal(ToProto(ch, id))
		if err != nil {
			t.Fatal(err)
		}
		return b, ch
	}
	want := map[string][]byte{}
	for _, f := range []struct {
		name   string
		cx, cy int
	}{{"tangle", 0, -1}, {"whitequiet-0-5", 0, -5}, {"whitequiet-1-5", 1, -5}, {"whitequiet-0-4", 0, -4}, {"whitequiet-1-4", 1, -4}} {
		want[f.name], _ = gen(f.cx, f.cy)
	}
	// The Beyond: of the chunks with a dark lamp stone, the one with the most
	// decor (the client's gathering tests fell its trees), and the first chunk
	// (north to south, west to east) with a ford, along the Lantern Road.
	roadDecor := -1
	ford := groundID("ford")
	for cy := -8; cy <= 0; cy++ {
		for cx := -4; cx <= 16; cx++ {
			if EpochKindAt(cx, cy) != EpochWick || NearestFootprint(cx, cy) == 0 || FixedFootprintAt(cx, cy) != nil {
				continue
			}
			b, ch := gen(cx, cy)
			for _, s := range ch.Sites {
				if s.Kind == SiteLampStone && len(ch.Decor) > roadDecor {
					roadDecor = len(ch.Decor)
					want["road"] = b
				}
			}
			for _, g := range ch.Ground {
				if g == ford && want["ford"] == nil {
					want["ford"] = b
					break
				}
			}
		}
	}
	if want["road"] == nil || want["ford"] == nil {
		t.Fatalf("the fixture world has no lamp stone or no ford in the Beyond")
	}
	dir := filepath.Join("..", "..", "..", "tests", "fixtures")
	for name, b := range want {
		path := filepath.Join(dir, fmt.Sprintf("wilds-%s.bin", name))
		if os.Getenv("UPDATE_CLIENT_FIXTURES") == "1" {
			if err := os.WriteFile(path, b, 0o644); err != nil {
				t.Fatal(err)
			}
			continue
		}
		have, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("%s: %v (UPDATE_CLIENT_FIXTURES=1 writes it)", path, err)
		}
		if !bytes.Equal(have, b) {
			t.Fatalf("%s is stale: UPDATE_CLIENT_FIXTURES=1 go test -run TestClientFixtures ./internal/wilds", path)
		}
	}
}

// Real bent crossings, including one split across a chunk edge. Their
// walkable ford geometry must survive generation and wire packing unchanged.
func TestRiverCrossingFixtures(t *testing.T) {
	e := WickEpoch("v3-0", "t:1791158400:1791763200")
	for _, f := range []struct {
		name    string
		cx, cy  int
		hasFord bool
	}{
		{"ford-bend", -4, -5, true},
		{"ford-bend-east", -3, -5, true},
		{"ford-diagonal-west", -5, -6, true},
		{"ford-diagonal-east", -4, -6, true},
	} {
		t.Run(f.name, func(t *testing.T) {
			ch, err := GenerateV3(e, f.cx, f.cy, nil)
			if err != nil {
				t.Fatal(err)
			}
			wire := ToProto(ch, fixtureWickID)
			fords := 0
			for i, g := range ch.Ground {
				if g != groundRiverFord {
					continue
				}
				fords++
				if ch.Solid[i] || !Walkable(wire, i%ch.Size, i/ch.Size) {
					t.Fatalf("ford at %d,%d became solid", i%ch.Size, i/ch.Size)
				}
				pi := wire.Ground[i/2] >> (4 * (i % 2)) & 15
				if wire.Palette[pi] != "water_b" {
					t.Fatal("ford lost in wire packing")
				}
			}
			if (fords > 0) != f.hasFord {
				t.Fatalf("ford count %d, want presence %v", fords, f.hasFord)
			}
			b, err := proto.MarshalOptions{Deterministic: true}.Marshal(wire)
			if err != nil {
				t.Fatal(err)
			}
			path := filepath.Join("..", "..", "..", "tests", "fixtures", "wilds-"+f.name+".bin")
			if os.Getenv("UPDATE_CLIENT_FIXTURES") == "1" {
				if err := os.WriteFile(path, b, 0o644); err != nil {
					t.Fatal(err)
				}
			} else if have, err := os.ReadFile(path); err != nil || !bytes.Equal(have, b) {
				t.Fatalf("%s is stale: UPDATE_CLIENT_FIXTURES=1 go test ./server/internal/wilds -run TestRiverCrossingFixtures", path)
			}
		})
	}
}

