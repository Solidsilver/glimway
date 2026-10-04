// Package content holds the canonical shared data, read directly by Go and Vite.
package content

import (
	"embed"
	"encoding/json"
	"fmt"
	"slices"
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

// Wilds generator data (content/wilds.json). Typed loaders on both sides:
// this one for Go, src/lib/wilds/data.ts for TypeScript.
type WildsRegion struct {
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	GridWidth  int    `json:"gridWidth"`
	GridHeight int    `json:"gridHeight"`
	EntryX     int    `json:"entryX"`
	EntryY     int    `json:"entryY"`
}

type WildsEntityKindRule struct {
	Kind string `json:"kind"`
	Min  int    `json:"min"`
	Max  int    `json:"max"`
}

type WildsLootEntry struct {
	Material       string `json:"material"`
	Min            int    `json:"min"`
	Max            int    `json:"max"`
	ChancePermille int    `json:"chancePermille"`
}

type WildsTimers struct {
	CampRespawnSeconds int `json:"campRespawnSeconds"`
	NodeRegrowSeconds  int `json:"nodeRegrowSeconds"`
}

type Wilds struct {
	GeneratorVersion      int                         `json:"generatorVersion"`
	ChunkSize             int                         `json:"chunkSize"`
	Regions               []WildsRegion               `json:"regions"`
	EnemyKinds            []string                    `json:"enemyKinds"`
	CampMixes             [][]string                  `json:"campMixes"`
	Materials             []string                    `json:"materials"`
	POIIds                []string                    `json:"poiIds"`
	Trinkets              []string                    `json:"trinkets"`
	EntityKinds           []WildsEntityKindRule       `json:"entityKinds"`
	LootTables            map[string][]WildsLootEntry `json:"lootTables"`
	TrinketChancePermille int                         `json:"trinketChancePermille"`
	Timers                WildsTimers                 `json:"timers"`
}

func LoadWilds() (Wilds, error) {
	var w Wilds
	b, err := FS.ReadFile("wilds.json")
	if err != nil {
		return w, err
	}
	if err = json.Unmarshal(b, &w); err != nil {
		return w, err
	}
	if w.GeneratorVersion != 1 || w.ChunkSize < 16 || w.ChunkSize%2 != 0 || len(w.Regions) == 0 {
		return w, fmt.Errorf("invalid wilds: version/chunk/regions")
	}
	for _, r := range w.Regions {
		if r.ID == "" || (r.Kind != "inner" && r.Kind != "outer") || r.GridWidth <= 0 || r.GridHeight <= 0 ||
			r.EntryX < 0 || r.EntryX >= r.GridWidth || r.EntryY < 0 || r.EntryY >= r.GridHeight {
			return w, fmt.Errorf("invalid wilds: region %q", r.ID)
		}
	}
	if len(w.EnemyKinds) == 0 || len(w.CampMixes) == 0 || len(w.Materials) == 0 || len(w.POIIds) == 0 || len(w.Trinkets) == 0 {
		return w, fmt.Errorf("invalid wilds: empty catalog")
	}
	for _, mix := range w.CampMixes {
		if len(mix) == 0 {
			return w, fmt.Errorf("invalid wilds: empty camp mix")
		}
		for _, e := range mix {
			if !slices.Contains(w.EnemyKinds, e) {
				return w, fmt.Errorf("invalid wilds: enemy %q", e)
			}
		}
	}
	if len(w.EntityKinds) == 0 {
		return w, fmt.Errorf("invalid wilds: no entity kinds")
	}
	for _, k := range w.EntityKinds {
		if k.Min < 0 || k.Max < k.Min {
			return w, fmt.Errorf("invalid wilds: spawn rule %q", k.Kind)
		}
	}
	for id, entries := range w.LootTables {
		if len(entries) == 0 {
			return w, fmt.Errorf("invalid wilds: empty loot table %q", id)
		}
		for _, e := range entries {
			if e.Min < 1 || e.Max < e.Min || e.ChancePermille <= 0 || e.ChancePermille > 1000 || !slices.Contains(w.Materials, e.Material) {
				return w, fmt.Errorf("invalid wilds: loot table %q", id)
			}
		}
	}
	tableFor := func(kind string) []string {
		switch kind {
		case "camp":
			return []string{"camp"}
		case "node":
			ids := make([]string, 0, len(w.Materials))
			for _, m := range w.Materials {
				ids = append(ids, "node:"+m)
			}
			return ids
		case "chest":
			return []string{"chest:1", "chest:2", "chest:3"}
		default:
			return []string{"poi"}
		}
	}
	for _, k := range w.EntityKinds {
		for _, id := range tableFor(k.Kind) {
			if _, ok := w.LootTables[id]; !ok {
				return w, fmt.Errorf("invalid wilds: missing loot table %q", id)
			}
		}
	}
	if w.TrinketChancePermille < 0 || w.TrinketChancePermille > 1000 || w.Timers.CampRespawnSeconds <= 0 || w.Timers.NodeRegrowSeconds <= 0 {
		return w, fmt.Errorf("invalid wilds: trinket chance/timers")
	}
	return w, nil
}

var WildsRules = func() Wilds {
	w, err := LoadWilds()
	if err != nil {
		panic(err)
	}
	return w
}()
