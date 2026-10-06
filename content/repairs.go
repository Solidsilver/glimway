package content

import (
	"encoding/json"
	"fmt"
	"slices"
)

type RepairPos struct {
	TX int `json:"tx"`
	TY int `json:"ty"`
}

type RepairGift struct {
	Kind string `json:"kind"`
	ID   string `json:"id"`
	Qty  int    `json:"qty"`
}

type RepairOpenFrom struct {
	Wick string `json:"wick"`
	Day  int    `json:"day"`
}

type RepairDef struct {
	ID                string          `json:"id"`
	Name              string          `json:"name"`
	Part              string          `json:"part"`
	Area              string          `json:"area"`
	Target            string          `json:"target"`
	Pos               RepairPos       `json:"pos"`
	Resident          string          `json:"resident"`
	Reaction          string          `json:"reaction"`
	Gift              *RepairGift     `json:"gift,omitempty"`
	Hint              string          `json:"hint"`
	Description       string          `json:"description"`
	MendedDescription string          `json:"mendedDescription"`
	WorldFlag         string          `json:"worldFlag"`
	OpenFrom          *RepairOpenFrom `json:"openFrom,omitempty"`
}

type RepairsRulesConfig struct {
	MaxOpen  int      `json:"maxOpen"`
	PerWick  int      `json:"perWick"`
	Scripted []string `json:"scripted"`
}

type Repairs struct {
	Rules   RepairsRulesConfig `json:"rules"`
	Repairs []RepairDef        `json:"repairs"`
}

func ValidateRepairs(r Repairs) error {
	bad := fmt.Errorf("invalid repairs")
	if r.Rules.MaxOpen <= 0 || r.Rules.PerWick <= 0 || len(r.Rules.Scripted) == 0 || len(r.Repairs) == 0 {
		return bad
	}
	ids := map[string]bool{}
	for _, v := range r.Repairs {
		if !ValidContentID(v.ID) || v.Name == "" || ids[v.ID] {
			return bad
		}
		if v.WorldFlag != "repair:"+v.ID+":mended" {
			return bad
		}
		if !slices.Contains([]string{"village", "commons"}, v.Area) {
			return bad
		}
		if v.Pos.TX < 0 || v.Pos.TY < 0 {
			return bad
		}
		if len(v.Reaction) == 0 || len(v.Reaction) > 160 {
			return bad
		}
		if len(v.Description) == 0 || len(v.Description) > 160 {
			return bad
		}
		if len(v.MendedDescription) == 0 || len(v.MendedDescription) > 160 {
			return bad
		}
		item, ok := ItemFor(v.Part)
		if !ok || item.Kind != "part" && item.Kind != "material" && item.Kind != "consumable" {
			return bad
		}
		if v.Gift != nil {
			if v.Gift.ID == "" || v.Gift.Qty <= 0 {
				return bad
			}
			if _, ok := ItemFor(v.Gift.ID); !ok {
				return bad
			}
		}
		if v.OpenFrom != nil && (!slices.Contains(CalendarRules.Wicks, v.OpenFrom.Wick) || v.OpenFrom.Day < 1 || v.OpenFrom.Day > CalendarRules.WickDays) {
			return bad
		}
		ids[v.ID] = true
	}
	for _, s := range r.Rules.Scripted {
		if !ids[s] {
			return bad
		}
	}
	return nil
}

func LoadRepairs() (Repairs, error) {
	var r Repairs
	b, err := FS.ReadFile("repairs.json")
	if err == nil {
		err = json.Unmarshal(b, &r)
	}
	if err == nil {
		err = ValidateRepairs(r)
	}
	return r, err
}

var RepairRules = func() Repairs {
	r, err := LoadRepairs()
	if err != nil {
		panic(err)
	}
	return r
}()

func RepairFor(id string) (RepairDef, bool) {
	for _, r := range RepairRules.Repairs {
		if r.ID == id {
			return r, true
		}
	}
	return RepairDef{}, false
}
