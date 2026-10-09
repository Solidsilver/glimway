package content

import (
	"encoding/json"
	"os"
	"testing"

	"google.golang.org/protobuf/encoding/protojson"
	"google.golang.org/protobuf/proto"
)

func TestItemHelpers(t *testing.T) {
	axe, _ := ItemFor("bench-axe")
	if !ItemInstanced(axe) || ItemStackable(axe) || ItemAssetKind(axe) != "instance" || ItemAtZeroRule(axe) != "breaks" || ItemSlotCount(axe) != 1 || ItemMaxPoints(axe) != 90 || !ItemGiveable(axe) {
		t.Fatal("cheap tool", axe)
	}
	brack, _ := ItemFor("brack-felling-axe")
	if ItemAtZeroRule(brack) != "blunt" || ItemSlotCount(brack) != 3 || ItemGiveable(brack) || ItemMaxPoints(brack) != 240 || brack.GetRepair() == nil {
		t.Fatal("heirloom", brack)
	}
	pole, _ := ItemFor("nans-lamplighter-pole")
	if ItemAtZeroRule(pole) != "cracked" || !ItemOffHandable(pole) {
		t.Fatal("cracked heirloom")
	}
	punch, _ := ItemFor("oak-mark-punch")
	if ItemAtZeroRule(punch) != "never" || ItemMaxPoints(punch) != 0 || ItemSlotCount(punch) != 0 {
		t.Fatal("special tool")
	}
	nail, _ := ItemFor("loose-road-nail")
	sliver, _ := ItemFor("warden-sliver")
	if !ItemInstanced(nail) || ItemMaxPoints(nail) != 90 || ItemMaxPoints(sliver) != 0 {
		t.Fatal("fittings")
	}
	timber, _ := ItemFor("timber")
	twists, _ := ItemFor("keepers-twists")
	salve, _ := ItemFor("comfrey-salve")
	// The salve's unmoored-clearing is implemented (the warden work), so it
	// is usable now, as the twists are.
	if ItemAssetKind(timber) != "material" || !ItemUsableNow(salve) || !ItemUsableNow(twists) || ItemAssetKind(twists) != "item" {
		t.Fatal("stacks")
	}
	fox, _ := ItemFor("whittled-fox")
	glove, _ := ItemFor("work-glove")
	whistle, _ := ItemFor("tin-whistle")
	if ItemGiveable(fox) || !ItemGiveable(glove) || !ItemOffHandable(whistle) || ItemOffHandable(glove) {
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
	for _, u := range CraftingRules.GetUtilityItems() {
		if d, ok := ItemFor(u.GetId()); !ok || d.GetKind() != "part" {
			t.Fatal("utility", u.GetId())
		}
	}
}

// decodeSpliced re-marshals a spliced message with protojson and decodes it
// the way the loader does (schema rules included).
func decodeSplicedItems(t *testing.T, v *Items) error {
	t.Helper()
	raw, err := protojson.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	_, err = DecodeItems(raw)
	return err
}

func TestItemsValidationRejectsMalformedRows(t *testing.T) {
	cases := map[string]func(*Items){
		"duplicate":            func(v *Items) { v.Items[1].Id = v.Items[0].GetId() },
		"bad id":               func(v *Items) { v.Items[0].Id = "Bench Axe" },
		"unknown kind":         func(v *Items) { v.Items[0].Kind = "weapon" },
		"tab mismatch":         func(v *Items) { v.Items[0].Tab = "supplies" },
		"no blurb":             func(v *Items) { v.Items[0].Blurb = "" },
		"tool without grade":   func(v *Items) { v.Items[0].Grade = proto.String("") },
		"cheap tool no uses":   func(v *Items) { v.Items[0].Uses = proto.Int32(0) },
		"cheap tool blunt":     func(v *Items) { v.Items[0].AtZero = proto.String("blunt") },
		"unknown action":       func(v *Items) { v.Items[0].Actions = []string{"juggle"} },
		"cheap tool repair":    func(v *Items) { v.Items[0].Repair = &ItemRepair{Bench: map[string]int32{"timber": 1}} },
		"heirloom no repair":   func(v *Items) { find(v, "brack-felling-axe").Repair = nil },
		"repair unknown":       func(v *Items) { find(v, "brack-felling-axe").Repair.Bench = map[string]int32{"gold": 1} },
		"repair instance":      func(v *Items) { find(v, "brack-felling-axe").Repair.Bench = map[string]int32{"bench-axe": 1} },
		"grade on material":    func(v *Items) { find(v, "timber").Grade = proto.String("cheap") },
		"fitting without kind": func(v *Items) { find(v, "loose-road-nail").Fitting = "" },
		"fitting kind unknown": func(v *Items) { find(v, "loose-road-nail").Fitting = "sparkle" },
		"consumable no use":    func(v *Items) { find(v, "oatcakes").Use = nil },
		"use on keepsake":      func(v *Items) { find(v, "work-glove").Use = []*UseEffect{{Type: "restore-hp", Amount: proto.Int32(1)}} },
		"unknown use effect":   func(v *Items) { find(v, "oatcakes").Use = []*UseEffect{{Type: "fly"}} },
		"restore nothing":      func(v *Items) { find(v, "oatcakes").Use = []*UseEffect{{Type: "restore-hp"}} },
		"pocket on tool":       func(v *Items) { v.Items[0].Pocket = []*PocketEffect{{Type: "papers-glint"}} },
		"held on plain item":   func(v *Items) { find(v, "work-glove").Held = []*HeldEffect{{Type: "light"}} },
		"off hand no held":     func(v *Items) { find(v, "carters-lantern").Held = nil },
		"affinity class":       func(v *Items) { find(v, "carters-lantern").Affinity.Class = "bard" },
		"home good unknown":    func(v *Items) { find(v, "tool-rack").Id = "tool-shed" },
		"trinket missing":      func(v *Items) { v.Items = without(v.Items, "whittled-fox") },
		"material missing":     func(v *Items) { v.Items = without(v.Items, "amber") },
		"pickup unknown":       func(v *Items) { v.Pickups[0].Item = "gold" },
		"pickup two tools":     func(v *Items) { findPickup(v, "dropped-bucket").Qty = 2 },
		"pickup worn too far":  func(v *Items) { findPickup(v, "dropped-bucket").UsesLeft = proto.Int32(999) },
		"pickup area":          func(v *Items) { v.Pickups[0].Area = "wilds" },
		"wear":                 func(v *Items) { v.Rules.Wear.HoldPointsPerUse = 9 },
		"pockets":              func(v *Items) { v.Rules.Pockets.WithCarryGear = 0 },
		"mender area":          func(v *Items) { v.Rules.Menders[0].Area = "moon" },
		"grade missing":        func(v *Items) { delete(v.Rules.Grades, "heirloom") },
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			copy := proto.Clone(ItemsRules).(*Items)
			mutate(copy)
			if err := decodeSplicedItems(t, copy); err == nil {
				t.Fatal("accepted")
			}
		})
	}
}

