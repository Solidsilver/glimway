package rules_test

import (
	"encoding/json"
	"glimway/server/internal/habitica"
	"glimway/server/internal/rules"
	"os"
	"testing"
)

func same(t *testing.T, label string, a, b any) {
	t.Helper()
	aa, _ := json.Marshal(a)
	bb, _ := json.Marshal(b)
	var x, y any
	_ = json.Unmarshal(aa, &x)
	_ = json.Unmarshal(bb, &y)
	ax, _ := json.Marshal(x)
	by, _ := json.Marshal(y)
	if string(ax) != string(by) {
		t.Fatalf("%s\ngot %s\nwant %s", label, ax, by)
	}
}
func TestTypeScriptParity(t *testing.T) {
	b, err := os.ReadFile("../../../content/vectors/backend.json")
	if err != nil {
		t.Fatal(err)
	}
	var tree map[string]any
	if err = json.Unmarshal(b, &tree); err != nil {
		t.Fatal(err)
	}
	defaults := tree["stateDefaults"].(map[string]any)
	same(t, "state defaults", defaults, rules.NewState())
	var expand func(any) any
	expand = func(v any) any {
		switch v := v.(type) {
		case []any:
			for i, c := range v {
				v[i] = expand(c)
			}
			return v
		case map[string]any:
			if patch, ok := v["$state"].(map[string]any); ok {
				out := map[string]any{}
				for k, c := range defaults {
					out[k] = c
				}
				for k, c := range patch {
					out[k] = c
				}
				return out
			}
			for k, c := range v {
				v[k] = expand(c)
			}
			return v
		default:
			return v
		}
	}
	b, err = json.Marshal(expand(tree))
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		XP []struct {
			Level  float64
			Exp    *float64
			Mark   *float64
			Total  *float64
			Next   float64
			Result rules.Credit
		}
		Sync []struct {
			Input   rules.Save
			Profile rules.Profile
			AtSafe  bool
			Result  rules.SyncResult
		}
		Spend []struct {
			State     rules.State
			Operation rules.Spend
			Imported  bool
			Check     rules.Check
			Result    *rules.State
		}
		Welcome []struct {
			State  rules.State
			Result struct {
				State   rules.State
				Granted int
			}
		}
		Mapping []struct {
			Payload json.RawMessage
			Result  rules.Profile
		}
	}
	if err = json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	for i, c := range v.XP {
		if c.Exp != nil && rules.LifetimeXP(c.Level, *c.Exp) != *c.Total {
			t.Fatalf("lifetime XP vector %d", i)
		}
		if rules.XPToNextLevel(c.Level) != c.Next {
			t.Fatalf("curve vector %d", i)
		}
		same(t, "credit", rules.CreditXP(c.Mark, rules.Profile{Level: c.Level, Exp: c.Exp}), c.Result)
	}
	for _, c := range v.Sync {
		same(t, "sync", rules.Sync(c.Input, c.Profile, c.AtSafe), c.Result)
	}
	for _, c := range v.Spend {
		same(t, "check", rules.CheckSpend(c.State, c.Operation, c.Imported), c.Check)
		s, err := rules.SpendGlims(c.State, c.Operation, c.Imported)
		if c.Check.OK {
			if err != nil {
				t.Fatal(err)
			}
			same(t, "spend", s, c.Result)
		} else if err == nil || err.Error() != c.Check.Reason {
			t.Fatal("spend rejection mismatch")
		}
	}
	for _, c := range v.Welcome {
		s, n := rules.Welcome(c.State)
		same(t, "welcome", s, c.Result.State)
		if n != c.Result.Granted {
			t.Fatal("welcome grant mismatch")
		}
	}
	for _, c := range v.Mapping {
		p, err := habitica.Map(c.Payload)
		if err != nil {
			t.Fatal(err)
		}
		same(t, "mapping", p, c.Result)
	}
	t.Logf("replayed %d XP, %d sync, %d spend, %d welcome and %d mapping vectors", len(v.XP), len(v.Sync), len(v.Spend), len(v.Welcome), len(v.Mapping))
}
