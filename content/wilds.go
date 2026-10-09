package content

import (
	"fmt"
	"slices"

	contentv1 "glimway/gen/glimway/content/v1"
)

// The Wilds generator's shared data (content/wilds.json): read by the
// server's generator (server/internal/wilds) and the client's chunk math
// (src/lib/wilds). The schema and its field rules live in
// proto/glimway/content/v1/wilds.proto.
type (
	Wilds               = contentv1.Wilds
	WildsRegion         = contentv1.WildsRegion
	WildsCampMix        = contentv1.WildsCampMix
	WildsEntityKindRule = contentv1.WildsEntityKindRule
	WildsLootEntry      = contentv1.WildsLootEntry
	WildsLootTable      = contentv1.WildsLootTable
	WildsTimers         = contentv1.WildsTimers
)

// DecodeWilds reads wilds JSON into the generated types, refusing nulls and
// unknown keys, then runs the schema's rules (protovalidate) and the rules
// that span entries: region ids are unique, camp mixes name known enemy
// kinds, every spawn rule's loot tables exist, and no table pays an unknown
// material.
func DecodeWilds(raw []byte) (*Wilds, error) {
	doc := &Wilds{}
	if err := decodeContentProto(raw, "wilds", doc); err != nil {
		return doc, err
	}
	entries := []entryList{{field: "regions", ids: make([]string, len(doc.Regions))}}
	for i, r := range doc.Regions {
		entries[0].ids[i] = r.GetId()
	}
	if err := contentValidate("wilds", entries, doc); err != nil {
		return doc, err
	}
	return doc, wildsRules(doc)
}

func LoadWilds() (*Wilds, error) {
	raw, err := FS.ReadFile("wilds.json")
	if err != nil {
		return nil, err
	}
	return DecodeWilds(raw)
}

var WildsRules = func() *Wilds {
	doc, err := LoadWilds()
	if err != nil {
		panic(err)
	}
	return doc
}()

// lootTableIds names every loot table a spawn rule of the kind rolls on.
func lootTableIds(kind string, materials []string) []string {
	switch kind {
	case "camp":
		return []string{"camp"}
	case "node":
		ids := make([]string, 0, len(materials))
		for _, m := range materials {
			ids = append(ids, "node:"+m)
		}
		return ids
	case "chest":
		return []string{"chest:1", "chest:2", "chest:3"}
	default:
		return []string{"poi"}
	}
}

// wildsRules are the cross-entry rules the schema's CEL cannot express:
// they read the catalogues another field carries. They run only after
// protovalidate passed.
func wildsRules(w *Wilds) error {
	seen := map[string]bool{}
	for _, r := range w.Regions {
		if seen[r.GetId()] {
			return fmt.Errorf("invalid wilds: duplicate region %s", r.GetId())
		}
		seen[r.GetId()] = true
	}
	for i, mix := range w.CampMixes {
		for _, e := range mix.GetEnemies() {
			if !slices.Contains(w.EnemyKinds, e) {
				return fmt.Errorf("invalid wilds: campMixes[%d]: unknown enemy kind %q", i, e)
			}
		}
	}
	for _, k := range w.EntityKinds {
		for _, id := range lootTableIds(k.GetKind(), w.Materials) {
			if _, ok := w.LootTables[id]; !ok {
				return fmt.Errorf("invalid wilds: missing loot table %q", id)
			}
		}
	}
	for id, table := range w.LootTables {
		for _, e := range table.GetEntries() {
			if !slices.Contains(w.Materials, e.GetMaterial()) {
				return fmt.Errorf("invalid wilds: loot table %q: unknown material %q", id, e.GetMaterial())
			}
		}
	}
	return nil
}
