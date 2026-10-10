package rules

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

// content/vectors/wardrobe.json is the contract both sides replay (lane A's
// file, lane C's resolve and look, lane E's lookFor): the server's steps must
// match it exactly, or a friend's screen and the wardrobe tab drift apart.
type wardrobeVectors struct {
	Slots  []string `json:"slots"`
	Resolve []struct {
		Name     string            `json:"name"`
		Chosen   map[string]string `json:"chosen"`
		Owned    []string          `json:"owned"`
		Catalog  []string          `json:"catalog"`
		Resolved map[string]string `json:"resolved"`
	} `json:"resolve"`
	LookFor []struct {
		Name    string `json:"name"`
		Profile struct {
			UseCostume bool              `json:"useCostume"`
			Equipped   map[string]string `json:"equipped"`
			Costume    map[string]string `json:"costume"`
		} `json:"profile"`
		Chosen map[string]string `json:"chosen"`
		Look   map[string]any    `json:"look"`
	} `json:"lookFor"`
}

func wardrobeVectorsFile(t *testing.T) wardrobeVectors {
	t.Helper()
	b, err := os.ReadFile("../../../content/vectors/wardrobe.json")
	if err != nil {
		t.Fatal(err)
	}
	var v wardrobeVectors
	if err = json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Resolve) == 0 || len(v.LookFor) == 0 {
		t.Fatal("no vectors")
	}
	return v
}

func stringsOf(m map[string]string) map[string]*string {
	out := map[string]*string{}
	for k, v := range m {
		value := v
		out[k] = &value
	}
	return out
}

func TestWardrobeDrawnSlotsAreTheVectors(t *testing.T) {
	v := wardrobeVectorsFile(t)
	if !reflect.DeepEqual(v.Slots, DrawnSlots) {
		t.Fatalf("slots: vectors %v, rules %v", v.Slots, DrawnSlots)
	}
}

func TestWardrobeResolveVectors(t *testing.T) {
	v := wardrobeVectorsFile(t)
	for _, c := range v.Resolve {
		known := map[string]bool{}
		for _, key := range c.Catalog {
			known[key] = true
		}
		got := Resolve(c.Chosen, c.Owned, func(key string) bool { return known[key] })
		want := c.Resolved
		if want == nil {
			want = map[string]string{}
		}
		if !reflect.DeepEqual(got, want) {
			t.Errorf("%s: got %v, want %v", c.Name, got, want)
		}
	}
}

func TestWardrobeLookVectors(t *testing.T) {
	v := wardrobeVectorsFile(t)
	for _, c := range v.LookFor {
		p := SanitizeProfile(Profile{Equipped: stringsOf(c.Profile.Equipped), Costume: stringsOf(c.Profile.Costume), UseCostume: c.Profile.UseCostume})
		got := Look(p, c.Chosen)
		for _, slot := range DrawnSlots {
			var want any
			if w, ok := c.Look[slot]; ok {
				want = w
			}
			var have any
			if v := got[slot]; v != nil {
				have = *v
			}
			if !reflect.DeepEqual(have, want) {
				t.Errorf("%s: %s got %v, want %v", c.Name, slot, have, want)
			}
		}
		if len(got) != len(DrawnSlots) {
			t.Errorf("%s: look spells %d slots, want %d", c.Name, len(got), len(DrawnSlots))
		}
	}
}
