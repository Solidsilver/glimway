package content

import (
	"testing"
)

// Every repair's part must have a source a player can get: a bench recipe's
// output, or a pickup lying in the world. A part with no source stalls the
// chore list for good (the review's finding 1).
func TestRepairPartsHaveASource(t *testing.T) {
	r, err := LoadRepairs()
	if err != nil {
		t.Fatalf("failed to load repairs: %v", err)
	}
	c, err := LoadCrafting()
	if err != nil {
		t.Fatalf("failed to load crafting: %v", err)
	}
	sources := map[string]bool{}
	for _, rec := range c.GetRecipes() {
		if rec.GetOutput().GetKind() == "item" {
			sources[rec.GetOutput().GetId()] = true
		}
	}
	for _, p := range ItemsRules.GetPickups() {
		sources[p.GetItem()] = true
	}
	for _, v := range r.GetRepairs() {
		if !sources[v.GetPart()] {
			t.Errorf("repair %s needs %s, which has no recipe or pickup", v.GetId(), v.GetPart())
		}
	}
}

func TestRepairsContent(t *testing.T) {
	r, err := LoadRepairs()
	if err != nil {
		t.Fatalf("failed to load repairs: %v", err)
	}
	if len(r.GetRepairs()) != 6 {
		t.Fatalf("expected 6 repairs, got %d", len(r.GetRepairs()))
	}
	if r.GetRules().GetMaxOpen() != 3 {
		t.Fatalf("expected MaxOpen 3, got %d", r.GetRules().GetMaxOpen())
	}
	if len(r.GetRules().GetScripted()) != 2 || r.GetRules().GetScripted()[0] != "well-rope" || r.GetRules().GetScripted()[1] != "fence-rail" {
		t.Fatalf("unexpected scripted repairs: %v", r.GetRules().GetScripted())
	}

	well, ok := RepairFor("well-rope")
	if !ok || well.GetPart() != "fibre-rope" || well.GetTarget() != "well" || well.GetPos().GetTx() != 13 || well.GetPos().GetTy() != 12 {
		t.Fatalf("unexpected well-rope definition: %+v", well)
	}
	if well.GetResident() != "hazel" || well.GetReaction() != "Bread tastes of the well again." {
		t.Fatalf("unexpected well-rope resident reaction: %+v", well)
	}
	if well.GetGift() == nil || well.GetGift().GetId() != "keepers-twists" || well.GetGift().GetQty() != 1 {
		t.Fatalf("expected well-rope twist gift: %+v", well.Gift)
	}

	fence, ok := RepairFor("fence-rail")
	if !ok || fence.GetPart() != "split-rail" || fence.GetPos().GetTx() != 27 || fence.GetPos().GetTy() != 18 || fence.GetResident() != "silas" {
		t.Fatalf("unexpected fence-rail definition: %+v", fence)
	}

	library, ok := RepairFor("library-roof")
	if !ok || library.GetPart() != "slates" || library.GetResident() != "mara" {
		t.Fatalf("unexpected library-roof definition: %+v", library)
	}

	bench, ok := RepairFor("bench-slat")
	if !ok || bench.GetPart() != "oak-slat" || bench.GetResident() != "orrin" {
		t.Fatalf("unexpected bench-slat definition: %+v", bench)
	}

	lamp, ok := RepairFor("village-lamp")
	if !ok || lamp.GetPart() != "lamp-wick" || lamp.GetResident() != "ada" {
		t.Fatalf("unexpected village-lamp definition: %+v", lamp)
	}

	hame, ok := RepairFor("gate-hame")
	if !ok || hame.GetPart() != "oilcloth-wrap" || hame.GetArea() != "commons" || hame.GetResident() != "silas" {
		t.Fatalf("unexpected gate-hame definition: %+v", hame)
	}
}
