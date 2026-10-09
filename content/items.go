package content

import (
	"fmt"
	"slices"
	"sort"

	contentv1 "glimway/gen/glimway/content/v1"
)

// Item definitions (content/items.json; docs/items/), on the generated
// types (proto/glimway/content/v1/items.proto). Catalogue entries and their
// rules are described in docs/items/catalogue.md and overview.md.
type (
	Items        = contentv1.Items
	ItemRules    = contentv1.ItemsRules
	ItemGrade    = contentv1.ItemGrade
	ItemWear     = contentv1.ItemWear
	ItemPockets  = contentv1.ItemPockets
	ItemOffHand  = contentv1.ItemOffHand
	ItemGive     = contentv1.ItemGive
	ItemThanks   = contentv1.ItemThanks
	ItemMender   = contentv1.ItemMender
	ItemDef      = contentv1.ItemDef
	ItemRepair   = contentv1.ItemRepair
	ItemEffect   = contentv1.UseEffect
	UseEffect    = contentv1.UseEffect
	PocketEffect = contentv1.PocketEffect
	HeldEffect   = contentv1.HeldEffect
	ItemAffinity = contentv1.ItemAffinity
	ItemPickup   = contentv1.ItemPickup
	ItemGood     = contentv1.ItemGood
	ItemSeller   = contentv1.ItemSeller
)

// The closed sets. A new kind, tab, fitting or effect type is a code change
// on both sides (src/lib/items.ts mirrors these), never just data.
var (
	ItemTabs        = []string{"tools", "supplies", "keepsakes", "home", "papers"}
	ItemKinds       = []string{"tool", "consumable", "material", "fitting", "part", "seed", "keepsake", "home-good", "paper", "off-hand", "carry-gear"}
	FittingKinds    = []string{"bite", "hold", "heft", "glow", "grip", "remember"}
	ToolActions     = []string{"chop", "break", "dig", "draw", "water", "trim", "mark"}
	PlayerClasses   = []string{"warrior", "mage", "healer", "rogue"}
	UseEffects      = []string{"restore-hp", "restore-mana", "clear-unmoored", "ease-unmoored", "wisps-forget", "refill-lantern", "light-post"}
	PocketEffects   = []string{"papers-glint", "notice-later", "gather-more", "pond-skip", "wend-gives-more"}
	HeldEffects     = []string{"light", "wisps-keep-off", "compass", "remedy-at-hand", "whistle", "papers-chime"}
	PickupAreas     = []string{"village", "woodland", "ruin", "commons"}
	kindTab         = map[string]string{"tool": "tools", "off-hand": "tools", "carry-gear": "tools", "consumable": "supplies", "material": "supplies", "fitting": "supplies", "part": "supplies", "seed": "supplies", "keepsake": "keepsakes", "home-good": "home", "paper": "papers"}
	instancedKinds  = []string{"tool", "off-hand", "carry-gear", "fitting"}
	ImplementedUses = []string{"restore-hp", "restore-mana", "clear-unmoored", "ease-unmoored"}
	atZeroForGrade  = map[string][]string{"cheap": {"breaks"}, "heirloom": {"blunt", "cracked"}, "special": {"never"}}
)

// Instanced items are kept one by one (condition, fittings, maker); every
// other carried item is a stack by count (per maker). Home goods are
// homestead instances (homestead_items) and papers are story flags.
func ItemInstanced(d *ItemDef) bool { return slices.Contains(instancedKinds, d.GetKind()) }
func ItemStackable(d *ItemDef) bool {
	return !ItemInstanced(d) && d.GetKind() != "home-good"
}

// ItemAssetKind is the wire kind for moving it (mail, chests, gifts).
func ItemAssetKind(d *ItemDef) string {
	switch {
	case d.GetKind() == "material":
		return "material"
	case d.GetKind() == "home-good":
		return "decoration"
	case ItemInstanced(d):
		return "instance"
	}
	return "item"
}

// ItemGiveable: heirlooms and story keepsakes stay with the one they were
// given to.
func ItemGiveable(d *ItemDef) bool {
	if d.GetBound() {
		return false
	}
	if g, ok := ItemsRules.Rules.Grades[d.GetGrade()]; ok && g.GetBound() {
		return false
	}
	return true
}

// ItemAtZeroRule: "breaks" (gone), "blunt"/"cracked" (kept, unusable until
// mended) or "never" (does not wear). Fittings and carry gear never break
// as tools do; fittings wear out on their own count (rules.wear.fittingUses).
func ItemAtZeroRule(d *ItemDef) string {
	if d.GetKind() != "tool" {
		return "never"
	}
	if d.GetAtZero() != "" {
		return d.GetAtZero()
	}
	return ItemsRules.Rules.Grades[d.GetGrade()].GetAtZero()
}
func ItemSlotCount(d *ItemDef) int {
	if d.GetKind() != "tool" {
		return 0
	}
	if d.GetSlots() != 0 {
		return int(d.GetSlots())
	}
	return int(ItemsRules.Rules.Grades[d.GetGrade()].GetSlots())
}

