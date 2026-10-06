package content

import (
	"encoding/json"
	"fmt"
	"slices"
)

// Asset is goods on the move (mail, chests, gifts, crafting output). Kind
// is "material", "item" (any other stack), "decoration" (a home good) or
// "instance" (one tool, off-hand item, carry gear or fitting, by Instance).
// Maker picks one maker's stack ("" = unmarked); nil takes any, unmarked first.
type Asset struct {
	Kind     string  `json:"kind"`
	ID       string  `json:"id"`
	Qty      int     `json:"qty"`
	Instance string  `json:"instance,omitempty"`
	Maker    *string `json:"maker,omitempty"`
}
type UtilityItem struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type Recipe struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	MinTier   int            `json:"minTier"`
	Materials map[string]int `json:"materials"`
	Output    Asset          `json:"output"`
}
type Crafting struct {
	UtilityItems []UtilityItem `json:"utilityItems"`
	Recipes      []Recipe      `json:"recipes"`
}
type Project struct {
	ID        string         `json:"id"`
	Name      string         `json:"name"`
	Materials map[string]int `json:"materials"`
	Papers    []string       `json:"papers"`
	WorldFlag string         `json:"worldFlag"`
}
type Projects struct {
	Projects []Project `json:"projects"`
}

func ValidContentID(id string) bool {
	if len(id) == 0 || len(id) > 100 {
		return false
	}
	for _, c := range id {
		if !(c >= 'a' && c <= 'z' || c >= '0' && c <= '9' || c == '-') {
			return false
		}
	}
	return true
}
func ValidMaterialCosts(costs map[string]int) bool {
	if len(costs) == 0 {
		return false
	}
	for id, n := range costs {
		if !slices.Contains(WildsRules.Materials, id) || n < 1 || n > 1000000 {
			return false
		}
	}
	return true
}
func ValidateCrafting(c Crafting) error {
	bad := fmt.Errorf("invalid crafting")
	if len(c.Recipes) == 0 || len(c.Recipes) > 60 || len(c.UtilityItems) == 0 {
		return bad
	}
	items := map[string]bool{}
	recipes := map[string]bool{}
	for _, i := range c.UtilityItems {
		d, ok := ItemFor(i.ID)
		if !ValidContentID(i.ID) || i.Name == "" || items[i.ID] || !ok || d.Kind != "part" || d.Name != i.Name {
			return bad
		}
		items[i.ID] = true
	}
	for _, r := range c.Recipes {
		if !ValidContentID(r.ID) || r.Name == "" || recipes[r.ID] || r.MinTier != 2 || !validStackCosts(r.Materials, itemsByID) || r.Output.Qty < 1 || r.Output.Qty > 100 {
			return bad
		}
		switch r.Output.Kind {
		case "decoration":
			d, ok := HomeItemFor(r.Output.ID)
			if !ok || d.MinTier > r.MinTier {
				return bad
			}
		case "item", "instance":
			d, ok := ItemFor(r.Output.ID)
			if !ok || d.AssetKind() != r.Output.Kind || (r.Output.Kind == "instance" && r.Output.Qty != 1) {
				return bad
			}
		default:
			return bad
		}
		recipes[r.ID] = true
	}
	return nil
}
func LoadCrafting() (Crafting, error) {
	var c Crafting
	b, err := FS.ReadFile("crafting.json")
	if err == nil {
		err = json.Unmarshal(b, &c)
	}
	if err == nil {
		err = ValidateCrafting(c)
	}
	return c, err
}

var CraftingRules = func() Crafting {
	c, err := LoadCrafting()
	if err != nil {
		panic(err)
	}
	return c
}()

// KnownAdventureItem: a carried stack that isn't a material (keepsakes,
// parts, consumables, seeds).
func KnownAdventureItem(id string) bool {
	d, ok := ItemFor(id)
	return ok && d.AssetKind() == "item"
}
func RecipeFor(id string) (Recipe, bool) {
	for _, r := range CraftingRules.Recipes {
		if r.ID == id {
			return r, true
		}
	}
	return Recipe{}, false
}
func ValidateProjects(p Projects) error {
	bad := fmt.Errorf("invalid projects")
	if len(p.Projects) == 0 {
		return bad
	}
	ids := map[string]bool{}
	papers := map[string]bool{}
	for _, v := range p.Projects {
		if !ValidContentID(v.ID) || v.Name == "" || ids[v.ID] || !ValidMaterialCosts(v.Materials) || v.WorldFlag != "project:"+v.ID+":complete" {
			return bad
		}
		ids[v.ID] = true
		for _, id := range v.Papers {
			paper, ok := PapersByID[id]
			if !ok || paper.Source != "village-project" || papers[id] {
				return bad
			}
			papers[id] = true
		}
	}
	// Every authored project paper has a completion path.
	for id, paper := range PapersByID {
		if paper.Source == "village-project" && !papers[id] {
			return bad
		}
	}
	return nil
}
func LoadProjects() (Projects, error) {
	var p Projects
	b, err := FS.ReadFile("projects.json")
	if err == nil {
		err = json.Unmarshal(b, &p)
	}
	if err == nil {
		err = ValidateProjects(p)
	}
	return p, err
}

var ProjectRules = func() Projects {
	p, err := LoadProjects()
	if err != nil {
		panic(err)
	}
	return p
}()

func ProjectFor(id string) (Project, bool) {
	for _, p := range ProjectRules.Projects {
		if p.ID == id {
			return p, true
		}
	}
	return Project{}, false
}
