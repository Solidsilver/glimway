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

// The shared paper catalog (content/papers.json) moved onto the schema:
// its loader and table are content/papers.go.
