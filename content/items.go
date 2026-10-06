package content

import (
	"encoding/json"
	"fmt"
	"slices"
	"sort"
)

// Item definitions (content/items.json; docs/items/). Typed loaders on both
// sides: this one for Go, src/lib/items.ts for TypeScript. The spec for
// entering more of the catalogue is in .agent/REPORT.md ("Data format").

// ItemEffect is one small, typed help. Which types are allowed depends on
// where the effect sits: `use` (a consumable, once), `pocket` (a keepsake in
// a pocket) or `held` (the off hand). Amount, seconds and target are optional
// and mean what the type says.
type ItemEffect struct {
	Type    string `json:"type"`
	Amount  int    `json:"amount,omitempty"`
	Seconds int    `json:"seconds,omitempty"`
	Target  string `json:"target,omitempty"`
}
type ItemAffinity struct {
	Class string       `json:"class"`
	Held  []ItemEffect `json:"held"`
}

// ItemRepair is what mending an heirloom costs: at your own bench, or by a
// mender (Silas, Orrin) while you talk.
type ItemRepair struct {
	Bench        map[string]int `json:"bench"`
	Mender       map[string]int `json:"mender,omitempty"`
	MenderEmbers int            `json:"menderEmbers,omitempty"`
}
type ItemDef struct {
	ID        string        `json:"id"`
	Name      string        `json:"name"`
	Tab       string        `json:"tab"`
	Kind      string        `json:"kind"`
	Blurb     string        `json:"blurb"`
	Icon      string        `json:"icon,omitempty"`
	Grade     string        `json:"grade,omitempty"`
	Uses      int           `json:"uses,omitempty"`
	AtZero    string        `json:"atZero,omitempty"`
	Slots     *int          `json:"slots,omitempty"`
	Actions   []string      `json:"actions,omitempty"`
	Repair    *ItemRepair   `json:"repair,omitempty"`
	Fitting   string        `json:"fitting,omitempty"`
	Use       []ItemEffect  `json:"use,omitempty"`
	Pocket    []ItemEffect  `json:"pocket,omitempty"`
	Held      []ItemEffect  `json:"held,omitempty"`
	Affinity  *ItemAffinity `json:"affinity,omitempty"`
	OffHand   bool          `json:"offHand,omitempty"`
	Bound     bool          `json:"bound,omitempty"`
	BelongsTo string        `json:"belongsTo,omitempty"`
	Marked    bool          `json:"marked,omitempty"`
}
type ItemGrade struct {
	Slots  int    `json:"slots"`
	AtZero string `json:"atZero"`
	Bound  bool   `json:"bound,omitempty"`
}
type ItemMender struct {
	NPC         string `json:"npc"`
	Name        string `json:"name"`
	Area        string `json:"area"`
	TX          int    `json:"tx"`
	TY          int    `json:"ty"`
	RadiusTiles int    `json:"radiusTiles"`
}
type ItemPickup struct {
	ID       string `json:"id"`
	Item     string `json:"item"`
	Qty      int    `json:"qty"`
	Area     string `json:"area"`
	TX       int    `json:"tx"`
	TY       int    `json:"ty"`
	UsesLeft int    `json:"usesLeft,omitempty"`
	Label    string `json:"label"`
	Found    string `json:"found"`
}
type ItemRules struct {
	Grades map[string]ItemGrade `json:"grades"`
	Wear   struct {
		PointsPerUse     int `json:"pointsPerUse"`
		HoldPointsPerUse int `json:"holdPointsPerUse"`
		FittingUses      int `json:"fittingUses"`
		WornBelowPercent int `json:"wornBelowPercent"`
		WardenDullUses   int `json:"wardenDullUses"`
	} `json:"wear"`
	Pockets struct {
		Base          int `json:"base"`
		WithCarryGear int `json:"withCarryGear"`
	} `json:"pockets"`
	OffHand struct {
		TuckDuring []string `json:"tuckDuring"`
	} `json:"offHand"`
	Give struct {
		RadiusTiles int `json:"radiusTiles"`
	} `json:"give"`
	Thanks struct {
		NearbyTiles int `json:"nearbyTiles"`
	} `json:"thanks"`
	Menders []ItemMender `json:"menders"`
	// Where the named residents stand, shared by the server's proximity
	// checks (returning a keepsake) and the client's placement.
	Residents []ItemResident `json:"residents"`
}

