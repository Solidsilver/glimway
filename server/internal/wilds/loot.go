package wilds

import (
	"errors"
	"fmt"
	"strconv"

	"glimway/content"
)

// Entity is one generated entity: enemies for camps, material for nodes,
// tier for chests, poi for points of interest; unused fields are empty/zero.
type Entity struct {
	ID       string   `json:"id"`
	Kind     string   `json:"kind"`
	TX       int      `json:"tx"`
	TY       int      `json:"ty"`
	Enemies  []string `json:"enemies"`
	Material string   `json:"material"`
	Tier     int      `json:"tier"`
	POI      string   `json:"poi"`
}

type MaterialQty struct {
	ID  string `json:"id"`
	Qty int    `json:"qty"`
}

// LootDrop is the deterministic loot for one claim cycle of one entity.
type LootDrop struct {
	Materials []MaterialQty `json:"materials"`
	Trinket   *string       `json:"trinket"`
}

const (
	kindCamp  = "camp"
	kindNode  = "node"
	kindChest = "chest"
	kindPOI   = "poi"

	exitGap       = 3
	placeAttempts = 64
)

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func regionFor(data content.Wilds, regionID string) (content.WildsRegion, error) {
	for _, r := range data.Regions {
		if r.ID == regionID {
			return r, nil
		}
	}
	return content.WildsRegion{}, fmt.Errorf("wilds: unknown region %s", regionID)
}

// LootTable is the content/wilds.json loot table an entity rolls on.
func LootTable(e Entity) string {
	switch e.Kind {
	case kindCamp:
		return "camp"
	case kindNode:
		return "node:" + e.Material
	case kindChest:
		return "chest:" + strconv.Itoa(e.Tier)
	default:
		return "poi"
	}
}

// RollEntityLoot rolls one claim cycle of an entity read from its stored
// chunk. Per loot-table entry a chance draw then a quantity draw (both
// always taken), then the trinket chance draw and, only on a win, the
// trinket id. The seed is LootSeed(epoch, entity id, cycle).
func RollEntityLoot(epoch Epoch, entity Entity, cycle int) (LootDrop, error) {
	drop := LootDrop{Materials: []MaterialQty{}}
	data := content.WildsRules
	if cycle < 0 {
		return drop, errors.New("wilds: cycle must be a non-negative integer")
	}
	table, ok := data.LootTables[LootTable(entity)]
	if !ok {
		return drop, fmt.Errorf("wilds: missing loot table %s", LootTable(entity))
	}
	rng := NewRng(LootSeed(epoch, entity.ID, cycle))
	for _, entry := range table {
		chance := rng.NextInt(1000)
		qty := entry.Min + rng.NextInt(entry.Max-entry.Min+1)
		if chance < entry.ChancePermille {
			drop.Materials = append(drop.Materials, MaterialQty{ID: entry.Material, Qty: qty})
		}
	}
	trinketChance := rng.NextInt(1000)
	if trinketChance < data.TrinketChancePermille {
		t := data.Trinkets[rng.NextInt(len(data.Trinkets))]
		drop.Trinket = &t
	}
	return drop, nil
}
