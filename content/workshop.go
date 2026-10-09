package content

import (
	"fmt"
	"slices"

	contentv1 "glimway/gen/glimway/content/v1"
)

// Goods on the move (mail, chests, gifts, crafting output). Kind is
// "material", "item" (any other stack), "decoration" (a home good) or
// "instance" (one tool, off-hand item, carry gear or fitting, by Instance).
// Maker picks one maker's stack ("" = unmarked); absent takes any, unmarked
// first.
type (
	Asset       = contentv1.Asset
	UtilityItem = contentv1.UtilityItem
	Recipe      = contentv1.Recipe
	RecipeSwap  = contentv1.RecipeSwap
	Crafting    = contentv1.Crafting
	Project     = contentv1.Project
	Projects    = contentv1.Projects
)

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

// ValidMaterialCosts: a non-empty bill of Wilds materials.
func ValidMaterialCosts(costs map[string]int32) bool {
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

// DecodeCrafting reads crafting JSON into the generated types, refusing
// nulls and unknown keys, then runs the schema's rules (protovalidate) and
// the workshops' own rules.
func DecodeCrafting(raw []byte) (*Crafting, error) {
	doc := &Crafting{}
	if err := decodeContentProto(raw, "crafting", doc); err != nil {
		return doc, err
	}
	if err := contentValidate("crafting", entryLists(doc, "utility_items", "recipes", "hearth_recipes"), doc); err != nil {
		return doc, err
	}
	return doc, validateCrafting(doc)
}

// validateCrafting: the rules that span entries or families. Parts and
// recipe ids are unique across both lists (one `duplicate id` per id); a
// utility item is a catalogue part under its catalogue name; a bill names
// carried stacks; swaps stand in for a bill line; outputs resolve, tier 2
// on the bench, tier 1 at the hearth, and a found recipe names its page.
func validateCrafting(c *Crafting) error {
	items := map[string]bool{}
	recipes := map[string]bool{}
	for _, i := range c.UtilityItems {
		d, ok := ItemFor(i.GetId())
		if items[i.GetId()] {
			return fmt.Errorf("invalid crafting: duplicate id %s", i.GetId())
		}
		if i.GetName() == "" || !ok || d.Kind != "part" || d.Name != i.GetName() {
			return fmt.Errorf("invalid crafting: utility item %s", i.GetId())
		}
		items[i.GetId()] = true
	}
	// A bench recipe: tier 2, its output any catalogue good.
	for _, r := range c.Recipes {
		if recipes[r.GetId()] {
			return fmt.Errorf("invalid crafting: duplicate id %s", r.GetId())
		}
		if r.GetMinTier() != 2 || !validStackCosts(r.GetMaterials(), itemsByID) || !validateSwaps(r, itemsByID) {
			return fmt.Errorf("invalid crafting: recipe %s", r.GetId())
		}
		switch r.GetOutput().GetKind() {
		case "decoration":
			d, ok := HomeItemFor(r.GetOutput().GetId())
			if !ok || int32(d.MinTier) > r.GetMinTier() {
				return fmt.Errorf("invalid crafting: recipe %s output", r.GetId())
			}
		case "item", "instance":
			d, ok := ItemFor(r.GetOutput().GetId())
			if !ok || ItemAssetKind(d) != r.GetOutput().GetKind() || (r.GetOutput().GetKind() == "instance" && r.GetOutput().GetQty() != 1) {
				return fmt.Errorf("invalid crafting: recipe %s output", r.GetId())
			}
		default:
			return fmt.Errorf("invalid crafting: recipe %s output", r.GetId())
		}
		recipes[r.GetId()] = true
	}
	// A hearth recipe: tier 1, its output a carried stack, and a found
	// recipe names the page that teaches it (a starting recipe names
	// neither).
	for _, r := range c.HearthRecipes {
		if recipes[r.GetId()] {
			return fmt.Errorf("invalid crafting: duplicate id %s", r.GetId())
		}
		if r.GetMinTier() != 1 || !validStackCosts(r.GetMaterials(), itemsByID) || !validateSwaps(r, itemsByID) {
			return fmt.Errorf("invalid crafting: hearth recipe %s", r.GetId())
		}
		if (r.GetPage() == "") != (r.GetFound() == "") {
			return fmt.Errorf("invalid crafting: hearth recipe %s page", r.GetId())
		}
		if r.GetPage() != "" {
			d, ok := ItemFor(r.GetPage())
			if !ok || d.Kind != "paper" {
				return fmt.Errorf("invalid crafting: hearth recipe %s page", r.GetId())
			}
		}
		if r.GetOutput().GetKind() != "item" && r.GetOutput().GetKind() != "material" {
			return fmt.Errorf("invalid crafting: hearth recipe %s output", r.GetId())
		}
		d, ok := ItemFor(r.GetOutput().GetId())
		if !ok || ItemAssetKind(d) != r.GetOutput().GetKind() {
			return fmt.Errorf("invalid crafting: hearth recipe %s output", r.GetId())
		}
		recipes[r.GetId()] = true
	}
	return nil
}

func LoadCrafting() (*Crafting, error) {
	raw, err := FS.ReadFile("crafting.json")
	if err != nil {
		return nil, err
	}
	return DecodeCrafting(raw)
}

var CraftingRules = func() *Crafting {
	c, err := LoadCrafting()
	if err != nil {
		panic(err)
	}
	return c
}()

func RecipeFor(id string) (*Recipe, bool) {
	for _, r := range CraftingRules.Recipes {
		if r.GetId() == id {
			return r, true
		}
	}
	return nil, false
}
func HearthRecipeFor(id string) (*Recipe, bool) {
	for _, r := range CraftingRules.HearthRecipes {
		if r.GetId() == id {
			return r, true
		}
	}
	return nil, false
}

// DecodeProjects reads projects JSON into the generated types, refusing
// nulls and unknown keys, then runs the schema's rules (protovalidate) and
// the projects' own rules.
func DecodeProjects(raw []byte) (*Projects, error) {
	doc := &Projects{}
	if err := decodeContentProto(raw, "projects", doc); err != nil {
		return doc, err
	}
	if err := contentValidate("projects", entryLists(doc, "projects"), doc); err != nil {
		return doc, err
	}
	return doc, validateProjects(doc)
}

// validateProjects: the rules that span families. The bill names Wilds
// materials; each paper is a village-project paper turned in once; and
// every authored project paper has a completion path.
func validateProjects(p *Projects) error {
	ids := map[string]bool{}
	papers := map[string]bool{}
	for _, v := range p.Projects {
		if ids[v.GetId()] {
			return fmt.Errorf("invalid projects: duplicate id %s", v.GetId())
		}
		if !ValidMaterialCosts(v.GetMaterials()) {
			return fmt.Errorf("invalid projects: %s materials", v.GetId())
		}
		ids[v.GetId()] = true
		for _, id := range v.GetPapers() {
			paper, ok := PapersByID[id]
			if !ok || paper.Source != "village-project" {
				return fmt.Errorf("invalid projects: %s paper %s", v.GetId(), id)
			}
			if papers[id] {
				return fmt.Errorf("invalid projects: duplicate paper %s", id)
			}
			papers[id] = true
		}
	}
	for id, paper := range PapersByID {
		if paper.Source == "village-project" && !papers[id] {
			return fmt.Errorf("invalid projects: paper without a project %s", id)
		}
	}
	return nil
}

func LoadProjects() (*Projects, error) {
	raw, err := FS.ReadFile("projects.json")
	if err != nil {
		return nil, err
	}
	return DecodeProjects(raw)
}

var ProjectRules = func() *Projects {
	p, err := LoadProjects()
	if err != nil {
		panic(err)
	}
	return p
}()

func ProjectFor(id string) (*Project, bool) {
	for _, p := range ProjectRules.Projects {
		if p.GetId() == id {
			return p, true
		}
	}
	return nil, false
}

// validStackCosts: a non-empty bill of carried stackable items.
func validStackCosts(costs map[string]int32, defs map[string]*ItemDef) bool {
	if len(costs) == 0 {
		return false
	}
	for id, n := range costs {
		d, ok := defs[id]
		if !ok || !ItemStackable(d) || n < 1 || n > 1000000 {
			return false
		}
	}
	return true
}

// validateSwaps: a swap names a material on the bill and stand-ins that
// are carried stacks of their own, never a bill item or a repeat.
func validateSwaps(r *Recipe, defs map[string]*ItemDef) bool {
	for key, swaps := range r.GetSwaps() {
		if _, ok := r.GetMaterials()[key]; !ok || len(swaps.GetStandIns()) == 0 {
			return false
		}
		for _, s := range swaps.GetStandIns() {
			if s == key {
				return false
			}
			if _, onBill := r.GetMaterials()[s]; onBill {
				return false
			}
			d, ok := defs[s]
			if !ok || !ItemStackable(d) {
				return false
			}
		}
	}
	return true
}
