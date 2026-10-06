package content

import (
	"testing"
)

func TestGatheringContent(t *testing.T) {
	g, err := LoadGathering()
	if err != nil {
		t.Fatalf("LoadGathering: %v", err)
	}
	if g.Caps.Visit.Chop != 8 || g.Caps.Visit.Break != 5 || g.Caps.Visit.Dig != 6 {
		t.Errorf("unexpected visit caps: %+v", g.Caps.Visit)
	}
	if g.Caps.Day.Chop != 30 || g.Caps.Day.Break != 20 || g.Caps.Day.Dig != 25 {
		t.Errorf("unexpected day caps: %+v", g.Caps.Day)
	}
	if g.SoftCapLine != "The wood’s given enough here today." {
		t.Errorf("unexpected soft cap line: %q", g.SoftCapLine)
	}

	// Verify all target items exist in ItemsRules.
	for id, target := range g.Targets {
		for _, y := range target.Yields {
			if _, ok := ItemFor(y.Item); !ok {
				t.Errorf("target %s yield item %s does not exist in items.json", id, y.Item)
			}
			if y.Min <= 0 || y.Max < y.Min {
				t.Errorf("target %s yield item %s has invalid range %d..%d", id, y.Item, y.Min, y.Max)
			}
		}
	}

	// Verify all seeds exist in ItemsRules with kind "seed".
	for _, seed := range g.Seeds {
		d, ok := ItemFor(seed)
		if !ok {
			t.Errorf("seed %s does not exist in items.json", seed)
		} else if d.Kind != "seed" {
			t.Errorf("seed %s has kind %q, expected \"seed\"", seed, d.Kind)
		}
	}
}
