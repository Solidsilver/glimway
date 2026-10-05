package content

import (
	"encoding/json"
	"testing"
)

func TestHomesteadContent(t *testing.T) {
	h, err := LoadHomestead()
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"Campsite", "Cottage", "Workshop", "Garden", "Hall"}
	for i, tier := range h.Tiers {
		if tier.Name != want[i] {
			t.Fatal("tier identity")
		}
	}
	if h.Tiers[1].Embers != 15 || len(h.Items) != 14 {
		t.Fatal("starting content")
	}
	for _, v := range h.Items {
		if v.Embers > 0 && (v.Embers < 2 || v.Embers > 6) {
			t.Fatal("ember price")
		}
		for _, n := range v.Materials {
			if n < 4 || n > 10 {
				t.Fatal("material price")
			}
		}
	}
}
func TestHomesteadRejectsMalformed(t *testing.T) {
	for name, mutate := range map[string]func(*Homestead){
		"grid": func(h *Homestead) { h.Indoor.Width = 0 }, "duplicate": func(h *Homestead) { h.Items[1].ID = h.Items[0].ID }, "price": func(h *Homestead) { h.Items[0].Embers = -1 }, "mixed-price": func(h *Homestead) { h.Items[0].Materials = map[string]int{"stone": 1} }, "unknown-material": func(h *Homestead) { h.Items[8].Materials = map[string]int{"gold": 1} }, "zero-material": func(h *Homestead) { h.Items[8].Materials = map[string]int{"stone": 0} }, "footprint": func(h *Homestead) { h.Items[0].Footprint = []int{1, 1, 1} }, "location": func(h *Homestead) { h.Items[0].Where = []string{"attic"} }, "tier": func(h *Homestead) { h.Tiers[3].Purchasable = true }, "min-tier": func(h *Homestead) { h.Items[0].MinTier = 5 }, "category": func(h *Homestead) { h.Items[0].Category = "weapon" }, "layout": func(h *Homestead) { h.Commons.Columns = 0 },
	} {
		t.Run(name, func(t *testing.T) {
			var h Homestead
			b, _ := json.Marshal(HomeRules)
			if err := json.Unmarshal(b, &h); err != nil {
				t.Fatal(err)
			}
			mutate(&h)
			if ValidateHomestead(h) == nil {
				t.Fatal("accepted invalid content")
			}
		})
	}
}