type ItemResident struct {
	ID   string `json:"id"`
	Area string `json:"area"`
	TX   int    `json:"tx"`
	TY   int    `json:"ty"`
}
type Items struct {
	Rules   ItemRules    `json:"rules"`
	Items   []ItemDef    `json:"items"`
	Pickups []ItemPickup `json:"pickups"`
}

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
	ImplementedUses = []string{"restore-hp", "restore-mana"}
	atZeroForGrade  = map[string][]string{"cheap": {"breaks"}, "heirloom": {"blunt", "cracked"}, "special": {"never"}}
)

// Instanced items are kept one by one (condition, fittings, maker); every
// other carried item is a stack by count (per maker). Home goods are
// homestead instances (homestead_items) and papers are story flags.
func (d ItemDef) Instanced() bool { return slices.Contains(instancedKinds, d.Kind) }
func (d ItemDef) Stackable() bool {
	return !d.Instanced() && d.Kind != "home-good" && d.Kind != "paper"
}

// AssetKind is the wire kind for moving it (mail, chests, gifts).
func (d ItemDef) AssetKind() string {
	switch {
	case d.Kind == "material":
		return "material"
	case d.Kind == "home-good":
		return "decoration"
	case d.Instanced():
		return "instance"
	}
	return "item"
}

// Giveable: heirlooms and story keepsakes stay with the one they were given to.
func (d ItemDef) Giveable() bool {
	if d.Bound {
		return false
	}
	if g, ok := ItemsRules.Rules.Grades[d.Grade]; ok && g.Bound {
		return false
	}
	return true
}

// AtZeroRule: "breaks" (gone), "blunt"/"cracked" (kept, unusable until
// mended) or "never" (does not wear). Fittings and carry gear never break
// as tools do; fittings wear out on their own count (rules.wear.fittingUses).
func (d ItemDef) AtZeroRule() string {
	if d.Kind != "tool" {
		return "never"
	}
	if d.AtZero != "" {
		return d.AtZero
	}
	return ItemsRules.Rules.Grades[d.Grade].AtZero
}
func (d ItemDef) SlotCount() int {
	if d.Kind != "tool" {
		return 0
	}
	if d.Slots != nil {
		return *d.Slots
	}
	return ItemsRules.Rules.Grades[d.Grade].Slots
}

// MaxPoints is full condition in wear points (uses × rules.wear.pointsPerUse);
// zero means it does not wear.
func (d ItemDef) MaxPoints() int {
	per := ItemsRules.Rules.Wear.PointsPerUse
	switch {
	case d.Kind == "tool" && d.AtZeroRule() != "never":
		return d.Uses * per
	case d.Kind == "fitting" && d.Fitting != "remember":
		return ItemsRules.Rules.Wear.FittingUses * per
	}
	return 0
}

// UsableNow: a consumable whose every effect the game can apply today.
func (d ItemDef) UsableNow() bool {
	if d.Kind != "consumable" || len(d.Use) == 0 {
		return false
	}
	for _, e := range d.Use {
		if !slices.Contains(ImplementedUses, e.Type) {
			return false
		}
	}
	return true
}

// Carryable in the off hand.
func (d ItemDef) OffHandable() bool { return d.Kind == "off-hand" || d.OffHand }

func validEffects(list []ItemEffect, allowed []string) bool {
	for _, e := range list {
		if !slices.Contains(allowed, e.Type) || e.Amount < 0 || e.Amount > 1000 || e.Seconds < 0 || e.Seconds > 86400 || len(e.Target) > 100 {
			return false
		}
		if (e.Type == "restore-hp" || e.Type == "restore-mana") && e.Amount < 1 {
			return false
		}
	}
	return true
}

// validStackCosts: a non-empty bill of carried stackable items.
func validStackCosts(costs map[string]int, defs map[string]ItemDef) bool {
	if len(costs) == 0 {
		return false
	}
	for id, n := range costs {
		d, ok := defs[id]
		if !ok || !d.Stackable() || n < 1 || n > 1000000 {
			return false
		}
	}
	return true
}

