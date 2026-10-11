package wilds

import (
	"errors"
	"fmt"
	"strings"

	"glimway/content"
)

// GeneratorV3 is the open map's generator (docs/design/open-map.md 2.2):
// one seamless wilderness on signed chunk coordinates, each chunk a pure
// function of its epoch and coordinates (plus a kept neighbour's stored
// edge at a seam).
const GeneratorV3 = 3

// The two epoch kinds of 0.8 (open-map.md 2.3).
const (
	EpochStill = "still" // one per world, never ends: the Tangle
	EpochWick  = "wick"  // one per world per wick: everything else
)

// ErrWrongEpoch: the chunk isn't made in this kind of epoch (EpochKindAt).
var ErrWrongEpoch = errors.New("wilds: chunk is not made in this epoch kind")

// EpochV3 is one v3 epoch's frozen generation parameters. Season is "0" for
// the still epoch and "t:<startsAt>:<endsAt>" for a wick epoch.
type EpochV3 struct {
	WorldSeed        string `json:"worldSeed"`
	Kind             string `json:"kind"`
	GeneratorVersion int    `json:"generatorVersion"`
	Season           string `json:"season"`
}

// StillEpoch is a world's still epoch.
func StillEpoch(worldSeed string) EpochV3 {
	return EpochV3{WorldSeed: worldSeed, Kind: EpochStill, GeneratorVersion: GeneratorV3, Season: "0"}
}

// WickEpoch is a world's wick epoch for a season "t:<startsAt>:<endsAt>".
func WickEpoch(worldSeed, season string) EpochV3 {
	return EpochV3{WorldSeed: worldSeed, Kind: EpochWick, GeneratorVersion: GeneratorV3, Season: season}
}

// ChunkSeedV3 is hash(worldSeed, kind, generatorVersion, season, cx, cy).
func ChunkSeedV3(e EpochV3, cx, cy int) uint32 {
	return Hash(e.WorldSeed, e.Kind, e.GeneratorVersion, e.Season, cx, cy)
}

// LootSeedV3 is hash(worldSeed, kind, generatorVersion, season, entityId, cycle).
func LootSeedV3(e EpochV3, entityID string, cycle int) uint32 {
	return Hash(e.WorldSeed, e.Kind, e.GeneratorVersion, e.Season, entityID, cycle)
}

// epochHash hashes the epoch with more parts: every epoch-wide choice
// (lands, river, places, routes, gaps) draws from one of these.
func (e EpochV3) hash(parts ...any) uint32 {
	return Hash(append([]any{e.WorldSeed, e.Kind, e.GeneratorVersion, e.Season}, parts...)...)
}

// check refuses an epoch this code can't make.
func (e EpochV3) check() error {
	if e.GeneratorVersion != GeneratorV3 {
		return fmt.Errorf("%w: version %d", ErrGeneratorUnavailable, e.GeneratorVersion)
	}
	switch e.Kind {
	case EpochStill:
		if e.Season != "0" {
			return fmt.Errorf("wilds: a still epoch's season is \"0\", not %q", e.Season)
		}
	case EpochWick:
		if !strings.HasPrefix(e.Season, "t:") {
			return fmt.Errorf("wilds: bad wick season %q", e.Season)
		}
		if _, err := seasonMark(e.Season); err != nil {
			return err
		}
	default:
		return fmt.Errorf("wilds: unknown epoch kind %q", e.Kind)
	}
	return nil
}

// still is the still epoch of the same world.
func (e EpochV3) still() EpochV3 { return StillEpoch(e.WorldSeed) }

// RollEntityLootV3 is RollEntityLoot on a v3 epoch: the entity's table, the
// file's trinket chance.
func RollEntityLootV3(e EpochV3, entity Entity, cycle int) (LootDrop, error) {
	return rollTable(LootTable(entity), LootSeedV3(e, entity.ID, cycle), cycle, false)
}

// RollTableLootV3 rolls a named table (discovery, rumour) for an id. A
// table's own trinketChancePermille, when set, replaces the file's.
func RollTableLootV3(e EpochV3, table, id string, cycle int) (LootDrop, error) {
	return rollTable(table, LootSeedV3(e, id, cycle), cycle, true)
}

func rollTable(name string, seed uint32, cycle int, ownTrinket bool) (LootDrop, error) {
	drop := LootDrop{Materials: []MaterialQty{}}
	data := content.WildsRules
	if cycle < 0 {
		return drop, errors.New("wilds: cycle must be a non-negative integer")
	}
	table, ok := data.LootTables[name]
	if !ok {
		return drop, fmt.Errorf("wilds: missing loot table %s", name)
	}
	rng := NewRng(seed)
	for _, entry := range table.GetEntries() {
		chance := rng.NextInt(1000)
		lo, hi := int(entry.GetMin()), int(entry.GetMax())
		qty := lo + rng.NextInt(hi-lo+1)
		if chance < int(entry.GetChancePermille()) {
			drop.Materials = append(drop.Materials, MaterialQty{ID: entry.GetMaterial(), Qty: qty})
		}
	}
	trinket := int(data.GetTrinketChancePermille())
	if ownTrinket && table.TrinketChancePermille != nil {
		trinket = int(table.GetTrinketChancePermille())
	}
	if rng.NextInt(1000) < trinket {
		t := data.Trinkets[rng.NextInt(len(data.Trinkets))]
		drop.Trinket = &t
	}
	return drop, nil
}
