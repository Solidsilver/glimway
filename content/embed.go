// Package content holds the canonical shared data, read directly by Go and Vite.
package content

import (
	"embed"
	"encoding/json"
	"fmt"
)

//go:embed *.json
var FS embed.FS

type Economy struct {
	WildsLimits struct {
		ClaimsPerMinute       int `json:"claimsPerMinute"`
		LanternsCreatedPerDay int `json:"lanternsCreatedPerDay"`
		LanternRelightsPerDay int `json:"lanternRelightsPerDay"`
		LanternReward         struct {
			Material string `json:"material"`
			Qty      int    `json:"qty"`
		} `json:"lanternReward"`
	} `json:"wildsLimits"`
	XPPerEmber    int `json:"xpPerEmber"`
	WelcomeEmbers int `json:"welcomeEmbers"`
	Costs         struct {
		HomeRest    int `json:"homeRest"`
		Rest        int `json:"rest"`
		RoadLantern int `json:"roadLantern"`
		Chest       int `json:"chest"`
	} `json:"costs"`
	RoadLanterns          []string `json:"roadLanterns"`
	ChestID               string   `json:"chestId"`
	CharmItem             string   `json:"charmItem"`
	OutstandingInvites    int      `json:"outstandingInvites"`
	SyncCreditDailyGrowth int      `json:"syncCreditDailyGrowth"`
	SyncCreditMax         int      `json:"syncCreditMax"`
	PendingCreditDays     int      `json:"pendingCreditDays"`
	LifetimeInvites       int      `json:"lifetimeInvites"`
	SyncCreditCap         int      `json:"syncCreditCap"`
	MigrationGiftCap      int      `json:"migrationGiftCap"`
	CheckpointToleranceXP float64  `json:"checkpointToleranceXp"`
}

func LoadEconomy() (Economy, error) {
	var e Economy
	b, err := FS.ReadFile("economy.json")
	if err != nil {
		return e, err
	}
	if err = json.Unmarshal(b, &e); err != nil {
		return e, err
	}
	if e.WildsLimits.LanternsCreatedPerDay <= 0 || e.WildsLimits.ClaimsPerMinute <= 0 || e.WildsLimits.LanternRelightsPerDay <= 0 || e.WildsLimits.LanternReward.Material != "amber" || e.WildsLimits.LanternReward.Qty <= 0 || e.Costs.HomeRest <= 0 || e.Costs.HomeRest >= e.Costs.Rest || e.XPPerEmber <= 0 || e.WelcomeEmbers < 0 || e.Costs.Rest <= 0 || e.Costs.RoadLantern <= 0 || e.Costs.Chest <= 0 || e.SyncCreditCap <= 0 || e.SyncCreditDailyGrowth < 0 || e.SyncCreditMax < e.SyncCreditCap || e.PendingCreditDays <= 0 || e.LifetimeInvites < e.OutstandingInvites || e.OutstandingInvites <= 0 || e.MigrationGiftCap < 0 || e.CheckpointToleranceXP < 0 || len(e.RoadLanterns) != 3 || e.ChestID == "" || e.CharmItem == "" {
		return e, fmt.Errorf("invalid economy")
	}
	return e, nil
}

var Rules = func() Economy {
	e, err := LoadEconomy()
	if err != nil {
		panic(err)
	}
	return e
}()

// LoadGear is gone: the Habitica snapshot loads through
// content/habitica_gear.go on the generated types.

// Shared paper catalog (content/papers.json), generated from the same
// design layer the client plays with (npm run papers). Typed loaders on
// both sides: this one for Go, src/content/papers.ts for TypeScript.
type Paper struct {
	ID         string    `json:"id"`
	Collection string    `json:"collection"`
	Source     string    `json:"source"`
	Section    string    `json:"section"`
	Rule       PaperRule `json:"rule"`
}

// paperSections: the library's shelf signs (docs/design/indoors.md 3.3).
var paperSections = map[string]bool{"stories": true, "histories": true, "recipes": true, "field-notes": true}

var paperSources = map[string]bool{
	"library-start": true, "placed": true, "quest": true, "gift": true,
	"commons": true, "wilds-poi": true, "wilds-chest": true,
	"village-project": true, "turning": true, "echo": true,
}

func LoadPapers() ([]Paper, error) {
	var doc struct {
		Papers []Paper `json:"papers"`
	}
	b, err := FS.ReadFile("papers.json")
	if err != nil {
		return nil, err
	}
	if err = json.Unmarshal(b, &doc); err != nil {
		return nil, err
	}
	if len(doc.Papers) == 0 {
		return nil, fmt.Errorf("invalid papers: empty")
	}
	seen := make(map[string]bool, len(doc.Papers))
	for _, p := range doc.Papers {
		// A find is the story flag "paper:<id>"; story flags cap at 128 characters.
		if p.ID == "" || len(p.ID) > 128-len("paper:") || p.Collection == "" || !paperSources[p.Source] || !paperSections[p.Section] || seen[p.ID] {
			return nil, fmt.Errorf("invalid papers: row %+v", p)
		}
		q := p.Rule
		if q.Kind != p.Source || p.Source == "placed" && (q.Area == "" || q.TX < 0 || q.TY < 0) || (p.Source == "quest" || p.Source == "gift") && q.Stage == "" || p.Source == "village-project" && q.Project == "" || p.Source == "commons" && q.Fact == "" || p.Source == "wilds-poi" && q.POI == "" && q.Site == "" || p.Source == "wilds-chest" && q.Tier != 3 || p.Source == "echo" && q.Member == "" || p.Source == "turning" && !q.Unbuilt && q.Fact == "" && q.Site == "" {
			return nil, fmt.Errorf("invalid paper find rule %s", p.ID)
		}
		seen[p.ID] = true
	}
	return doc.Papers, nil
}

var PapersByID = func() map[string]Paper {
	ps, err := LoadPapers()
	if err != nil {
		panic(err)
	}
	m := make(map[string]Paper, len(ps))
	for _, p := range ps {
		m[p.ID] = p
	}
	return m
}()
