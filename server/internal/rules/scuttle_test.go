package rules

import (
	"encoding/json"
	"math"
	"os"
	"testing"
)

func TestSharedScuttleVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../content/vectors/scuttle.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		Scuttle []struct{ Seconds, X, Y float64 }
		Leash   []struct{ X, Y, DX, DY, Fraction float64 }
	}
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for _, p := range v.Scuttle {
		x, y := FightScuttleOffset(p.Seconds)
		if math.Abs(x-p.X) > 1e-9 || math.Abs(y-p.Y) > 1e-9 {
			t.Fatal(p, x, y)
		}
	}
	for _, p := range v.Leash {
		if got := FightLeashFraction(p.X, p.Y, p.DX, p.DY); math.Abs(got-p.Fraction) > 1e-9 {
			t.Fatal(p, got)
		}
	}
}