func TestCraftingOutputsMatchItemKinds(t *testing.T) {
	for _, r := range CraftingRules.GetRecipes() {
		if r.GetOutput().GetKind() == "decoration" {
			continue
		}
		d, ok := ItemFor(r.GetOutput().GetId())
		if !ok || ItemAssetKind(d) != r.GetOutput().GetKind() {
			t.Fatal(r.GetId())
		}
	}
	c := proto.Clone(CraftingRules).(*Crafting)
	for _, r := range c.Recipes {
		if r.GetOutput().GetId() == "bench-axe" {
			r.Output.Kind = "item"
		}
	}
	raw, err := protojson.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = DecodeCrafting(raw); err == nil {
		t.Fatal("a tool crafted as a stack")
	}
}

func find(v *Items, id string) *ItemDef {
	for _, d := range v.Items {
		if d.GetId() == id {
			return d
		}
	}
	panic(id)
}
func findPickup(v *Items, id string) *ItemPickup {
	for _, p := range v.Pickups {
		if p.GetId() == id {
			return p
		}
	}
	panic(id)
}
func without(list []*ItemDef, id string) []*ItemDef {
	out := []*ItemDef{}
	for _, d := range list {
		if d.GetId() != id {
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
		if d.GetId() != w.ID || ItemInstanced(d) != w.Instanced || ItemStackable(d) != w.Stackable || ItemAssetKind(d) != w.AssetKind || ItemAtZeroRule(d) != w.AtZero || ItemSlotCount(d) != w.Slots || ItemMaxPoints(d) != w.MaxPoints || ItemGiveable(d) != w.Giveable || ItemUsableNow(d) != w.UsableNow || ItemOffHandable(d) != w.OffHand {
			t.Fatalf("%s: go and typescript disagree", w.ID)
		}
	}
}

func TestItemsLoaderVectors(t *testing.T) {
	runLoaderVectors(t, "items", "items-loader", func(raw []byte) (any, error) { return DecodeItems(raw) })
}
