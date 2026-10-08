package land

import (
	"encoding/json"
	"flag"
	"glimway/content"
	"maps"
	"os"
	"slices"
	"testing"
)

var update = flag.Bool("update", false, "rewrite the client's land fixture")

// TestGoldenLands pins the land of a spread of worlds and gates (once the
// TypeScript generator's parity vectors): served land never moves under a
// home that already stands on it.
func TestGoldenLands(t *testing.T) {
	b, err := os.ReadFile("testdata/lands.json")
	if err != nil {
		t.Fatal(err)
	}
	var lands []struct {
		WorldID string   `json:"worldId"`
		Gate    int      `json:"gate"`
		Seed    uint32   `json:"seed"`
		Rows    []string `json:"rows"`
	}
	if err = json.Unmarshal(b, &lands); err != nil || len(lands) == 0 {
		t.Fatal("goldens", err)
	}
	cfg := content.HomeRules.Land
	for _, l := range lands {
		if s := Seed(l.WorldID, l.Gate, cfg); s != l.Seed {
			t.Fatalf("seed %s/%d: %d want %d", l.WorldID, l.Gate, s, l.Seed)
		}
		if got := Generate(l.Seed, cfg).Rows(); !slices.Equal(got, l.Rows) {
			t.Fatalf("land %s/%d differs", l.WorldID, l.Gate)
		}
	}
}

// TestPostCostParity replays content/vectors/homestead.json (the TypeScript
// post prices, npm run vectors:homestead).
func TestPostCostParity(t *testing.T) {
	b, err := os.ReadFile("../../../content/vectors/homestead.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Posts []struct {
			N    int            `json:"n"`
			Cost map[string]int `json:"cost"`
		} `json:"posts"`
	}
	if err = json.Unmarshal(b, &v); err != nil || len(v.Posts) == 0 {
		t.Fatal("empty vectors", err)
	}
	for _, p := range v.Posts {
		if got := content.HomeRules.PostCost(p.N); !maps.Equal(got, p.Cost) {
			t.Fatalf("post %d: %v want %v", p.N, got, p.Cost)
		}
	}
}

func TestEveryLandKeepsItsSitePathAndGateClear(t *testing.T) {
	cfg := content.HomeRules.Land
	site, gate := cfg.Site, cfg.Gate
	seen := map[string]bool{}
	for _, world := range []string{"guest", "w1", "w2"} {
		for g := range 40 {
			l := Generate(Seed(world, g, cfg), cfg)
			for y := site.Y; y < site.Y+site.H; y++ {
				for x := site.X; x < site.X+site.W; x++ {
					if l.At(x, y) != Grass {
						t.Fatalf("%s/%d: site tile %d,%d is %c", world, g, x, y, Chars[l.At(x, y)])
					}
				}
			}
			for y := site.Y + site.H; y < l.Height; y++ {
				for x := gate.X; x < gate.X+gate.W; x++ {
					if l.At(x, y) != Path {
						t.Fatalf("%s/%d: path tile %d,%d is %c", world, g, x, y, Chars[l.At(x, y)])
					}
				}
			}
			seen[string(l.Tiles)] = true
		}
	}
	if len(seen) != 120 {
		t.Fatal("lands repeat across gates or worlds", len(seen))
	}
}

// TestClientFixture keeps tests/fixtures/home-land.json the served land of
// world "fixture-world", gate 0 (HomesteadLand as JSON). Regenerate with -update.
func TestClientFixture(t *testing.T) {
	cfg := content.HomeRules.Land
	l := Generate(Seed("fixture-world", 0, cfg), cfg)
	cells := make([]string, len(l.Tiles))
	for i, k := range l.Tiles {
		cells[i] = CellNames[k]
	}
	b, err := json.Marshal(map[string]any{"width": l.Width, "height": l.Height, "cells": cells, "generatorVersion": 2})
	if err != nil {
		t.Fatal(err)
	}
	b = append(b, '\n')
	const path = "../../../tests/fixtures/home-land.json"
	if *update {
		if err = os.WriteFile(path, b, 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	if got, err := os.ReadFile(path); err != nil || string(got) != string(b) {
		t.Fatalf("%s is stale: go test ./internal/land -run TestClientFixture -update", path)
	}
}

func TestLitAndEffective(t *testing.T) {
	l := Land{3, 1, []byte{Tree, Grass, Boulder}}
	if l.Effective(map[[2]int]bool{{0, 0}: true}, 0, 0) != Grass || l.Effective(nil, 2, 0) != Boulder || l.At(-1, 0) != Edge {
		t.Fatal("effective kinds")
	}
	if !Lit([]Light{{0, 0, 2}}, 2, 0) || Lit([]Light{{0, 0, 2}}, 2, 1) {
		t.Fatal("light radius")
	}
}
