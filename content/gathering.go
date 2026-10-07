package content

import (
	"encoding/json"
	"fmt"
	"math"
	"slices"
	"strings"
)

// Gathering rules and yields (content/gathering.json; docs/items/crafting-and-repair.md).
// Read directly by Go and TypeScript.

type GatheringActionCaps struct {
	Chop  int `json:"chop"`
	Break int `json:"break"`
	Dig   int `json:"dig"`
}

type GatheringCaps struct {
	Visit GatheringActionCaps `json:"visit"`
	Day   GatheringActionCaps `json:"day"`
}

type GatheringYield struct {
	Item           string `json:"item"`
	Min            int    `json:"min"`
	Max            int    `json:"max"`
	ChancePermille int    `json:"chancePermille,omitempty"`
	// Mark: the yield only turns up in this Mark (a season; the server's
	// clock and calendar decide, never the client).
	Mark string `json:"mark,omitempty"`
}

type GatheringTarget struct {
	Action     string           `json:"action"`
	ToolAction string           `json:"toolAction"`
	Name       string           `json:"name"`
	Yields     []GatheringYield `json:"yields"`
	// Verb: the button word when the work isn't a chop, break or dig
	// ("Sweep", "Pick"); the action's own word when empty.
	Verb string `json:"verb,omitempty"`
	// Mark or Wick: the piece only stands in its season (a Mark for the
	// seasons, a wick for a single wick's week). Empty: always there.
	Mark string `json:"mark,omitempty"`
	Wick string `json:"wick,omitempty"`
}

// InSeason: whether a piece (or yield) turns up on the given calendar day.
func (g GatheringYield) InSeason(d CalendarDay) bool {
	return g.Mark == "" || d.Mark == g.Mark
}
func (t GatheringTarget) InSeason(d CalendarDay) bool {
	if t.Mark != "" && d.Mark != t.Mark {
		return false
	}
	return t.Wick == "" || d.Wick == t.Wick
}

type Gathering struct {
	Caps        GatheringCaps `json:"caps"`
	SoftCapLine string        `json:"softCapLine"`
	// PlantsPerHome: how many plants one home's land tends; past it the
	// ground is full.
	PlantsPerHome int `json:"plantsPerHome"`
	// Areas: the targets each kind of place has ("wilds" for the Tangle and
	// the Whitequiet, "woodland", "home" for any homestead's land).
	Areas   map[string][]string        `json:"areas"`
	Swings  map[string]int             `json:"swings"`
	Targets map[string]GatheringTarget `json:"targets"`
	Seeds   []string                   `json:"seeds"`
}

var GatheringRules Gathering

func init() {
	var err error
	GatheringRules, err = LoadGathering()
	if err != nil {
		panic(fmt.Sprintf("content/gathering.json: %v", err))
	}
}

func LoadGathering() (Gathering, error) {
	var g Gathering
	b, err := FS.ReadFile("gathering.json")
	if err != nil {
		return g, err
	}
	if err = json.Unmarshal(b, &g); err != nil {
		return g, err
	}
	return g, ValidateGathering(g)
}

// ValidateGathering checks every definition used by gathering before gameplay
// can roll yields or consume a tool use. Zero chancePermille means guaranteed,
// as does an omitted chance; positive values are probabilities out of 1000.
func ValidateGathering(g Gathering) error {
	actions := []string{"chop", "break", "dig"}
	for _, c := range []GatheringActionCaps{g.Caps.Visit, g.Caps.Day} {
		if c.Chop <= 0 || c.Break <= 0 || c.Dig <= 0 {
			return fmt.Errorf("gathering caps must be positive for every action")
		}
	}
	for _, action := range actions {
		if g.Swings[action] <= 0 {
			return fmt.Errorf("gathering swings for %s must be positive", action)
		}
	}
	for action := range g.Swings {
		if !slices.Contains(actions, action) {
			return fmt.Errorf("gathering swings names unknown action %s", action)
		}
	}
	if g.PlantsPerHome <= 0 {
		return fmt.Errorf("plantsPerHome must be positive")
	}
	if len(g.Targets) == 0 {
		return fmt.Errorf("gathering targets must not be empty")
	}
	cal, err := LoadCalendar()
	if err != nil {
		return fmt.Errorf("calendar: %v", err)
	}
	for _, area := range []string{"wilds", "woodland", "home"} {
		if len(g.Areas[area]) == 0 {
			return fmt.Errorf("gathering area %s offers nothing", area)
		}
	}
	for area, targets := range g.Areas {
		if !slices.Contains([]string{"wilds", "woodland", "home", "village", "commons"}, area) {
			return fmt.Errorf("unknown gathering area %s", area)
		}
		seen := map[string]bool{}
		for _, t := range targets {
			if _, ok := g.Targets[t]; !ok || seen[t] {
				return fmt.Errorf("gathering area %s names unknown or duplicate target %s", area, t)
			}
			seen[t] = true
		}
	}
	for id, t := range g.Targets {
		if !ValidContentID(id) || t.Name == "" || !slices.Contains(actions, t.Action) || !slices.Contains(actions, t.ToolAction) || len(t.Yields) == 0 {
			return fmt.Errorf("gathering target %s has an invalid ID, name, action or yields", id)
		}
		if len(t.Verb) > 30 || t.Mark != "" && !slices.Contains(cal.Marks, t.Mark) || t.Wick != "" && !slices.Contains(cal.Wicks, t.Wick) {
			return fmt.Errorf("gathering target %s has an invalid verb or season", id)
		}
		for _, y := range t.Yields {
			if _, ok := ItemFor(y.Item); !ok {
				return fmt.Errorf("gathering target %s yields unknown item %s", id, y.Item)
			}
			// Bound quantities to a portable signed integer; the roller uses
			// a uint32 modulus and gathering may add one extra item.
			if y.Min <= 0 || y.Max < y.Min || y.Max >= math.MaxInt32 {
				return fmt.Errorf("gathering target %s yield %s has an invalid range", id, y.Item)
			}
			if y.ChancePermille < 0 || y.ChancePermille > 1000 {
				return fmt.Errorf("gathering target %s yield %s has an invalid chance", id, y.Item)
			}
			if y.Mark != "" && !slices.Contains(cal.Marks, y.Mark) {
				return fmt.Errorf("gathering target %s yield %s has an invalid mark", id, y.Item)
			}
		}
	}
	if len(g.Seeds) == 0 {
		return fmt.Errorf("gathering seeds must not be empty")
	}
	seeds := map[string]bool{}
	for _, id := range g.Seeds {
		d, ok := ItemFor(id)
		if !ok || d.Kind != "seed" || seeds[id] {
			return fmt.Errorf("gathering seed %s is unknown, not a seed or duplicated", id)
		}
		seeds[id] = true
	}
	return nil
}

func GatheringTargetFor(targetID string) (GatheringTarget, bool) {
	t, ok := GatheringRules.Targets[targetID]
	return t, ok
}

// GatheringOffered: whether a place (a progress area: "wilds", "woodland",
// "home:<gate>") has pieces of a target at all. Anywhere else has none.
func GatheringOffered(area, target string) bool {
	if strings.HasPrefix(area, "home:") {
		area = "home"
	}
	return slices.Contains(GatheringRules.Areas[area], target)
}

func IsGatheringSeed(itemDef string) bool {
	return slices.Contains(GatheringRules.Seeds, itemDef)
}
