package wilds

import (
	"errors"
	"fmt"
	"strconv"
	"strings"

	"glimway/content"
)

// Entity is one generated entity. Flat fields so JSON matches the TypeScript
// port: enemies for camps, material for nodes, tier for chests, poi for
// points of interest; unused fields are empty/zero.
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

	exitGap        = 3
	commonsExitTX  = 1
	placeAttempts  = 64
	placeMargin    = 2
	entityIDParts  = 4
	maxEntityIndex = 1 << 30
)

type exitRect struct{ tx, ty, tw, th int }

// buildExits is the shared exit geometry (see gen-v1.ts): a 3-tile gap
// centered on each edge whose neighbor exists, plus the commons gap on the
// region entry chunk's south edge at tx = 1.
func buildExits(data content.Wilds, region content.WildsRegion, cx, cy int) []exitRect {
	S := data.ChunkSize
	mid := S/2 - 1
	var out []exitRect
	if cy > 0 {
		out = append(out, exitRect{mid, 0, exitGap, 1})
	}
	if cx < region.GridWidth-1 {
		out = append(out, exitRect{S - 1, mid, 1, exitGap})
	}
	if cy < region.GridHeight-1 {
		out = append(out, exitRect{mid, S - 1, exitGap, 1})
	}
	if cx > 0 {
		out = append(out, exitRect{0, mid, 1, exitGap})
	}
	if cx == region.EntryX && cy == region.EntryY {
		out = append(out, exitRect{commonsExitTX, S - 1, exitGap, 1})
	}
	return out
}

func nearAnyExit(exits []exitRect, tx, ty int) bool {
	for _, e := range exits {
		if tx >= e.tx-1 && tx <= e.tx+e.tw && ty >= e.ty-1 && ty <= e.ty+e.th {
			return true
		}
	}
	return false
}

type point struct{ tx, ty int }

func spotFree(exits []exitRect, occupied []point, tx, ty int) bool {
	if nearAnyExit(exits, tx, ty) {
		return false
	}
	for _, p := range occupied {
		if abs(p.tx-tx) < 2 && abs(p.ty-ty) < 2 {
			return false
		}
	}
	return true
}

func abs(v int) int {
	if v < 0 {
		return -v
	}
	return v
}

func placeEntity(rng *Rng, S int, exits []exitRect, occupied []point) (point, error) {
	room := S - 2*placeMargin
	for attempt := 0; attempt < placeAttempts; attempt++ {
		tx := placeMargin + rng.NextInt(room)
		ty := placeMargin + rng.NextInt(room)
		if spotFree(exits, occupied, tx, ty) {
			return point{tx, ty}, nil
		}
	}
	for ty := placeMargin; ty <= S-placeMargin-1; ty++ {
		for tx := placeMargin; tx <= S-placeMargin-1; tx++ {
			if spotFree(exits, occupied, tx, ty) {
				return point{tx, ty}, nil
			}
		}
	}
	return point{}, errors.New("wilds: no room left for an entity in chunk")
}

func regionFor(data content.Wilds, regionID string) (content.WildsRegion, error) {
	for _, r := range data.Regions {
		if r.ID == regionID {
			return r, nil
		}
	}
	return content.WildsRegion{}, fmt.Errorf("wilds: unknown region %s", regionID)
}

// ChunkEntities is the ordered, stable-id entity list for one chunk.
// RNG consumption matches gen-v1.ts exactly: per kind rule one count draw,
// then per instance placement draws (64 attempts of two draws, deterministic
// fallback scan uses none) followed by one kind-data draw.
func ChunkEntities(epoch Epoch, cx, cy int) ([]Entity, error) {
	data := content.WildsRules
	region, err := regionFor(data, epoch.RegionID)
	if err != nil {
		return nil, err
	}
	rng := NewRng(ChunkSeed(epoch, cx, cy))
	exits := buildExits(data, region, cx, cy)
	var occupied []point
	out := []Entity{}
	for _, rule := range data.EntityKinds {
		count := rule.Min + rng.NextInt(rule.Max-rule.Min+1)
		for i := 0; i < count; i++ {
			tile, err := placeEntity(rng, data.ChunkSize, exits, occupied)
			if err != nil {
				return nil, err
			}
			occupied = append(occupied, tile)
			e := Entity{
				ID:       fmt.Sprintf("%s:%d:%d:%d", rule.Kind, cx, cy, i),
				Kind:     rule.Kind,
				TX:       tile.tx,
				TY:       tile.ty,
				Enemies:  []string{},
				Material: "",
				Tier:     0,
				POI:      "",
			}
			switch rule.Kind {
			case kindCamp:
				mix := data.CampMixes[rng.NextInt(len(data.CampMixes))]
				e.Enemies = append([]string{}, mix...)
			case kindNode:
				e.Material = data.Materials[rng.NextInt(len(data.Materials))]
			case kindChest:
				e.Tier = 1 + rng.NextInt(3)
			default:
				e.POI = data.POIIds[rng.NextInt(len(data.POIIds))]
			}
			out = append(out, e)
		}
	}
	return out, nil
}

func parseEntityID(entityID string) (kind string, cx, cy, index int, err error) {
	parts := strings.Split(entityID, ":")
	if len(parts) != entityIDParts {
		return "", 0, 0, 0, fmt.Errorf("wilds: bad entity id %s", entityID)
	}
	kind = parts[0]
	switch kind {
	case kindCamp, kindNode, kindChest, kindPOI:
	default:
		return "", 0, 0, 0, fmt.Errorf("wilds: bad entity id %s", entityID)
	}
	if cx, err = strconv.Atoi(parts[1]); err != nil {
		return "", 0, 0, 0, fmt.Errorf("wilds: bad entity id %s", entityID)
	}
	if cy, err = strconv.Atoi(parts[2]); err != nil {
		return "", 0, 0, 0, fmt.Errorf("wilds: bad entity id %s", entityID)
	}
	if index, err = strconv.Atoi(parts[3]); err != nil || index < 0 || index > maxEntityIndex {
		return "", 0, 0, 0, fmt.Errorf("wilds: bad entity id %s", entityID)
	}
	return kind, cx, cy, index, nil
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

// RollLoot is the deterministic loot for one claim cycle of one v1 entity,
// found by regenerating its chunk. RNG consumption matches gen-v1.ts exactly
// (see RollEntityLoot).
func RollLoot(epoch Epoch, entityID string, cycle int) (LootDrop, error) {
	drop := LootDrop{Materials: []MaterialQty{}}
	if cycle < 0 {
		return drop, errors.New("wilds: cycle must be a non-negative integer")
	}
	_, cx, cy, _, err := parseEntityID(entityID)
	if err != nil {
		return drop, err
	}
	entities, err := ChunkEntities(epoch, cx, cy)
	if err != nil {
		return drop, err
	}
	var entity *Entity
	for i := range entities {
		if entities[i].ID == entityID {
			entity = &entities[i]
			break
		}
	}
	if entity == nil {
		return drop, fmt.Errorf("wilds: unknown entity %s", entityID)
	}
	return RollEntityLoot(epoch, *entity, cycle)
}

// RollEntityLoot rolls one claim cycle of an entity already in hand (v2 reads
// it from the stored chunk, so nothing is regenerated). The draws are v1's:
// per loot-table entry a chance draw then a quantity draw (both always
// taken), then the trinket chance draw and, only on a win, the trinket id.
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
