package content

import (
	"testing"
)

func TestRepairsContent(t *testing.T) {
	r, err := LoadRepairs()
	if err != nil {
		t.Fatalf("failed to load repairs: %v", err)
	}
	if len(r.Repairs) != 6 {
		t.Fatalf("expected 6 repairs, got %d", len(r.Repairs))
	}
	if r.Rules.MaxOpen != 3 {
		t.Fatalf("expected MaxOpen 3, got %d", r.Rules.MaxOpen)
	}
	if len(r.Rules.Scripted) != 2 || r.Rules.Scripted[0] != "well-rope" || r.Rules.Scripted[1] != "fence-rail" {
		t.Fatalf("unexpected scripted repairs: %v", r.Rules.Scripted)
	}

	well, ok := RepairFor("well-rope")
	if !ok || well.Part != "fibre-rope" || well.Target != "well" || well.Pos.TX != 13 || well.Pos.TY != 12 {
		t.Fatalf("unexpected well-rope definition: %+v", well)
	}
	if well.Resident != "hazel" || well.Reaction != "Bread tastes of the well again." {
		t.Fatalf("unexpected well-rope resident reaction: %+v", well)
	}
	if well.Gift == nil || well.Gift.ID != "keepers-twists" || well.Gift.Qty != 1 {
		t.Fatalf("expected well-rope twist gift: %+v", well.Gift)
	}

	fence, ok := RepairFor("fence-rail")
	if !ok || fence.Part != "split-rail" || fence.Pos.TX != 27 || fence.Pos.TY != 18 || fence.Resident != "silas" {
		t.Fatalf("unexpected fence-rail definition: %+v", fence)
	}

	library, ok := RepairFor("library-roof")
	if !ok || library.Part != "slates" || library.Resident != "mara" {
		t.Fatalf("unexpected library-roof definition: %+v", library)
	}

	bench, ok := RepairFor("bench-slat")
	if !ok || bench.Part != "oak-slat" || bench.Resident != "orrin" {
		t.Fatalf("unexpected bench-slat definition: %+v", bench)
	}

	lamp, ok := RepairFor("village-lamp")
	if !ok || lamp.Part != "lamp-wick" || lamp.Resident != "ada" {
		t.Fatalf("unexpected village-lamp definition: %+v", lamp)
	}

	hame, ok := RepairFor("gate-hame")
	if !ok || hame.Part != "oilcloth-wrap" || hame.Area != "commons" || hame.Resident != "silas" {
		t.Fatalf("unexpected gate-hame definition: %+v", hame)
	}
}
