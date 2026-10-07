package content

import (
	"math"
	"strconv"
	"strings"
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

func TestValidateGatheringNegativeFixtures(t *testing.T) {
	type fixture struct {
		name string
		edit func(*Gathering)
		want string
	}
	fixtures := []fixture{
		{"empty targets", func(g *Gathering) { g.Targets = nil }, "targets"},
		{"no plants", func(g *Gathering) { g.PlantsPerHome = 0 }, "plantsPerHome"},
		{"missing swings", func(g *Gathering) { delete(g.Swings, "dig") }, "swings"},
		{"negative swings", func(g *Gathering) { g.Swings["break"] = -1 }, "swings"},
		{"unknown swing action", func(g *Gathering) { g.Swings["fly"] = 3 }, "action"},
		{"missing area", func(g *Gathering) { delete(g.Areas, "home") }, "area"},
		{"unknown area", func(g *Gathering) { g.Areas["sky"] = []string{"tree"} }, "area"},
		{"unknown area target", func(g *Gathering) { g.Areas["woodland"] = []string{"missing"} }, "target"},
		{"duplicate area target", func(g *Gathering) { g.Areas["home"] = []string{"tree", "tree"} }, "duplicate"},
		{"no seeds", func(g *Gathering) { g.Seeds = nil }, "seeds"},
		{"unknown seed", func(g *Gathering) { g.Seeds[0] = "missing" }, "seed"},
		{"wrong seed kind", func(g *Gathering) { g.Seeds[0] = "timber" }, "seed"},
		{"duplicate seed", func(g *Gathering) { g.Seeds = append(g.Seeds, g.Seeds[0]) }, "seed"},
	}
	for _, scope := range []string{"visit", "day"} {
		for _, action := range []string{"chop", "break", "dig"} {
			for _, value := range []int{0, -1} {
				fixtures = append(fixtures, fixture{scope + " " + action + " cap " + strconv.Itoa(value), func(g *Gathering) {
					caps := &g.Caps.Visit
					if scope == "day" {
						caps = &g.Caps.Day
					}
					switch action {
					case "chop":
						caps.Chop = value
					case "break":
						caps.Break = value
					case "dig":
						caps.Dig = value
					}
				}, "caps"})
			}
		}
	}
	targets := []struct {
		name string
		edit func(*GatheringTarget)
		want string
	}{
		{"empty name", func(v *GatheringTarget) { v.Name = "" }, "name"},
		{"empty action", func(v *GatheringTarget) { v.Action = "" }, "action"},
		{"unknown action", func(v *GatheringTarget) { v.Action = "fly" }, "action"},
		{"unknown tool action", func(v *GatheringTarget) { v.ToolAction = "fly" }, "action"},
		{"empty yields", func(v *GatheringTarget) { v.Yields = nil }, "yields"},
		{"unknown item", func(v *GatheringTarget) { v.Yields[0].Item = "missing" }, "unknown item"},
		{"zero min", func(v *GatheringTarget) { v.Yields[0].Min = 0 }, "range"},
		{"negative min", func(v *GatheringTarget) { v.Yields[0].Min = -1 }, "range"},
		{"inverted range", func(v *GatheringTarget) { v.Yields[0].Max = 1 }, "range"},
		{"oversized range", func(v *GatheringTarget) { v.Yields[0].Max = math.MaxInt32 }, "range"},
		{"negative chance", func(v *GatheringTarget) { v.Yields[0].ChancePermille = -1 }, "chance"},
		{"chance over 1000", func(v *GatheringTarget) { v.Yields[0].ChancePermille = 1001 }, "chance"},
		{"long verb", func(v *GatheringTarget) { v.Verb = strings.Repeat("x", 31) }, "verb"},
		{"unknown mark", func(v *GatheringTarget) { v.Mark = "missing" }, "season"},
		{"unknown wick", func(v *GatheringTarget) { v.Wick = "missing" }, "season"},
		{"unknown yield mark", func(v *GatheringTarget) { v.Yields[0].Mark = "missing" }, "mark"},
	}
	for _, f := range targets {
		fixtures = append(fixtures, fixture{f.name, func(g *Gathering) {
			target := g.Targets["tree"]
			f.edit(&target)
			g.Targets["tree"] = target
		}, f.want})
	}
	for _, f := range fixtures {
		t.Run(f.name, func(t *testing.T) {
			g, err := LoadGathering()
			if err != nil {
				t.Fatal(err)
			}
			f.edit(&g)
			if err := ValidateGathering(g); err == nil || !strings.Contains(err.Error(), f.want) {
				t.Fatalf("ValidateGathering = %v; want %s refusal", err, f.want)
			}
		})
	}
}

func TestValidateGatheringChanceBoundaries(t *testing.T) {
	for _, chance := range []int{0, 1, 1000} {
		g, err := LoadGathering()
		if err != nil {
			t.Fatal(err)
		}
		g.Targets["tree"].Yields[0].ChancePermille = chance
		if err := ValidateGathering(g); err != nil {
			t.Fatalf("valid chance %d: %v", chance, err)
		}
	}
}
