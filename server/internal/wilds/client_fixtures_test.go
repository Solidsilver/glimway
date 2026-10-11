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
						kept = append(kept, Kept{cx + dx, cy + dy, ToProto(k, fixtureStillID)})
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
	// The Beyond: the first chunk (north to south, west to east) with a dark
	// lamp stone, and the first with a ford.
	ford := groundID("ford")
	for cy := -8; cy <= 0 && (want["road"] == nil || want["ford"] == nil); cy++ {
		for cx := -4; cx <= 4; cx++ {
			if !insideReach(cx, cy) || EpochKindAt(cx, cy) != EpochWick || NearestFootprint(cx, cy) == 0 {
				continue
			}
			b, ch := gen(cx, cy)
			for _, s := range ch.Sites {
				if s.Kind == SiteLampStone && want["road"] == nil {
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
