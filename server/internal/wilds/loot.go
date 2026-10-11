package wilds

import (
	"strconv"
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

	placeAttempts = 64
)

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
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
