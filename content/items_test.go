package content

import (
	"encoding/json"
	"os"
	"testing"
)

func TestItemsLoadAndDerivedRules(t *testing.T) {
	v, err := LoadItems()
	if err != nil {
		t.Fatal(err)
	}
	if len(v.Items) < 30 || len(v.Pickups) < 3 {
		t.Fatal("representative set", len(v.Items), len(v.Pickups))
	}
	axe, _ := ItemFor("bench-axe")
	if !axe.Instanced() || axe.Stackable() || axe.AssetKind() != "instance" || axe.AtZeroRule() != "breaks" || axe.SlotCount() != 1 || axe.MaxPoints() != 90 || !axe.Giveable() {
		t.Fatal("cheap tool", axe)
	}
	brack, _ := ItemFor("brack-felling-axe")
	if brack.AtZeroRule() != "blunt" || brack.SlotCount() != 3 || brack.Giveable() || brack.MaxPoints() != 240 || brack.Repair == nil {
		t.Fatal("heirloom", brack)
	}
	pole, _ := ItemFor("nans-lamplighter-pole")
	if pole.AtZeroRule() != "cracked" || !pole.OffHandable() {
		t.Fatal("cracked heirloom")
	}
	punch, _ := ItemFor("oak-mark-punch")
	if punch.AtZeroRule() != "never" || punch.MaxPoints() != 0 || punch.SlotCount() != 0 {
		t.Fatal("special tool")
	}
	nail, _ := ItemFor("loose-road-nail")
	sliver, _ := ItemFor("warden-sliver")
	if !nail.Instanced() || nail.MaxPoints() != 90 || sliver.MaxPoints() != 0 {
		t.Fatal("fittings")
	}
	timber, _ := ItemFor("timber")
	twists, _ := ItemFor("keepers-twists")
	salve, _ := ItemFor("comfrey-salve")
	if timber.AssetKind() != "material" || !twists.UsableNow() || salve.UsableNow() || twists.AssetKind() != "item" {
		t.Fatal("stacks")
	}
	fox, _ := ItemFor("whittled-fox")
	glove, _ := ItemFor("work-glove")
	whistle, _ := ItemFor("tin-whistle")
	if fox.Giveable() || !glove.Giveable() || !whistle.OffHandable() || glove.OffHandable() {
		t.Fatal("keepsakes")
	}
	if StackCurrency("timber") != "material:timber" || StackCurrency("lamp-wick") != "item:lamp-wick" {
		t.Fatal("currency")
	}
	for _, id := range append(append([]string{}, WildsRules.Materials...), WildsRules.Trinkets...) {
		if _, ok := ItemFor(id); !ok {
			t.Fatal("missing", id)
		}
	}
	for _, u := range CraftingRules.UtilityItems {
		if d, ok := ItemFor(u.ID); !ok || d.Kind != "part" {
			t.Fatal("utility", u.ID)
		}
	}
}