// ItemMaxPoints is full condition in wear points (uses ×
// rules.wear.pointsPerUse); zero means it does not wear.
func ItemMaxPoints(d *ItemDef) int {
	per := int(ItemsRules.Rules.Wear.PointsPerUse)
	switch {
	case d.GetKind() == "tool" && ItemAtZeroRule(d) != "never":
		return int(d.GetUses()) * per
	case d.GetKind() == "fitting" && d.GetFitting() != "remember":
		return int(ItemsRules.Rules.Wear.FittingUses) * per
	}
	return 0
}

// ItemUsableNow: a consumable whose every effect the game can apply today.
func ItemUsableNow(d *ItemDef) bool {
	if d.GetKind() != "consumable" || len(d.GetUse()) == 0 {
		return false
	}
	for _, e := range d.GetUse() {
		if !slices.Contains(ImplementedUses, e.GetType()) {
			return false
		}
	}
	return true
}

// ItemOffHandable: carryable in the off hand.
func ItemOffHandable(d *ItemDef) bool { return d.GetKind() == "off-hand" || d.GetOffHand() }

// DecodeItems reads items JSON into the generated types, refusing nulls and
// unknown keys, then runs the schema's rules (protovalidate) and the
// catalogue's own rules.
func DecodeItems(raw []byte) (*Items, error) {
	doc := &Items{}
	if err := decodeContentProto(raw, "items", doc); err != nil {
		return doc, err
	}
	if err := contentValidate("items", entryLists(doc, "items", "pickups", "sellers"), doc); err != nil {
		return doc, err
	}
	return doc, validateItems(doc)
}

// validateItems: the rules that span entries or families, after the
// schema's (protovalidate) have passed. Uniqueness first: one map loop per
// list, naming the duplicate.
func validateItems(v *Items) error {
	r := v.GetRules()
	npcs := map[string]bool{}
	for _, m := range r.GetMenders() {
		if npcs[m.GetNpc()] {
			return fmt.Errorf("invalid items: duplicate mender %s", m.GetNpc())
		}
		npcs[m.GetNpc()] = true
	}
	defs := map[string]bool{}
	for _, d := range v.GetItems() {
		if defs[d.GetId()] {
			return fmt.Errorf("invalid items: duplicate id %s", d.GetId())
		}
		defs[d.GetId()] = true
	}
	loaded := map[string]*ItemDef{}
	for _, d := range v.GetItems() {
		loaded[d.GetId()] = d
	}
	for _, d := range v.GetItems() {
		if d.GetKind() == "tool" {
			g, ok := r.GetGrades()[d.GetGrade()]
			if !ok {
				return fmt.Errorf("invalid items: item %s: grade", d.GetId())
			}
			if (g.GetAtZero() == "never") != (d.GetUses() == 0) {
				return fmt.Errorf("invalid items: item %s: uses", d.GetId())
			}
			if d.GetAtZero() != "" && !slices.Contains(atZeroForGrade[d.GetGrade()], d.GetAtZero()) {
				return fmt.Errorf("invalid items: item %s: atZero", d.GetId())
			}
			if len(d.GetActions()) == 0 {
				return fmt.Errorf("invalid items: item %s: actions", d.GetId())
			}
			atZero := d.GetAtZero()
			if atZero == "" {
				atZero = g.GetAtZero()
			}
			mends := atZero == "blunt" || atZero == "cracked"
			if mends != (d.GetRepair() != nil) {
				return fmt.Errorf("invalid items: item %s: repair", d.GetId())
			}
			if d.GetRepair() != nil {
				rep := d.GetRepair()
				if !validStackCosts(rep.GetBench(), loaded) || (rep.GetMender() != nil && !validStackCosts(rep.GetMender(), loaded)) || (rep.GetMender() == nil && rep.GetMenderEmbers() == 0) {
					return fmt.Errorf("invalid items: item %s: repair cost", d.GetId())
				}
			}
		}
		if (d.GetKind() == "consumable") != (len(d.GetUse()) > 0) {
			return fmt.Errorf("invalid items: item %s: use", d.GetId())
		}
		if d.GetKind() == "home-good" {
			h, ok := HomeItemFor(d.GetId())
			if !ok || h.GetName() != d.GetName() {
				return fmt.Errorf("invalid items: item %s: home good not in homestead.json", d.GetId())
			}
		}
	}
	// Everything that can already be carried has a definition.
	for _, m := range WildsRules.Materials {
		if d := loaded[m]; d == nil || d.GetKind() != "material" {
			return fmt.Errorf("invalid items: wilds material %s", m)
		}
	}
	for _, t := range WildsRules.Trinkets {
		if d := loaded[t]; d == nil || d.GetKind() != "keepsake" {
			return fmt.Errorf("invalid items: wilds trinket %s", t)
		}
	}
	if d := loaded[Rules.GetCharmItem()]; d == nil || d.GetKind() != "keepsake" {
		return fmt.Errorf("invalid items: charm")
	}
	pickups := map[string]bool{}
	for _, p := range v.GetPickups() {
		d, ok := loaded[p.GetItem()]
		if pickups[p.GetId()] {
			return fmt.Errorf("invalid items: duplicate pickup %s", p.GetId())
		}
		if !ok || !(ItemStackable(d) || ItemInstanced(d)) || (ItemInstanced(d) && p.GetQty() != 1) {
			return fmt.Errorf("invalid items: pickup %s", p.GetId())
		}
		if p.GetUsesLeft() > 0 && (d.GetKind() != "tool" || p.GetUsesLeft() > d.GetUses()) {
			return fmt.Errorf("invalid items: pickup %s: usesLeft", p.GetId())
		}
		pickups[p.GetId()] = true
	}
	// Sellers: people and stalls that sell goods for embers. A festival
	// seller stands on its day only; the calendar is loaded, not a global,
	// so validation never depends on init order.
	cal, err := LoadCalendar()
	if err != nil {
		return fmt.Errorf("invalid items: calendar")
	}
	sellers := map[string]bool{}
	for _, s := range v.GetSellers() {
		if sellers[s.GetId()] {
			return fmt.Errorf("invalid items: duplicate seller %s", s.GetId())
		}
		if !validSellerPlace(s) {
			return fmt.Errorf("invalid items: seller %s: place", s.GetId())
		}
		if s.GetFestival() != "" && !slices.ContainsFunc(cal.Festivals, func(f Festival) bool { return f.Name == s.GetFestival() }) {
			return fmt.Errorf("invalid items: seller %s: festival", s.GetId())
		}
		goods := map[string]bool{}
		for _, g := range s.GetGoods() {
			d, ok := loaded[g.GetItem()]
			if goods[g.GetItem()] {
				return fmt.Errorf("invalid items: seller %s: duplicate good %s", s.GetId(), g.GetItem())
			}
			if !ok || !ItemStackable(d) {
				return fmt.Errorf("invalid items: seller %s good %s", s.GetId(), g.GetItem())
			}
			goods[g.GetItem()] = true
		}
		sellers[s.GetId()] = true
	}
	return nil
}

