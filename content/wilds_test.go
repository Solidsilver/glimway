package content

import (
	"testing"
)

func TestWildsLoaderVectors(t *testing.T) {
	var vectors struct {
		Loader []loaderVector
	}
	readVectors(t, "wilds", &vectors)
	base, _ := FS.ReadFile("wilds.json")
	if len(vectors.Loader) == 0 {
		t.Fatal("no loader vectors")
	}
	for _, v := range vectors.Loader {
		t.Run("loader/"+v.Name, func(t *testing.T) {
			_, err := DecodeWilds(editVector(t, base, v))
			if (err == nil) != v.Valid {
				t.Fatal(v.Valid, err)
			}
			if !v.Valid && v.Rule != "" {
				checkVectorRule(t, err, v.Rule)
			}
		})
	}
}

// The open map's catalogue (docs/design/open-map.md 2.1, 2.7, 2.10): the
// shapes the lanes after O-A read.
func TestWildsOpenMapCatalogue(t *testing.T) {
	w := WildsRules
	if w.GetGeneratorVersion() != 3 || w.GetRealm() != "hearthwick" {
		t.Fatal(w.GetGeneratorVersion(), w.GetRealm())
	}
	tangle, quiet := WildsPlaceByID("tangle"), WildsPlaceByID("whitequiet")
	if tangle.GetCx() != -1 || tangle.GetCy() != -2 || tangle.GetEpochKind() != "still" || tangle.GetTier() != 1 {
		t.Fatal("the Tangle is the still 3x3 at cx -1..1, cy -2..0, tier 1")
	}
	if quiet.GetCx() != -1 || quiet.GetCy() != -5 || quiet.GetEpochKind() != "wick" || quiet.GetTier() != 2 {
		t.Fatal("the Whitequiet is the wick 3x3 at cx -1..1, cy -5..-3, tier 2")
	}
	if f := w.GetFrontier(); f.GetReach() != 3 || f.GetSouthLimit() != 0 {
		t.Fatal("frontier reach 3, south limit 0")
	}
	for _, id := range []string{"discovery", "rumour"} {
		if _, ok := w.LootTables[id]; !ok {
			t.Fatal("missing loot table", id)
		}
	}
	if w.LootTables["rumour"].GetTrinketChancePermille() <= w.GetTrinketChancePermille() {
		t.Fatal("the rumour's find has the higher trinket chance")
	}
}

// Clearing names a tool by its action (items.json `actions`), and laying
// debits a pack material: both must exist in the item catalogue.
func TestWildsPathsMeetTheItems(t *testing.T) {
	actions := map[string]bool{}
	kinds := map[string]string{}
	for _, d := range ItemsRules.Items {
		kinds[d.GetId()] = d.GetKind()
		if d.GetKind() == "tool" {
			for _, a := range d.GetActions() {
				actions[a] = true
			}
		}
	}
	for _, c := range WildsRules.GetPaths().GetClearTools() {
		if !actions[c.GetAction()] {
			t.Errorf("no tool can %s (clearing %s)", c.GetAction(), c.GetDecor())
		}
	}
	for _, l := range WildsRules.GetPaths().GetLay() {
		if kinds[l.GetMaterial()] != "material" {
			t.Errorf("laying %s debits %s, which is not a material item", l.GetKind(), l.GetMaterial())
		}
	}
}

// The v2 bridge reads generator v2's regions off the footprints.
func TestWildsV2Bridge(t *testing.T) {
	want := []struct {
		id, kind string
	}{{"inner-1", "inner"}, {"outer-1", "outer"}}
	for i, r := range WildsV2Regions {
		if r.GetId() != want[i].id || r.GetKind() != want[i].kind || r.GetGridWidth() != 3 || r.GetGridHeight() != 3 || r.GetEntryX() != 1 || r.GetEntryY() != 1 {
			t.Fatalf("region %d: %+v", i, r)
		}
	}
}
