package content

import "testing"

// The crafts tables (design 4.1 and 5.4): shared loader vectors for
// abilities and fishing, the same files the TypeScript tests replay.
func TestCraftsLoaderVectors(t *testing.T) {
	runLoaderVectors(t, "abilities", "abilities", func(raw []byte) (any, error) { return DecodeAbilities(raw) })
	runLoaderVectors(t, "fishing", "fishing", func(raw []byte) (any, error) { return DecodeFishing(raw) })
}

// The shipped tables: the design's numbers, and the lookups lanes B-G read.
func TestCraftsContent(t *testing.T) {
	a := AbilitiesRules
	if len(a.GetAbilities()) != 8 {
		t.Fatal("abilities")
	}
	if SignatureMana("warrior") != 12 || SignatureMana("mage") != 15 || SignatureMana("rogue") != 10 || SignatureMana("healer") != 18 || SignatureMana("") != 0 {
		t.Fatal("signature mana moved from combat.json")
	}
	f := FishingRules
	if f.GetHoldSeconds() != 600 || f.GetCastSpacingSeconds() != 8 || f.GetReachTiles() != 1.5 {
		t.Fatal("fishing knobs")
	}
	w, ok := WaterFor("water:village:mill-pond")
	if !ok || w.GetTiles() != 27 || w.GetCapacity() != 12 || w.GetRecoverySeconds() != 600 {
		t.Fatal("mill pond")
	}
	if bank, ok := BankFor(w, "race"); !ok || len(bank.GetTiles()) != 1 || bank.GetTiles()[0].GetTx() != 32 || bank.GetTiles()[0].GetTy() != 19 {
		t.Fatal("race bank")
	}
	if BandAt(100).GetId() != "healthy" || BandAt(50).GetId() != "healthy" || BandAt(49).GetId() != "low" || BandAt(19).GetId() != "very-low" || BandAt(0).GetId() != "very-low" {
		t.Fatal("bands")
	}
}