func ValidateItems(v Items) error {
	bad := func(f string, a ...any) error { return fmt.Errorf("invalid items: "+f, a...) }
	r := v.Rules
	if len(r.Grades) != 3 {
		return bad("grades")
	}
	for name, allowed := range atZeroForGrade {
		g, ok := r.Grades[name]
		if !ok || !slices.Contains(allowed, g.AtZero) || g.Slots < 0 || g.Slots > len(FittingKinds) {
			return bad("grade %q", name)
		}
	}
	if r.Wear.PointsPerUse < 1 || r.Wear.HoldPointsPerUse < 1 || r.Wear.HoldPointsPerUse > r.Wear.PointsPerUse || r.Wear.FittingUses < 1 || r.Wear.WornBelowPercent < 1 || r.Wear.WornBelowPercent > 99 || r.Wear.WardenDullUses < 1 {
		return bad("wear")
	}
	if r.Pockets.Base < 1 || r.Pockets.WithCarryGear < r.Pockets.Base || r.Pockets.WithCarryGear > 4 || r.Give.RadiusTiles < 1 || r.Thanks.NearbyTiles < 1 {
		return bad("pockets/give/thanks")
	}
	for _, a := range r.OffHand.TuckDuring {
		if a == "" {
			return bad("tuck")
		}
	}
	npcs := map[string]bool{}
	residents := map[string]bool{}
	for _, m := range r.Menders {
		if !ValidContentID(m.NPC) || m.Name == "" || npcs[m.NPC] || !slices.Contains(PickupAreas, m.Area) || m.TX < 0 || m.TY < 0 || m.RadiusTiles < 1 {
			return bad("mender %q", m.NPC)
		}
		npcs[m.NPC] = true
	}
	for _, res := range r.Residents {
		if !ValidContentID(res.ID) || residents[res.ID] || !slices.Contains(PickupAreas, res.Area) || res.TX < 0 || res.TY < 0 {
			return bad("resident %q", res.ID)
		}
		residents[res.ID] = true
	}
	defs := map[string]ItemDef{}
	for _, d := range v.Items {
		if !ValidContentID(d.ID) || defs[d.ID].ID != "" || d.Name == "" || d.Blurb == "" || !slices.Contains(ItemKinds, d.Kind) || kindTab[d.Kind] != d.Tab || (d.Icon != "" && !ValidContentID(d.Icon)) {
			return bad("item %q", d.ID)
		}
		defs[d.ID] = d
	}
	for _, d := range v.Items {
		fail := func(why string) error { return bad("item %q: %s", d.ID, why) }
		if d.Kind == "tool" {
			g, ok := r.Grades[d.Grade]
			if !ok {
				return fail("grade")
			}
			if (g.AtZero == "never") != (d.Uses == 0) || d.Uses < 0 || d.Uses > 10000 {
				return fail("uses")
			}
			if d.AtZero != "" && !slices.Contains(atZeroForGrade[d.Grade], d.AtZero) {
				return fail("atZero")
			}
			if d.Slots != nil && (*d.Slots < 0 || *d.Slots > len(FittingKinds)) {
				return fail("slots")
			}
			if len(d.Actions) == 0 {
				return fail("actions")
			}
			for _, a := range d.Actions {
				if !slices.Contains(ToolActions, a) {
					return fail("action " + a)
				}
			}
			atZero := d.AtZero
			if atZero == "" {
				atZero = g.AtZero
			}
			mends := atZero == "blunt" || atZero == "cracked"
			if mends != (d.Repair != nil) {
				return fail("repair")
			}
			if d.Repair != nil {
				if !validStackCosts(d.Repair.Bench, defs) || (d.Repair.Mender != nil && !validStackCosts(d.Repair.Mender, defs)) || d.Repair.MenderEmbers < 0 || (d.Repair.Mender == nil && d.Repair.MenderEmbers == 0) {
					return fail("repair cost")
				}
			}
		} else if d.Grade != "" || d.Uses != 0 || d.AtZero != "" || d.Slots != nil || len(d.Actions) > 0 || d.Repair != nil {
			return fail("tool fields on a non-tool")
		}
		if (d.Kind == "fitting") != slices.Contains(FittingKinds, d.Fitting) {
			return fail("fitting")
		}
		if (d.Kind == "consumable") != (len(d.Use) > 0) || !validEffects(d.Use, UseEffects) {
			return fail("use")
		}
		if (len(d.Pocket) > 0 && d.Kind != "keepsake") || !validEffects(d.Pocket, PocketEffects) {
			return fail("pocket")
		}
		if d.OffHand && d.Kind != "keepsake" && d.Kind != "tool" {
			return fail("offHand")
		}
		if (len(d.Held) > 0) != d.OffHandable() || !validEffects(d.Held, HeldEffects) {
			return fail("held")
		}
		if d.Affinity != nil && (!slices.Contains(PlayerClasses, d.Affinity.Class) || len(d.Affinity.Held) == 0 || !validEffects(d.Affinity.Held, HeldEffects) || !d.OffHandable()) {
			return fail("affinity")
		}
		if d.BelongsTo != "" && (d.Kind != "keepsake" || !ValidContentID(d.BelongsTo)) {
			return fail("belongsTo")
		}
		if d.Kind == "home-good" {
			h, ok := HomeItemFor(d.ID)
			if !ok || h.Name != d.Name {
				return fail("home good not in homestead.json")
			}
		}
	}
	// Everything that can already be carried has a definition.
	for _, m := range WildsRules.Materials {
		if defs[m].Kind != "material" {
			return bad("wilds material %q", m)
		}
	}
	for _, t := range WildsRules.Trinkets {
		if defs[t].Kind != "keepsake" {
			return bad("wilds trinket %q", t)
		}
	}
	if defs[Rules.CharmItem].Kind != "keepsake" {
		return bad("charm")
	}
	pickups := map[string]bool{}
	for _, p := range v.Pickups {
		d, ok := defs[p.Item]
		if !ValidContentID(p.ID) || pickups[p.ID] || !ok || !(d.Stackable() || d.Instanced()) || p.Qty < 1 || p.Qty > 100 || (d.Instanced() && p.Qty != 1) ||
			!slices.Contains(PickupAreas, p.Area) || p.TX < 0 || p.TY < 0 || p.Label == "" || p.Found == "" ||
			p.UsesLeft < 0 || (p.UsesLeft > 0 && (d.Kind != "tool" || p.UsesLeft > d.Uses)) {
			return bad("pickup %q", p.ID)
		}
		pickups[p.ID] = true
	}
	return nil
}
func LoadItems() (Items, error) {
	var v Items
	b, err := FS.ReadFile("items.json")
	if err == nil {
		err = json.Unmarshal(b, &v)
	}
	if err == nil {
		err = ValidateItems(v)
	}
	return v, err
}

