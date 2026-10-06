package content

import (
	"encoding/json"
	"fmt"
	"slices"
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
}

type GatheringTarget struct {
	Action     string           `json:"action"`
	ToolAction string           `json:"toolAction"`
	Name       string           `json:"name"`
	Yields     []GatheringYield `json:"yields"`
}

type Gathering struct {
	Caps        GatheringCaps              `json:"caps"`
	SoftCapLine string                     `json:"softCapLine"`
	Swings      map[string]int             `json:"swings"`
	Targets     map[string]GatheringTarget `json:"targets"`
	Seeds       []string                   `json:"seeds"`
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
	return g, nil
}

func GatheringTargetFor(targetID string) (GatheringTarget, bool) {
	t, ok := GatheringRules.Targets[targetID]
	return t, ok
}

func IsGatheringSeed(itemDef string) bool {
	return slices.Contains(GatheringRules.Seeds, itemDef)
}
