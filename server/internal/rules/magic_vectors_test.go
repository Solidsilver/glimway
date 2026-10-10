package rules

import (
	"encoding/json"
	"glimway/content"
	"os"
	"testing"
)

// content/vectors/magic.json is written by the client's own heal formulas
// (scripts/magic-vectors.ts): the server's must give the same numbers, to
// the bit, or a friend's screen and the ward credit drift apart (game review
// F1, F4).
func TestMagicVectorsMatchTheClient(t *testing.T) {
	b, err := os.ReadFile("../../../content/vectors/magic.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Healers []struct {
			Int, Mend, Pulse, Ward float64
		}
		PulseTimes struct {
			DurationSeconds float64
			Pulses          int32
		}
	}
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	ward, ok := content.AbilityFor("ward-light")
	if !ok {
		t.Fatal("ward-light")
	}
	if n := ward.GetNumbers(); n.GetPulses() != v.PulseTimes.Pulses || n.GetDurationSeconds() != v.PulseTimes.DurationSeconds {
		t.Fatal("the vectors are older than the table: npm run vectors:magic", n.GetPulses(), n.GetDurationSeconds())
	}
	if len(v.Healers) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.Healers {
		p := withClass(mage(20, c.Int), "healer")
		if got := MendHeal(p); got != c.Mend {
			t.Errorf("INT %v: Mend %v, the client %v", c.Int, got, c.Mend)
		}
		if got := WardPulseHeal(p, ward); got != c.Pulse {
			t.Errorf("INT %v: pulse %v, the client %v", c.Int, got, c.Pulse)
		}
		if got := WardHeal(p, ward); got != c.Ward {
			t.Errorf("INT %v: ward %v, the client %v", c.Int, got, c.Ward)
		}
	}
}
