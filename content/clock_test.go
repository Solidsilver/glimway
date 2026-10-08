package content

import (
	"encoding/json"
	"os"
	"testing"
)

func TestClockRecoveryVectors(t *testing.T) {
	raw, e := os.ReadFile("vectors/clock.json")
	if e != nil {
		t.Fatal(e)
	}
	var v struct {
		Recovery []struct{ Stored, Rate, Cap, Since, Now, Expected float64 }
	}
	if e = json.Unmarshal(raw, &v); e != nil {
		t.Fatal(e)
	}
	for _, r := range v.Recovery {
		if got := Recovered(r.Stored, r.Rate, r.Cap, r.Since, r.Now); got != r.Expected {
			t.Fatal(r, got)
		}
	}
}
func TestStoryTables(t *testing.T) {
	if _, e := LoadQuests(); e != nil {
		t.Fatal(e)
	}
	if _, e := LoadStory(); e != nil {
		t.Fatal(e)
	}
	if _, e := LoadVitals(); e != nil {
		t.Fatal(e)
	}
	for _, p := range PapersByID {
		if p.Rule.Kind != p.Source {
			t.Fatal(p.ID)
		}
	}
}

func TestRewardFactsAreServerOwned(t *testing.T) {
	for _, mark := range []string{"returned:whittled-fox", "heirloom:brack-felling-axe", "ada-oil-gifts:3", "echo:nan", "echo:bett:softened", "embers:welcome", "lit:road-1", "opened:ruin-cache", "paper:eleven-days", "wilds:turned", "warden-sliver:found", "donated:eleven-days@2026-10-08", "witness:warden:player:Name"} {
		if MarkWriter(mark) != "server" {
			t.Fatal("reward fact writable by client", mark)
		}
	}
}
