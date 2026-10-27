package wilds

import (
	"context"
	"reflect"
	"testing"
)

func TestSlopeFindCertifiedFeatures(t *testing.T) {
	for _, recipe := range []string{SlopeRecipe, SlopeRecipeV2} {
		for _, seed := range []string{"map", "slopes-17", "slopes-991"} {
			t.Run(recipe+"/"+seed, func(t *testing.T) {
				features, err := SlopeOwnerFeatures(context.Background(), seed, recipe, 0, 0)
				if err != nil {
					t.Fatal(err)
				}
				p, err := NewSlopePlanRecipe(context.Background(), seed, recipe, -576, -576, 1152, 1152)
				if err != nil {
					t.Fatal(err)
				}
				c := p.Certificate(12, 30)
				kinds := map[string]bool{}
				for _, f := range features {
					kinds[f.Kind] = true
					i := p.Index(f.Stand[0], f.Stand[1])
					if !p.Walkable(i) || p.Ground[i].Unreachable || c.Home < 0 || c.Labels[i] != c.Home {
						t.Fatal("stand not certified to actual home", f)
					}
					if f.Stand[0] < 0 || f.Stand[1] < 0 || f.Stand[0] >= 576 || f.Stand[1] >= 576 {
						t.Fatal("escaped owner", f)
					}
					if f.Kind == "spire" {
						j := p.Index(f.Target[0], f.Target[1])
						if !p.Ground[j].Unreachable || c.Labels[j] == c.Home {
							t.Fatal("spire should remain unreachable", f)
						}
					}
				}
				for _, k := range []string{"pass", "crest", "spire", "outcrop-top", "outcrop-foot", "hills", "tunnel"} {
					// @1's northern outcrop is held back near home in this
					// owner. The finder must not invent a cliff there.
					if recipe == SlopeRecipe && (k == "outcrop-top" || k == "outcrop-foot") {
						continue
					}
					if !kinds[k] {
						t.Error("missing", k)
					}
				}
			})
		}
	}
}

func TestSlopeFindDeterministicAndBounded(t *testing.T) {
	for _, xy := range [][2]int{{-2, -1}, {1, 2}} {
		a, err := SlopeOwnerFeatures(context.Background(), "map", SlopeRecipeV2, xy[0], xy[1])
		if err != nil {
			t.Fatal(err)
		}
		b, err := SlopeOwnerFeatures(context.Background(), "map", SlopeRecipeV2, xy[0], xy[1])
		if err != nil || !reflect.DeepEqual(a, b) {
			t.Fatal("not deterministic", err)
		}
		for _, f := range a {
			if f.Owner != xy || floorDiv(f.Stand[0], 576) != xy[0] || floorDiv(f.Stand[1], 576) != xy[1] {
				t.Fatal("escaped bounded owner", f)
			}
		}
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := SlopeOwnerFeatures(ctx, "map", SlopeRecipeV2, 0, 0); err == nil {
		t.Fatal("cancelled work continued")
	}
	if _, err := SlopeOwnerFeatures(context.Background(), "map", "bad", 0, 0); err == nil {
		t.Fatal("unknown recipe")
	}
}
