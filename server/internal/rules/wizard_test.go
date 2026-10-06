package rules

import (
	"testing"
)

// Habitica reports the mage class as "wizard" (stats.class and gear
// klass/specialClass). Class admissions accept both spellings and every
// stored/replayed profile uses the internal "mage".
func TestWizardClassNormalizesToMage(t *testing.T) {
	if c, ok := NormalizeClass("wizard"); !ok || c != "mage" {
		t.Fatalf("NormalizeClass(wizard) = %q, %v", c, ok)
	}
	for _, class := range []string{"warrior", "mage", "rogue", "healer"} {
		if c, ok := NormalizeClass(class); !ok || c != class {
			t.Fatalf("NormalizeClass(%q) = %q, %v", class, c, ok)
		}
	}
	if _, ok := NormalizeClass("bard"); ok {
		t.Fatal("unknown class accepted")
	}
	wizard := "wizard"
	if !ValidProfile(Profile{ID: "x", Name: "Y", Level: 1, MaxHP: 50, Class: &wizard}) {
		t.Fatal("wizard class rejected by plausibility")
	}
	raw := []byte(`{"id":"x","name":"Y","class":"wizard","level":1,"hp":5,"maxHp":50,"mp":10,"maxMp":52,"exp":0,"stats":{"str":0,"int":11,"con":0,"per":0},"pets":[],"mounts":[]}`)
	p, err := DecodeProfile(raw)
	if err != nil {
		t.Fatal(err)
	}
	if p.Class == nil || *p.Class != "mage" {
		t.Fatalf("decoded class = %v, want mage", p.Class)
	}
}
