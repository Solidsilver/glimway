package content

import (
	"fmt"
	"regexp"
	"slices"
	"strconv"

	contentv1 "glimway/gen/glimway/content/v1"
)

// The Wilds generator's shared data (content/wilds.json): read by the
// server's generator (server/internal/wilds) and the client's chunk math
// (src/lib/wilds). The schema and its field rules live in
// proto/glimway/content/v1/wilds.proto.
type (
	Wilds               = contentv1.Wilds
	WildsCampMix        = contentv1.WildsCampMix
	WildsEntityKindRule = contentv1.WildsEntityKindRule
	WildsLootEntry      = contentv1.WildsLootEntry
	WildsLootTable      = contentv1.WildsLootTable
	WildsTimers         = contentv1.WildsTimers
	WildsGround         = contentv1.WildsGround
	WildsDecorKind      = contentv1.WildsDecorKind
	WildsPlace          = contentv1.WildsPlace
	WildsFixedSite      = contentv1.WildsFixedSite
	WildsDealtSite      = contentv1.WildsDealtSite
	WildsOpening        = contentv1.WildsOpening
	WildsLand           = contentv1.WildsLand
	WildsLandSizes      = contentv1.WildsLandSizes
	WildsTier           = contentv1.WildsTier
	WildsBorder         = contentv1.WildsBorder
	WildsMap            = contentv1.WildsMap
	WildsPaths          = contentv1.WildsPaths
	WildsRiver          = contentv1.WildsRiver
	WildsRoad           = contentv1.WildsRoad
	WildsPlaceKind      = contentv1.WildsPlaceKind
	WildsCells          = contentv1.WildsCells
	WildsWords          = contentv1.WildsWords
	WildsRumour         = contentv1.WildsRumour
	WildsWeight         = contentv1.WildsWeight
)