var ItemsRules = func() Items {
	v, err := LoadItems()
	if err != nil {
		panic(err)
	}
	return v
}()

var itemsByID = func() map[string]ItemDef {
	m := map[string]ItemDef{}
	for _, d := range ItemsRules.Items {
		m[d.ID] = d
	}
	return m
}()

func ItemFor(id string) (ItemDef, bool) {
	d, ok := itemsByID[id]
	return d, ok
}
func PickupFor(id string) (ItemPickup, bool) {
	for _, p := range ItemsRules.Pickups {
		if p.ID == id {
			return p, true
		}
	}
	return ItemPickup{}, false
}
func MenderFor(npc string) (ItemMender, bool) {
	for _, m := range ItemsRules.Rules.Menders {
		if m.NPC == npc {
			return m, true
		}
	}
	return ItemMender{}, false
}

// ResidentFor is where a named resident stands (shared content; the client
// places them from the same rows).
func ResidentFor(id string) (ItemResident, bool) {
	for _, r := range ItemsRules.Rules.Residents {
		if r.ID == id {
			return r, true
		}
	}
	return ItemResident{}, false
}

// SortedCosts walks a bill in a fixed order (stable ledgers and errors).
func SortedCosts(costs map[string]int) []string {
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
	if d, ok := ItemFor(id); ok && d.Kind == "material" {
		return "material:" + id
	}
	return "item:" + id
}