func TestItemsValidationRejectsMalformedRows(t *testing.T) {
	cases := map[string]func(*Items){
		"duplicate":            func(v *Items) { v.Items[1].ID = v.Items[0].ID },
		"bad id":               func(v *Items) { v.Items[0].ID = "Bench Axe" },
		"unknown kind":         func(v *Items) { v.Items[0].Kind = "weapon" },
		"tab mismatch":         func(v *Items) { v.Items[0].Tab = "supplies" },
		"no blurb":             func(v *Items) { v.Items[0].Blurb = "" },
		"tool without grade":   func(v *Items) { v.Items[0].Grade = "" },
		"cheap tool no uses":   func(v *Items) { v.Items[0].Uses = 0 },
		"cheap tool blunt":     func(v *Items) { v.Items[0].AtZero = "blunt" },
		"unknown action":       func(v *Items) { v.Items[0].Actions = []string{"juggle"} },
		"cheap tool repair":    func(v *Items) { v.Items[0].Repair = &ItemRepair{Bench: map[string]int{"timber": 1}} },
		"heirloom no repair":   func(v *Items) { find(v, "brack-felling-axe").Repair = nil },
		"repair unknown":       func(v *Items) { find(v, "brack-felling-axe").Repair.Bench = map[string]int{"gold": 1} },
		"repair instance":      func(v *Items) { find(v, "brack-felling-axe").Repair.Bench = map[string]int{"bench-axe": 1} },
		"grade on material":    func(v *Items) { find(v, "timber").Grade = "cheap" },
		"fitting without kind": func(v *Items) { find(v, "loose-road-nail").Fitting = "" },
		"fitting kind unknown": func(v *Items) { find(v, "loose-road-nail").Fitting = "sparkle" },
		"consumable no use":    func(v *Items) { find(v, "oatcakes").Use = nil },
		"use on keepsake":      func(v *Items) { find(v, "work-glove").Use = []ItemEffect{{Type: "restore-hp", Amount: 1}} },
		"unknown use effect":   func(v *Items) { find(v, "oatcakes").Use = []ItemEffect{{Type: "fly"}} },
		"restore nothing":      func(v *Items) { find(v, "oatcakes").Use = []ItemEffect{{Type: "restore-hp"}} },
		"pocket on tool":       func(v *Items) { v.Items[0].Pocket = []ItemEffect{{Type: "papers-glint"}} },
		"held on plain item":   func(v *Items) { find(v, "work-glove").Held = []ItemEffect{{Type: "light"}} },
		"off hand no held":     func(v *Items) { find(v, "carters-lantern").Held = nil },
		"affinity class":       func(v *Items) { find(v, "carters-lantern").Affinity.Class = "bard" },
		"home good unknown":    func(v *Items) { find(v, "tool-rack").ID = "tool-shed" },
		"trinket missing":      func(v *Items) { v.Items = without(v.Items, "whittled-fox") },
		"material missing":     func(v *Items) { v.Items = without(v.Items, "amber") },
		"pickup unknown":       func(v *Items) { v.Pickups[0].Item = "gold" },
		"pickup two tools":     func(v *Items) { findPickup(v, "dropped-bucket").Qty = 2 },
		"pickup worn too far":  func(v *Items) { findPickup(v, "dropped-bucket").UsesLeft = 999 },
		"pickup area":          func(v *Items) { v.Pickups[0].Area = "wilds" },
		"wear":                 func(v *Items) { v.Rules.Wear.HoldPointsPerUse = 9 },
		"pockets":              func(v *Items) { v.Rules.Pockets.WithCarryGear = 0 },
		"mender area":          func(v *Items) { v.Rules.Menders[0].Area = "moon" },
		"grade missing":        func(v *Items) { delete(v.Rules.Grades, "heirloom") },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			var copy Items
			if err := json.Unmarshal([]byte(mustJSON(ItemsRules)), &copy); err != nil {
				t.Fatal(err)
			}
			if err := ValidateItems(copy); err != nil {
				t.Fatal("baseline", err)
			}
			mutate(&copy)
			if ValidateItems(copy) == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func TestCraftingOutputsMatchItemKinds(t *testing.T) {
	for _, r := range CraftingRules.Recipes {
		if r.Output.Kind == "decoration" {
			continue
		}
		d, ok := ItemFor(r.Output.ID)
		if !ok || d.AssetKind() != r.Output.Kind {
			t.Fatal(r.ID)
		}
	}
	var c Crafting
	json.Unmarshal([]byte(mustJSON(CraftingRules)), &c)
	for i := range c.Recipes {
		if c.Recipes[i].Output.ID == "bench-axe" {
			c.Recipes[i].Output.Kind = "item"
		}
	}
	if ValidateCrafting(c) == nil {
		t.Fatal("a tool crafted as a stack")
	}
}

func find(v *Items, id string) *ItemDef {
	for i := range v.Items {
		if v.Items[i].ID == id {
			return &v.Items[i]
		}
	}
	panic(id)
}
func findPickup(v *Items, id string) *ItemPickup {
	for i := range v.Pickups {
		if v.Pickups[i].ID == id {
			return &v.Pickups[i]
		}
	}
	panic(id)
}
func without(list []ItemDef, id string) []ItemDef {
	out := []ItemDef{}
	for _, d := range list {
		if d.ID != id {
			out = append(out, d)
		}
	}
	return out
}

// The TypeScript loader derives the same rules (npm run vectors:items writes
// content/vectors/items.json from src/lib/items.ts).
func TestItemsParityWithTypeScript(t *testing.T) {
	raw, err := os.ReadFile("vectors/items.json")
	if err != nil {
		t.Fatal(err)
	}
	var want []struct {
		ID        string `json:"id"`
		Instanced bool   `json:"instanced"`
		Stackable bool   `json:"stackable"`
		AssetKind string `json:"assetKind"`
		AtZero    string `json:"atZero"`
		Slots     int    `json:"slots"`
		MaxPoints int    `json:"maxPoints"`
		Giveable  bool   `json:"giveable"`
		UsableNow bool   `json:"usableNow"`
		OffHand   bool   `json:"offHand"`
	}
	if err = json.Unmarshal(raw, &want); err != nil {
		t.Fatal(err)
	}
	if len(want) != len(ItemsRules.Items) {
		t.Fatal("vectors are stale: run npm run vectors:items")
	}
	for i, w := range want {
		d := ItemsRules.Items[i]
		if d.ID != w.ID || d.Instanced() != w.Instanced || d.Stackable() != w.Stackable || d.AssetKind() != w.AssetKind || d.AtZeroRule() != w.AtZero || d.SlotCount() != w.Slots || d.MaxPoints() != w.MaxPoints || d.Giveable() != w.Giveable || d.UsableNow() != w.UsableNow || d.OffHandable() != w.OffHand {
			t.Fatalf("%s: go and typescript disagree", w.ID)
		}
	}
}