// DecodeWilds reads wilds JSON into the generated types, refusing nulls and
// unknown keys, then runs the schema's rules (protovalidate) and the rules
// that span entries (wildsRules).
func DecodeWilds(raw []byte) (*Wilds, error) {
	doc := &Wilds{}
	if err := decodeContentProto(raw, "wilds", doc); err != nil {
		return doc, err
	}
	if err := contentValidate("wilds", entryLists(doc, "campMixes", "grounds", "places", "lands", "placeKinds"), doc); err != nil {
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

// WildsPlaceByID is the footprint with the id ("tangle", "whitequiet"),
// or nil.
func WildsPlaceByID(id string) *WildsPlace {
	for _, p := range WildsRules.Places {
		if p.GetId() == id {
			return p
		}
	}
	return nil
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

var digit = regexp.MustCompile(`[0-9]`)

// wildsRules are the cross-entry rules the schema's CEL cannot express:
// they read the catalogues another field carries. They run only after
// protovalidate passed. src/lib/wilds/data.ts wildsRules is the twin, word
// for word.
func wildsRules(w *Wilds) error {
	bad := func(format string, args ...any) error {
		return fmt.Errorf("invalid wilds: "+format, args...)
	}
	unique := func(field string, ids []string) error {
		seen := map[string]bool{}
		for _, id := range ids {
			if seen[id] {
				return bad("duplicate %s %s", field, id)
			}
			seen[id] = true
		}
		return nil
	}
	ids := func(n int, at func(int) string) []string {
		out := make([]string, n)
		for i := range out {
			out[i] = at(i)
		}
		return out
	}

	// Catalogues.
	mixIDs := ids(len(w.CampMixes), func(i int) string { return w.CampMixes[i].GetId() })
	groundIDs := ids(len(w.Grounds), func(i int) string { return w.Grounds[i].GetId() })
	decorIDs := ids(len(w.Decor), func(i int) string { return w.Decor[i].GetKind() })
	landIDs := ids(len(w.Lands), func(i int) string { return w.Lands[i].GetId() })
	placeIDs := ids(len(w.Places), func(i int) string { return w.Places[i].GetId() })
	kindIDs := ids(len(w.PlaceKinds), func(i int) string { return w.PlaceKinds[i].GetId() })
	for _, u := range []struct {
		field string
		ids   []string
	}{
		{"camp mix", mixIDs},
		{"ground", groundIDs},
		{"ground terrain", ids(len(w.Grounds), func(i int) string { return w.Grounds[i].GetTerrain() })},
		{"decor kind", decorIDs},
		{"land", landIDs},
		{"place", placeIDs},
		{"place kind", kindIDs},
		{"lay kind", ids(len(w.Paths.GetLay()), func(i int) string { return w.Paths.GetLay()[i].GetKind() })},
		{"compass dir", ids(len(w.Rumour.GetCompass()), func(i int) string { return w.Rumour.GetCompass()[i].GetDir() })},
		{"distance ring", ids(len(w.Rumour.GetDistance()), func(i int) string { return strconv.Itoa(int(w.Rumour.GetDistance()[i].GetRing())) })},
	} {
		if err := unique(u.field, u.ids); err != nil {
			return err
		}
	}
	ground := func(id string) *WildsGround {
		for _, g := range w.Grounds {
			if g.GetId() == id {
				return g
			}
		}
		return nil
	}
	decor := func(id string) *WildsDecorKind {
		for _, d := range w.Decor {
			if d.GetKind() == id {
				return d
			}
		}
		return nil
	}
	needGround := func(where, id string, surfaces ...string) error {
		g := ground(id)
		if g == nil {
			return bad("%s: unknown ground %q", where, id)
		}
		if len(surfaces) > 0 && !slices.Contains(surfaces, g.GetSurface()) {
			return bad("%s: ground %q is %s, not %s", where, id, g.GetSurface(), surfaces[0])
		}
		return nil
	}
	weights := func(where, what string, ws []*WildsWeight, known []string) error {
		seen := map[string]bool{}
		for _, x := range ws {
			if !slices.Contains(known, x.GetId()) {
				return bad("%s: unknown %s %q", where, what, x.GetId())
			}
			if seen[x.GetId()] {
				return bad("%s: %s %q weighted twice", where, what, x.GetId())
			}
			seen[x.GetId()] = true
		}
		return nil
	}

	// Camps and loot.
	for i, mix := range w.CampMixes {
		for _, e := range mix.GetEnemies() {
			if !slices.Contains(w.EnemyKinds, e) {
				return bad("campMixes[%d]: unknown enemy kind %q", i, e)
			}
		}
	}
	need := []string{"discovery", "rumour"}
	for _, k := range w.EntityKinds {
		need = append(need, lootTableIds(k.GetKind(), w.Materials)...)
	}
	for _, t := range w.Tiers {
		for c := t.GetChestMin(); c <= t.GetChestMax(); c++ {
			need = append(need, "chest:"+strconv.Itoa(int(c)))
		}
	}
	for _, id := range need {
		if _, ok := w.LootTables[id]; !ok {
			return bad("missing loot table %q", id)
		}
	}
	// Sorted, so with two unknown-material tables the same one is named
	// every run (map iteration is not).
	tables := make([]string, 0, len(w.LootTables))
	for id := range w.LootTables {
		tables = append(tables, id)
	}
	slices.Sort(tables)
	for _, id := range tables {
		for _, e := range w.LootTables[id].GetEntries() {
			if !slices.Contains(w.Materials, e.GetMaterial()) {
				return bad("loot table %q: unknown material %q", id, e.GetMaterial())
			}
		}
	}

	// Lands.
	for _, l := range w.Lands {
		where := "land " + l.GetId()
		g := l.GetGround()
		for _, id := range []string{g.GetFloor(), g.GetOpen(), g.GetVerge(), g.GetPath(), g.GetTrodden()} {
			if err := needGround(where, id, "land"); err != nil {
				return err
			}
		}
		if err := weights(where, "decor kind", l.GetDecor(), decorIDs); err != nil {
			return err
		}
		if err := weights(where, "material", l.GetMaterials(), w.Materials); err != nil {
			return err
		}
		if err := weights(where, "camp mix", l.GetCampMixes(), mixIDs); err != nil {
			return err
		}
	}
	for i, b := range w.LandSizes.GetBands() {
		if b.GetMaxChunks() > w.LandSizes.GetCapChunks() {
			return bad("landSizes.bands[%d]: past the cap", i)
		}
	}

	// Tiers: 1..n in order.
	for i, t := range w.Tiers {
		if int(t.GetTier()) != i+1 {
			return bad("tiers[%d]: tier %d out of order", i, t.GetTier())
		}
		if err := weights("tier "+strconv.Itoa(i+1), "camp mix", t.GetCampMixes(), mixIDs); err != nil {
			return err
		}
	}

	// Places: footprints, one cell each, apart; sites and openings on them.
	for i, a := range w.Places {
		for _, b := range w.Places[i+1:] {
			if a.GetCx() < b.GetCx()+b.GetWidth() && b.GetCx() < a.GetCx()+a.GetWidth() && a.GetCy() < b.GetCy()+b.GetHeight() && b.GetCy() < a.GetCy()+a.GetHeight() {
				return bad("places %s and %s overlap", a.GetId(), b.GetId())
			}
		}
	}
	S := w.GetChunkSize()
	cells := w.GetCells()
	siteIDs := []string{}
	for _, p := range w.Places {
		where := "place " + p.GetId()
		if !slices.Contains(landIDs, p.GetLand()) {
			return bad("%s: unknown land %q", where, p.GetLand())
		}
		if int(p.GetTier()) > len(w.Tiers) {
			return bad("%s: unknown tier %d", where, p.GetTier())
		}
		x0, y0 := p.GetCx()-cells.GetOriginCx(), p.GetCy()-cells.GetOriginCy()
		if p.GetWidth() != cells.GetCellChunks() || p.GetHeight() != cells.GetCellChunks() || x0%cells.GetCellChunks() != 0 || y0%cells.GetCellChunks() != 0 {
			return bad("%s: footprint is not one cell", where)
		}
		inside := func(cx, cy int32) bool {
			return cx >= p.GetCx() && cy >= p.GetCy() && cx < p.GetCx()+p.GetWidth() && cy < p.GetCy()+p.GetHeight()
		}
		for _, s := range p.GetSites() {
			siteIDs = append(siteIDs, s.GetId())
			if !inside(s.GetCx(), s.GetCy()) || s.GetTx() >= S || s.GetTy() >= S {
				return bad("%s: site %s outside the footprint", where, s.GetId())
			}
		}
		for _, s := range p.GetDealt() {
			siteIDs = append(siteIDs, s.GetId())
		}
		openings := []string{}
		for _, o := range p.GetOpenings() {
			openings = append(openings, o.GetId())
			onEdge := inside(o.GetCx(), o.GetCy())
			switch o.GetEdge() {
			case "north":
				onEdge = onEdge && o.GetCy() == p.GetCy()
			case "south":
				onEdge = onEdge && o.GetCy() == p.GetCy()+p.GetHeight()-1
			case "west":
				onEdge = onEdge && o.GetCx() == p.GetCx()
			default:
				onEdge = onEdge && o.GetCx() == p.GetCx()+p.GetWidth()-1
			}
			if !onEdge || o.GetOffset()+o.GetWidth() > S {
				return bad("%s: opening %s off the footprint's edge", where, o.GetId())
			}
		}
		if err := unique(where+" opening", openings); err != nil {
			return err
		}
	}
	if err := unique("site", siteIDs); err != nil {
		return err
	}

	// Paths.
	for _, c := range w.Paths.GetClearTools() {
		if decor(c.GetDecor()) == nil {
			return bad("paths.clearTools: unknown decor kind %q", c.GetDecor())
		}
	}
	for _, l := range w.Paths.GetLay() {
		if err := needGround("paths.lay "+l.GetKind(), l.GetGround(), "laid"); err != nil {
			return err
		}
		if !slices.Contains(w.Materials, l.GetMaterial()) {
			return bad("paths.lay %s: unknown material %q", l.GetKind(), l.GetMaterial())
		}
	}
	for _, s := range w.Paths.GetWalk() {
		if err := needGround("paths.walk", s.GetGround()); err != nil {
			return err
		}
	}

	// The river and the road.
	r := w.GetRiver()
	if err := needGround("river", r.GetWaterGround(), "water"); err != nil {
		return err
	}
	if err := needGround("river", r.GetBankGround(), "land"); err != nil {
		return err
	}
	if err := needGround("river", r.GetFordGround(), "ford"); err != nil {
		return err
	}
	if !slices.Contains(landIDs, r.GetLeanLand()) {
		return bad("river: unknown land %q", r.GetLeanLand())
	}
	road := w.GetRoad()
	if err := needGround("road", road.GetGround(), "road"); err != nil {
		return err
	}
	if err := needGround("road", road.GetVergeGround()); err != nil {
		return err
	}
	from := slices.IndexFunc(w.Places, func(p *WildsPlace) bool { return p.GetId() == road.GetFromPlace() })
	if from < 0 || !slices.ContainsFunc(w.Places[from].GetOpenings(), func(o *WildsOpening) bool { return o.GetId() == road.GetFromOpening() }) {
		return bad("road: unknown opening %s/%s", road.GetFromPlace(), road.GetFromOpening())
	}

	// Place kinds and the rumour.
	rumour := w.GetRumour()
	for _, l := range rumour.GetLandmarks() {
		if decor(l.GetDecor()) == nil {
			return bad("rumour: unknown decor kind %q", l.GetDecor())
		}
	}
	for _, k := range w.PlaceKinds {
		where := "place kind " + k.GetId()
		if !slices.Contains(landIDs, k.GetLand()) {
			return bad("%s: unknown land %q", where, k.GetLand())
		}
		d := decor(k.GetLandmark())
		if d == nil || !d.GetBlocking() {
			return bad("%s: landmark %q is not a blocking decor kind", where, k.GetLandmark())
		}
		if !slices.ContainsFunc(rumour.GetLandmarks(), func(l *contentv1.WildsRumourLandmark) bool { return l.GetDecor() == k.GetLandmark() }) {
			return bad("%s: landmark %q has no rumour phrase", where, k.GetLandmark())
		}
	}
	phrases := []string{rumour.GetTemplate(), rumour.GetPastRiver(), rumour.GetOpened(), rumour.GetNone()}
	for _, l := range rumour.GetLandmarks() {
		phrases = append(phrases, l.GetPhrase())
	}
	for _, c := range rumour.GetCompass() {
		phrases = append(phrases, c.GetPhrase())
	}
	for _, d := range rumour.GetDistance() {
		phrases = append(phrases, d.GetPhrase())
	}
	for _, p := range phrases {
		if digit.MatchString(p) {
			return bad("rumour: a digit in %q", p)
		}
	}
	return nil
}
