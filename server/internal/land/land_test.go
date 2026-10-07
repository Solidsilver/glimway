package land

import (
	"encoding/json"
	"glimway/content"
	"maps"
	"os"
	"slices"
	"testing"
)

// TestTypeScriptParity replays content/vectors/homestead.json, written by
// npm run vectors:homestead from the TypeScript generator.
func TestTypeScriptParity(t *testing.T) {
	b, err := os.ReadFile("../../../content/vectors/homestead.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Lands []struct {
			WorldID string   `json:"worldId"`
			Gate    int      `json:"gate"`
			Seed    uint32   `json:"seed"`
			Rows    []string `json:"rows"`
		} `json:"lands"`
		Posts []struct {
			N    int            `json:"n"`
			Cost map[string]int `json:"cost"`
		} `json:"posts"`
	}
	if err = json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Lands) == 0 || len(v.Posts) == 0 {
		t.Fatal("empty vectors")
	}
	cfg := content.HomeRules.Land
	for _, l := range v.Lands {
		if s := Seed(l.WorldID, l.Gate, cfg); s != l.Seed {
			t.Fatalf("seed %s/%d: %d want %d", l.WorldID, l.Gate, s, l.Seed)
		}
		if got := Generate(l.Seed, cfg).Rows(); !slices.Equal(got, l.Rows) {
			t.Fatalf("land %s/%d differs", l.WorldID, l.Gate)
		}
	}
	for _, p := range v.Posts {
		if got := content.HomeRules.PostCost(p.N); !maps.Equal(got, p.Cost) {
			t.Fatalf("post %d: %v want %v", p.N, got, p.Cost)
		}
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
