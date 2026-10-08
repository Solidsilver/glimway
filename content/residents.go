package content

import "fmt"

type ResidentSpot struct {
	Area string `json:"area"`
	TX   int    `json:"tx"`
	TY   int    `json:"ty"`
}
type ResidentPhase struct {
	Spot    string `json:"spot"`
	Minutes int    `json:"minutes"`
}
type Resident struct {
	ID            string                  `json:"id"`
	OffsetMinutes int                     `json:"offsetMinutes,omitempty"`
	Home          string                  `json:"home,omitempty"`
	Spots         map[string]ResidentSpot `json:"spots"`
	Cycle         []ResidentPhase         `json:"cycle"`
}
type Residents struct {
	PeriodMinutes int        `json:"periodMinutes"`
	GraceSeconds  int        `json:"graceSeconds"`
	Residents     []Resident `json:"residents"`
}

func ValidateResidents(doc Residents) error {
	bad := func(s string) error { return fmt.Errorf("invalid residents: %s", s) }
	if doc.PeriodMinutes < 1 || doc.PeriodMinutes > 1440 || doc.GraceSeconds < 0 || doc.GraceSeconds > doc.PeriodMinutes*60 || len(doc.Residents) == 0 {
		return bad("period/grace/empty")
	}
	seen := map[string]bool{}
	for _, r := range doc.Residents {
		if !ValidContentID(r.ID) || seen[r.ID] || r.OffsetMinutes < 0 || r.OffsetMinutes >= doc.PeriodMinutes || len(r.Spots) == 0 || len(r.Cycle) == 0 {
			return bad(r.ID)
		}
		if r.Home != "" {
			if _, ok := RoomFor(r.Home); !ok {
				return bad("home " + r.ID)
			}
		}
		for id, s := range r.Spots {
			if !ValidContentID(id) || !KnownContentArea(s.Area) || s.TX < 0 || s.TY < 0 {
				return bad("spot " + r.ID)
			}
			if room, ok := RoomFor(s.Area); ok && !room.Walkable(s.TX, s.TY) {
				return bad("blocked spot " + r.ID)
			}
		}
		total := 0
		used := map[string]bool{}
		for _, p := range r.Cycle {
			if _, ok := r.Spots[p.Spot]; !ok || p.Minutes <= 0 {
				return bad("phase " + r.ID)
			}
			total += p.Minutes
			used[p.Spot] = true
		}
		if total != doc.PeriodMinutes || len(used) != len(r.Spots) {
			return bad("phase total/unused spot " + r.ID)
		}
		if r.Home != "" {
			home := false
			for _, s := range r.Spots {
				home = home || s.Area == r.Home
			}
			if !home {
				return bad("unused home " + r.ID)
			}
		}
		seen[r.ID] = true
	}
	return nil
}
func LoadResidents() (Residents, error) {
	var doc Residents
	err := readTable("residents.json", &doc)
	if err == nil {
		err = ValidateResidents(doc)
	}
	return doc, err
}

var ResidentRules = func() Residents {
	doc, err := LoadResidents()
	if err != nil {
		panic(err)
	}
	return doc
}()

func ResidentByID(id string) (Resident, bool) {
	for _, r := range ResidentRules.Residents {
		if r.ID == id {
			return r, true
		}
	}
	return Resident{}, false
}

// ResidentAt resolves the named spot into an area and tile; times are Unix seconds.
func ResidentAt(id string, now float64) (ResidentSpot, bool) {
	r, ok := ResidentByID(id)
	if !ok {
		return ResidentSpot{}, false
	}
	return r.Spots[CycleAt(r, now).Spot], true
}
