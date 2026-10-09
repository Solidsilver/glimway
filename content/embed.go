// Package content holds the canonical shared data, read directly by Go and Vite.
package content

import (
	"embed"
	"encoding/json"
	"fmt"
	"slices"

	contentv1 "glimway/gen/glimway/content/v1"
)

//go:embed *.json
var FS embed.FS

// The shared economy contract (content/economy.json): ember pricing, sync
// credit, invites and the Wilds' rate limits. The schema and its rules live
// in proto/glimway/content/v1/economy.proto; there are no rules left in code.
type Economy = contentv1.Economy

// DecodeEconomy reads economy JSON into the generated types, refusing nulls
// and unknown keys, then runs the schema's rules (protovalidate).
func DecodeEconomy(raw []byte) (*Economy, error) {
	doc := &Economy{}
	if err := decodeContentProto(raw, "economy", doc); err != nil {
		return doc, err
	}
	return doc, contentValidate("economy", nil, doc)
}

func LoadEconomy() (*Economy, error) {
	raw, err := FS.ReadFile("economy.json")
	if err != nil {
		return nil, err
	}
	return DecodeEconomy(raw)
}

var Rules = func() *Economy {
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
	GeneratorVersion            int                         `json:"generatorVersion"`
	ChunkSize                   int                         `json:"chunkSize"`
	DeepTangleManhattanDistance int                         `json:"deepTangleManhattanDistance"`
	Regions                     []WildsRegion               `json:"regions"`
	EnemyKinds                  []string                    `json:"enemyKinds"`
	CampMixes                   [][]string                  `json:"campMixes"`
	Materials                   []string                    `json:"materials"`
	POIIds                      []string                    `json:"poiIds"`
	Trinkets                    []string                    `json:"trinkets"`
	EntityKinds                 []WildsEntityKindRule       `json:"entityKinds"`
	LootTables                  map[string][]WildsLootEntry `json:"lootTables"`
	TrinketChancePermille       int                         `json:"trinketChancePermille"`
	Timers                      WildsTimers                 `json:"timers"`
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
	if w.GeneratorVersion != 2 || w.ChunkSize < 16 || w.ChunkSize%2 != 0 || w.DeepTangleManhattanDistance < 1 || len(w.Regions) == 0 {
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
