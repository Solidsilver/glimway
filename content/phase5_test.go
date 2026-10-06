package content

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
	"time"
)

func TestCalendarParity(t *testing.T) {
	raw, err := os.ReadFile("vectors/calendar.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		WickDays int         `json:"wickDays"`
		Unix     int64       `json:"unix"`
		Result   CalendarDay `json:"result"`
	}
	if err = json.Unmarshal(raw, &cases); err != nil {
		t.Fatal(err)
	}
	if len(cases) < 1000 {
		t.Fatal("insufficient parity coverage")
	}
	for _, v := range cases {
		c := CalendarRules
		c.WickDays = v.WickDays
		actual := CalendarAt(c, v.Unix)
		if !reflect.DeepEqual(actual, v.Result) {
			t.Fatalf("calendar %d/%d: got %s want %s", v.WickDays, v.Unix, mustJSON(actual), mustJSON(v.Result))
		}
	}
}
func mustJSON(v any) string { b, _ := json.Marshal(v); return string(b) }
func TestCalendarBoundariesAndFestivals(t *testing.T) {
	epoch, _ := time.Parse(time.RFC3339, CalendarRules.Epoch)
	for i, name := range CalendarRules.Wicks {
		d := CalendarAt(CalendarRules, epoch.Unix()+int64(i*7*86400))
		if d.Wick != name || d.Day != 1 || d.WickNumber != int64(i+1) || d.Mark != CalendarRules.Marks[i] {
			t.Fatal(d)
		}
	}
	for _, f := range CalendarRules.Festivals {
		var i int
		for n, w := range CalendarRules.Wicks {
			if w == f.Wick {
				i = n
			}
		}
		d := CalendarAt(CalendarRules, epoch.Unix()+int64((i*7+f.Day-1)*86400))
		if d.Festival == nil || *d.Festival != f.Name {
			t.Fatal("festival", f, d)
		}
	}
	before := CalendarAt(CalendarRules, epoch.Unix()-1)
	if before.Wick != "Quiet" || before.Day != 7 || before.NextTurning != epoch.Unix() || before.Notice == nil {
		t.Fatal("pre-epoch", before)
	}
	dayAhead := CalendarAt(CalendarRules, epoch.Unix()+6*86400)
	if dayAhead.Notice == nil {
		t.Fatal("missing notice")
	}
	earlier := CalendarAt(CalendarRules, epoch.Unix()+6*86400-1)
	if earlier.Notice != nil {
		t.Fatal("early notice")
	}
	year := CalendarAt(CalendarRules, epoch.Unix()+84*86400)
	if year.Year != 2 || year.WickNumber != 13 || year.Wick != "Thaw" {
		t.Fatal("year rollover", year)
	}
}
func TestPhase5ContentValidation(t *testing.T) {
	c, err := LoadCrafting()
	if err != nil || len(c.Recipes) != 20 {
		t.Fatal("recipes", err)
	}
	p, err := LoadProjects()
	if err != nil || len(p.Projects) != 6 {
		t.Fatal("projects", err)
	}
	for name, mutate := range map[string]func(*Crafting){"unknown-output": func(c *Crafting) { c.Recipes[0].Output.ID = "absent" }, "free": func(c *Crafting) { c.Recipes[0].Materials = map[string]int{} }, "material": func(c *Crafting) { c.Recipes[0].Materials = map[string]int{"absent": 1} }, "duplicate": func(c *Crafting) { c.Recipes[1].ID = c.Recipes[0].ID }, "tier": func(c *Crafting) { c.Recipes[0].MinTier = 1 }, "quantity": func(c *Crafting) { c.Recipes[0].Output.Qty = 0 }, "utility": func(c *Crafting) { c.UtilityItems[0].ID = WildsRules.Trinkets[0] }} {
		t.Run(name, func(t *testing.T) {
			copy := Crafting{}
			json.Unmarshal([]byte(mustJSON(c)), &copy)
			mutate(&copy)
			if ValidateCrafting(copy) == nil {
				t.Fatal("accepted malformed recipe")
			}
		})
	}
	for name, mutate := range map[string]func(*Projects){"unknown-paper": func(p *Projects) { p.Projects[0].Papers = []string{"missing"} }, "wrong-source": func(p *Projects) { p.Projects[0].Papers = []string{"will-of-elias-fenn"} }, "missing-paper-path": func(p *Projects) { p.Projects[0].Papers = []string{} }, "flag": func(p *Projects) { p.Projects[0].WorldFlag = "elsewhere" }, "duplicate": func(p *Projects) { p.Projects[1].ID = p.Projects[0].ID }, "cost": func(p *Projects) { p.Projects[0].Materials["timber"] = 0 }} {
		t.Run(name, func(t *testing.T) {
			copy := Projects{}
			json.Unmarshal([]byte(mustJSON(p)), &copy)
			mutate(&copy)
			if ValidateProjects(copy) == nil {
				t.Fatal("accepted malformed project")
			}
		})
	}
	cal := CalendarRules
	cal.WickDays = 0
	if ValidateCalendar(cal) == nil {
		t.Fatal("zero wick duration")
	}
	cal = CalendarRules
	cal.Epoch = "2026-01-05T01:00:00Z"
	if ValidateCalendar(cal) == nil {
		t.Fatal("nonmidnight epoch")
	}
}
