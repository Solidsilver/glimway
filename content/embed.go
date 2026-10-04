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
	XPPerEmber    int `json:"xpPerEmber"`
	WelcomeEmbers int `json:"welcomeEmbers"`
	Costs         struct {
		Rest        int `json:"rest"`
		RoadLantern int `json:"roadLantern"`
		Chest       int `json:"chest"`
	} `json:"costs"`
	QuestEmbers           map[string]int `json:"questEmbers"`
	RoadLanterns          []string       `json:"roadLanterns"`
	ChestID               string         `json:"chestId"`
	CharmItem             string         `json:"charmItem"`
	OutstandingInvites    int            `json:"outstandingInvites"`
	SyncCreditDailyGrowth int            `json:"syncCreditDailyGrowth"`
	SyncCreditMax         int            `json:"syncCreditMax"`
	PendingCreditDays     int            `json:"pendingCreditDays"`
	LifetimeInvites       int            `json:"lifetimeInvites"`
	SyncCreditCap         int            `json:"syncCreditCap"`
	MigrationGiftCap      int            `json:"migrationGiftCap"`
	CheckpointToleranceXP float64        `json:"checkpointToleranceXp"`
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
	if e.XPPerEmber <= 0 || e.WelcomeEmbers < 0 || e.Costs.Rest <= 0 || e.Costs.RoadLantern <= 0 || e.Costs.Chest <= 0 || e.SyncCreditCap <= 0 || e.SyncCreditDailyGrowth < 0 || e.SyncCreditMax < e.SyncCreditCap || e.PendingCreditDays <= 0 || e.LifetimeInvites < e.OutstandingInvites || e.OutstandingInvites <= 0 || e.MigrationGiftCap < 0 || e.CheckpointToleranceXP < 0 || len(e.RoadLanterns) != 3 || e.ChestID == "" || e.CharmItem == "" {
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

type GearItem struct {
	Str          float64 `json:"str"`
	Int          float64 `json:"int"`
	Con          float64 `json:"con"`
	Per          float64 `json:"per"`
	Klass        string  `json:"klass"`
	SpecialClass string  `json:"specialClass"`
}

func LoadGear() (map[string]GearItem, error) {
	var c struct {
		Gear map[string]GearItem `json:"gear"`
	}
	b, err := FS.ReadFile("habitica-gear.json")
	if err != nil {
		return nil, err
	}
	err = json.Unmarshal(b, &c)
	return c.Gear, err
}
