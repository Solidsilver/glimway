package content

import (
	"encoding/json"
	"fmt"
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
	if g.Caps.Visit.Chop <= 0 || g.Caps.Day.Chop <= 0 || len(g.Targets) == 0 {
		return g, fmt.Errorf("invalid gathering caps or targets")
	}
	for id, t := range g.Targets {
		if t.Action == "" || t.ToolAction == "" || len(t.Yields) == 0 {
			return g, fmt.Errorf("gathering target %s has empty action or yields", id)
		}
	}
	if g.PlantsPerHome <= 0 {
		return g, fmt.Errorf("plantsPerHome must be positive")
	}
	cal, err := LoadCalendar()
	if err != nil {
		return g, fmt.Errorf("calendar: %v", err)
	}
	for _, area := range []string{"wilds", "woodland", "home"} {
		if len(g.Areas[area]) == 0 {
			return g, fmt.Errorf("gathering area %s offers nothing", area)
		}
	}
	for area, targets := range g.Areas {
		for _, t := range targets {
			if _, ok := g.Targets[t]; !ok {
				return g, fmt.Errorf("gathering area %s names unknown target %s", area, t)
			}
		}
	}
	for id, t := range g.Targets {
		if len(t.Verb) > 30 || t.Mark != "" && !slices.Contains(cal.Marks, t.Mark) || t.Wick != "" && !slices.Contains(cal.Wicks, t.Wick) {
			return g, fmt.Errorf("gathering target %s has an invalid verb or season", id)
		}
		for _, y := range t.Yields {
			if y.Mark != "" && !slices.Contains(cal.Marks, y.Mark) {
				return g, fmt.Errorf("gathering target %s yield %s has an invalid mark", id, y.Item)
			}
		}
	}
	return g, nil
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