func LoadItems() (*Items, error) {
	raw, err := FS.ReadFile("items.json")
	if err != nil {
		return nil, err
	}
	return DecodeItems(raw)
}

var ItemsRules = func() *Items {
	v, err := LoadItems()
	if err != nil {
		panic(err)
	}
	return v
}()

var itemsByID = func() map[string]*ItemDef {
	m := map[string]*ItemDef{}
	for _, d := range ItemsRules.Items {
		m[d.GetId()] = d
	}
	return m
}()

func ItemFor(id string) (*ItemDef, bool) {
	d, ok := itemsByID[id]
	return d, ok
}

func PickupFor(id string) (*ItemPickup, bool) {
	for _, p := range ItemsRules.Pickups {
		if p.GetId() == id {
			return p, true
		}
	}
	return nil, false
}
func MenderFor(npc string) (*ItemMender, bool) {
	for _, m := range ItemsRules.Rules.Menders {
		if m.GetNpc() == npc {
			return m, true
		}
	}
	return nil, false
}

func validSellerPlace(s *ItemSeller) bool {
	if s.GetWith() == "" {
		return slices.Contains(PickupAreas, s.GetArea())
	}
	residents, err := LoadResidents()
	if err != nil || s.GetArea() != "" || s.GetTx() != 0 || s.GetTy() != 0 {
		return false
	}
	return slices.ContainsFunc(residents.GetResidents(), func(r *Resident) bool { return r.GetId() == s.GetWith() })
}

// SellerFor is a seller by id (shared content; the client prompts at the
// same spots).
func SellerFor(id string) (*ItemSeller, bool) {
	for _, s := range ItemsRules.Sellers {
		if s.GetId() == id {
			return s, true
		}
	}
	return nil, false
}

// SortedCosts walks a bill in a fixed order (stable ledgers and errors).
func SortedCosts(costs map[string]int32) []string {
	ids := make([]string, 0, len(costs))
	for id := range costs {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids
}

// StackCurrency is the ledger currency for a carried stack: materials keep
// their historical "material:" prefix, everything else is "item:".
func StackCurrency(id string) string {
	if d, ok := ItemFor(id); ok && d.GetKind() == "material" {
		return "material:" + id
	}
	return "item:" + id
}
