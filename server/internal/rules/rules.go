// Package rules is the pure Go port of the guest sync and ember rules.
package rules

import (
	"encoding/json"
	"errors"
	"glimway/content"
	"math"
	"reflect"
	"slices"
	"strings"
)

var E = content.Rules
var SafeAreas = map[string]bool{"village": true, "commons": true}

// HomeGate is the gate number of a homestead map's area id ("home:<g>",
// canonical 0..9999), or -1 for anything else.
func HomeGate(area string) int {
	s, ok := strings.CutPrefix(area, "home:")
	if !ok || s == "" || len(s) > 4 || (len(s) > 1 && s[0] == '0') {
		return -1
	}
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return -1
		}
		n = n*10 + int(c-'0')
	}
	return n
}

// IsSafeArea: where syncs and rests may happen (the village, the Commons
// and every homestead map).
func IsSafeArea(area string) bool {
	area = content.RootArea(area)
	return SafeAreas[area] || HomeGate(area) >= 0
}

var Stages = []string{"new", "accepted", "clue-found", "guardian-defeated", "lantern-lit", "complete"}
var QuestItems = content.StoryRules.QuestItems

type Position struct {
	X float64 `json:"x"`
	Y float64 `json:"y"`
}
type State struct {
	Version  int      `json:"version"`
	Area     string   `json:"area"`
	Position Position `json:"position"`
	// Quest is retained only for frozen pre-029 document backfills. Live state uses Quests.
	Quest           string            `json:"quest,omitempty"`
	Quests          map[string]string `json:"quests,omitempty"`
	ReachedAt       map[string]int64  `json:"reachedAt,omitempty"`
	GateAt          map[string]int64  `json:"gateAt,omitempty"`
	HP              float64           `json:"hp"`
	MaxHP           float64           `json:"maxHp"`
	Mana            float64           `json:"mana"`
	MaxMana         float64           `json:"maxMana"`
	Inventory       []string          `json:"inventory"`
	Discoveries     []string          `json:"discoveries"`
	DefeatedEnemies []string          `json:"defeatedEnemies"`
	PlaySeconds     float64           `json:"playSeconds"`
	Embers          int               `json:"embers"`
	Flags           []string          `json:"flags"`
	EmberXP         float64           `json:"emberXp"`
	XPEmbers        int               `json:"xpEmbers"`
}
type Stats struct {
	Str float64 `json:"str"`
	Int float64 `json:"int"`
	Con float64 `json:"con"`
	Per float64 `json:"per"`
}
type Appearance struct {
	Size         string  `json:"size"`
	Shirt        string  `json:"shirt"`
	Skin         string  `json:"skin"`
	HairColor    string  `json:"hairColor"`
	HairStyle    float64 `json:"hairStyle"`
	Background   string  `json:"background"`
	HairBangs    float64 `json:"hairBangs"`
	HairMustache float64 `json:"hairMustache"`
	HairBeard    float64 `json:"hairBeard"`
	HairFlower   float64 `json:"hairFlower"`
}
type Profile struct {
	PartyID       *string            `json:"-"`
	ID            string             `json:"id"`
	Name          string             `json:"name"`
	Class         *string            `json:"class"`
	Level         float64            `json:"level"`
	Exp           *float64           `json:"exp,omitempty"`
	HP            float64            `json:"hp"`
	MaxHP         float64            `json:"maxHp"`
	MP            float64            `json:"mp"`
	MaxMP         float64            `json:"maxMp"`
	Stats         Stats              `json:"stats"`
	Equipped      map[string]*string `json:"equipped"`
	Pets          []string           `json:"pets"`
	Mounts        []string           `json:"mounts"`
	Appearance    Appearance         `json:"appearance"`
	Costume       map[string]*string `json:"costume"`
	UseCostume    bool               `json:"useCostume"`
	SelectedPet   *string            `json:"selectedPet"`
	SelectedMount *string            `json:"selectedMount"`
}

var Slots = []string{"weapon", "shield", "armor", "head", "headAccessory", "back", "body", "eyewear", "weaponSpecial"}

func SanitizeProfile(p Profile) Profile {
	clean := func(m map[string]*string) map[string]*string {
		out := map[string]*string{}
		for _, k := range Slots {
			v := m[k]
			if v != nil && *v == "" {
				v = nil
			}
			out[k] = v
		}
		return out
	}
	p.Equipped = clean(p.Equipped)
	if p.Costume == nil {
		p.Costume = map[string]*string{}
	} else {
		p.Costume = clean(p.Costume)
	}
	if p.Pets == nil {
		p.Pets = []string{}
	}
	if p.Mounts == nil {
		p.Mounts = []string{}
	}
	return p
}
func finite(n float64) bool { return !math.IsNaN(n) && !math.IsInf(n, 0) }

// Habitica's API spells the mage class "wizard" — in user stats.class and in
// gear klass/specialClass (content/habitica-gear.json). Class admissions
// accept both spellings; everything stored or replayed internally uses
// "mage". NormalizeClass maps Habitica's alias onto the internal class and
// reports whether the class is known at all.
func NormalizeClass(class string) (string, bool) {
	switch class {
	case "warrior", "mage", "rogue", "healer":
		return class, true
	case "wizard":
		return "mage", true
	default:
		return "", false
	}
}

// GearMatchesClass reports whether a gear item's klass/specialClass earns
// the class-stat bonus for an (internal) character class: Habitica's
// gear klass "wizard" matches an internal "mage".
func GearMatchesClass(klass, class string) bool {
	k, ok := NormalizeClass(klass)
	return ok && k == class
}

func ValidProfile(p Profile) bool {
	if p.ID == "" || len(p.ID) > 128 || p.Name == "" || len(p.Name) > 256 || p.Level < 1 || p.Level > MaxProfileLevel || p.MaxHP < 1 || p.MaxMP < 0 {
		return false
	}
	if p.Class != nil {
		if _, ok := NormalizeClass(*p.Class); !ok {
			return false
		}
	}
	for _, n := range []float64{p.Level, p.HP, p.MaxHP, p.MP, p.MaxMP, p.Stats.Str, p.Stats.Int, p.Stats.Con, p.Stats.Per} {
		if !finite(n) || n < 0 {
			return false
		}
	}
	if p.Exp != nil && (!finite(*p.Exp) || *p.Exp < 0) {
		return false
	}
	return true
}
func NewState() State {
	return State{Version: 1, Area: "village", Position: Position{400, 300}, Quest: "new", Quests: map[string]string{}, ReachedAt: map[string]int64{}, GateAt: map[string]int64{}, HP: 40, MaxHP: 40, Mana: 20, MaxMana: 20, Inventory: []string{"field-journal", "hearthwick-map"}, Discoveries: []string{}, DefeatedEnemies: []string{}, Flags: []string{}}
}
func XPToNextLevel(level float64) float64 {
	l := math.Max(1, math.Floor(level))
	if l < 5 {
		return 25 * l
	}
	if l == 5 {
		return 150
	}
	return math.Floor((l*l*.25+10*l+139.75)/10+.5) * 10
}

// The API admits levels through 10,000, independently of the stat bonus cap.
const MaxProfileLevel = 10000

var lifetimeTotals = func() [MaxProfileLevel + 1]float64 {
	var totals [MaxProfileLevel + 1]float64
	for l := 1; l < MaxProfileLevel; l++ {
		totals[l+1] = totals[l] + XPToNextLevel(float64(l))
	}
	return totals
}()

// A bounded startup table makes each request O(1), including invalid huge levels.
func LifetimeXP(level, exp float64) float64 {
	if !finite(level) || level > MaxProfileLevel {
		return math.NaN()
	}
	l := int(math.Max(1, math.Floor(level)))
	return lifetimeTotals[l] + math.Max(0, exp)
}

type Credit struct {
	XP     float64  `json:"xp"`
	Embers int      `json:"embers"`
	Mark   *float64 `json:"mark"`
}

func CreditXP(mark *float64, p Profile) Credit {
	c := Credit{Mark: mark}
	if p.Exp == nil {
		return c
	}
	now := LifetimeXP(p.Level, *p.Exp)
	if mark == nil {
		c.Mark = &now
		return c
	}
	if now <= *mark {
		return c
	}
	c.XP = math.Floor(now - *mark + .5)
	c.Embers = int(math.Floor(now/float64(int(E.GetXpPerEmber()))) - math.Floor(*mark/float64(int(E.GetXpPerEmber()))))
	c.Mark = &now
	return c
}
func AddUnique(a []string, b ...string) []string {
	out := append([]string{}, a...)
	seen := make(map[string]bool, len(a)+len(b))
	for _, v := range a {
		seen[v] = true
	}
	for _, v := range b {
		if !seen[v] {
			out = append(out, v)
			seen[v] = true
		}
	}
	return out
}
func Welcome(s State) (State, int) {
	if slices.Contains(s.Flags, "embers:welcome") {
		return s, 0
	}
	s.Embers += int(E.GetWelcomeEmbers())
	s.Flags = AddUnique(s.Flags, "embers:welcome")
	return s, int(E.GetWelcomeEmbers())
}

type Save struct {
	State           State    `json:"state"`
	VitalsSource    string   `json:"vitalsSource"`
	ImportedProfile *Profile `json:"importedProfile,omitempty"`
}
type SyncResult struct {
	Status string `json:"status"`
	Reason string `json:"reason,omitempty"`
	Save   Save   `json:"save"`
}

func Sync(save Save, p Profile, atSafe bool) SyncResult {
	r := SyncResult{Save: save}
	if !IsSafeArea(save.State.Area) || !atSafe {
		r.Status = "rejected"
		r.Reason = "not-at-safe-boundary"
		return r
	}
	p = SanitizeProfile(p)
	s := save.State
	if save.VitalsSource == "demo" {
		s.HP = math.Min(p.HP, p.MaxHP)
		s.MaxHP = p.MaxHP
		s.Mana = math.Min(p.MP, p.MaxMP)
		s.MaxMana = p.MaxMP
		c := CreditXP(nil, p)
		if c.Mark != nil {
			s.EmberXP = math.Max(s.EmberXP, *c.Mark)
		}
		s, _ = Welcome(s)
		r.Status = "imported"
		r.Save = Save{s, "imported", &p}
		return r
	}
	b := save.ImportedProfile
	if b != nil && b.ID != p.ID {
		r.Status = "rejected"
		r.Reason = "account-switch"
		return r
	}
	s.HP = math.Min(s.HP, p.MaxHP)
	s.Mana = math.Min(s.Mana, p.MaxMP)
	s.MaxHP = p.MaxHP
	s.MaxMana = p.MaxMP
	if b != nil {
		if p.HP > b.HP {
			s.HP = math.Min(s.HP+p.HP-b.HP, p.MaxHP)
		} else if p.HP < b.HP {
			s.HP = math.Min(s.HP, math.Min(p.MaxHP, p.HP))
		}
		if p.MP > b.MP {
			s.Mana = math.Min(s.Mana+p.MP-b.MP, p.MaxMP)
		} else if p.MP < b.MP {
			s.Mana = math.Min(s.Mana, math.Min(p.MaxMP, p.MP))
		}
	}
	var mark *float64
	if s.EmberXP > 0 {
		mark = &s.EmberXP
	} else if b != nil && b.Exp != nil {
		n := LifetimeXP(b.Level, *b.Exp)
		mark = &n
	}
	c := CreditXP(mark, p)
	if c.Mark != nil {
		s.EmberXP = math.Max(s.EmberXP, *c.Mark)
	}
	s.Embers += c.Embers
	s.XPEmbers += c.Embers
	r.Status = "synced"
	if b != nil && reflect.DeepEqual(SanitizeProfile(*b), p) && reflect.DeepEqual(s, save.State) {
		r.Status = "unchanged"
		return r
	}
	r.Save = Save{s, "imported", &p}
	return r
}

type Spend struct {
	Kind string `json:"kind"`
	ID   string `json:"id,omitempty"`
}
type Check struct {
	OK     bool   `json:"ok"`
	Cost   int    `json:"cost"`
	Reason string `json:"reason,omitempty"`
}

func CheckSpend(s State, sp Spend, imported bool) Check {
	cost := 0
	switch sp.Kind {
	case "home-rest":
		cost = int(E.GetCosts().GetHomeRest())
	case "rest":
		cost = int(E.GetCosts().GetRest())
	case "road-lantern":
		cost = int(E.GetCosts().GetRoadLantern())
	case "chest":
		cost = int(E.GetCosts().GetChest())
	default:
		return Check{Reason: "invalid-spend"}
	}
	c := Check{Cost: cost}
	switch {
	case sp.Kind == "road-lantern" && slices.Contains(s.Flags, "lit:"+sp.ID), sp.Kind == "chest" && slices.Contains(s.Flags, "opened:"+E.GetChestId()):
		c.Reason = "done"
	case (sp.Kind == "rest" || sp.Kind == "home-rest") && s.HP >= s.MaxHP && s.Mana >= s.MaxMana:
		c.Reason = "full"
	case s.Embers < cost:
		c.Reason = "short"
	case (sp.Kind == "rest" || sp.Kind == "home-rest") && imported && s.HP <= 0 && s.XPEmbers < cost:
		c.Reason = "needs-earned"
	default:
		c.OK = true
	}
	return c
}
func SpendEmbers(s State, sp Spend, imported bool) (State, error) {
	c := CheckSpend(s, sp, imported)
	if !c.OK {
		return s, errors.New(c.Reason)
	}
	earned := max(0, c.Cost-(s.Embers-s.XPEmbers))
	if (sp.Kind == "rest" || sp.Kind == "home-rest") && imported && s.HP <= 0 {
		earned = c.Cost
	}
	s.Embers -= c.Cost
	s.XPEmbers -= earned
	switch sp.Kind {
	case "rest", "home-rest":
		s.HP = s.MaxHP
		s.Mana = s.MaxMana
	case "road-lantern":
		s.Flags = AddUnique(s.Flags, "lit:"+sp.ID)
	case "chest":
		s.Flags = AddUnique(s.Flags, "opened:"+E.GetChestId())
		s.Inventory = AddUnique(s.Inventory, E.GetCharmItem())
	}
	return s, nil
}

func EconomyFlag(v string) bool {
	return v == "embers:welcome" || strings.HasPrefix(v, "lit:") || strings.HasPrefix(v, "opened:")
}

// LossReference is separate from the vitals baseline and the paid XP mark.
type LossReference struct{ Level, XP float64 }

func DeathWindow(level float64) float64 {
	return XPToNextLevel(level) + XPToNextLevel(level+1)
}
// IsRebirth(p, prior, verifiedHighLevel) reports a rebirth from the level
// history the world may trust. VerifiedHistory is what that history is:
// the level mark follows profile syncs too now (crafts.md 4.2, magic's
// mark), so a rebirth trusts no more than the level the last verified
// sign-in saw — a client-reported level is never verified history.
func VerifiedHistory(levelMark, signedInLevel float64) float64 {
	if signedInLevel >= 1 && signedInLevel < levelMark {
		return signedInLevel
	}
	return levelMark
}

func IsRebirth(p Profile, prior LossReference, verifiedHighLevel float64) bool {
	return p.Level == 1 && prior.Level > 1 && verifiedHighLevel > 1
}

// CreditReference recovers the level associated with a ledger's lifetime XP.
func CreditReference(xp float64) LossReference {
	level, exact := slices.BinarySearch(lifetimeTotals[:], xp)
	if !exact {
		level--
	}
	return LossReference{Level: float64(max(1, min(level, MaxProfileLevel))), XP: xp}
}

// Forgery uses the highest credit-bearing report, while rebirth trusts only
// the latest loss reference and previously verified level history.
func CheckpointForgery(p Profile, latest LossReference, verifiedHighLevel float64, highest LossReference, ageSeconds int64) bool {
	if IsRebirth(p, latest, verifiedHighLevel) {
		return false
	}
	days := max(int64(0), ageSeconds) / 86400
	bound := (3+float64(days))*DeathWindow(highest.Level) + E.GetCheckpointToleranceXp()
	return highest.XP-LifetimeXP(p.Level, *p.Exp) > bound
}

// XP loss is always accepted: the monotone credit mark prevents double payment.
func Plausible(p Profile) bool {
	return ValidProfile(p) && p.Exp != nil && p.Level == math.Floor(p.Level) && *p.Exp < XPToNextLevel(p.Level) && p.HP <= p.MaxHP && p.MaxHP == 50 && p.MaxMP == 2*p.Stats.Int+30
}

// DecodeProfile rejects omitted required numeric fields as well as bad values.
// Typed decoding plus slot sanitization drops credential-shaped unknown fields.
func DecodeProfile(raw json.RawMessage) (Profile, error) {
	var p Profile
	var fields map[string]json.RawMessage
	bad := errors.New("invalid-profile")
	if json.Unmarshal(raw, &fields) != nil || json.Unmarshal(raw, &p) != nil {
		return p, bad
	}
	for _, k := range []string{"level", "hp", "maxHp", "mp", "maxMp"} {
		var n *float64
		if json.Unmarshal(fields[k], &n) != nil || n == nil {
			return p, bad
		}
	}
	var stats map[string]json.RawMessage
	if json.Unmarshal(fields["stats"], &stats) != nil {
		return p, bad
	}
	for _, k := range []string{"str", "int", "con", "per"} {
		var n *float64
		if json.Unmarshal(stats[k], &n) != nil || n == nil {
			return p, bad
		}
	}
	for _, a := range [][]string{p.Pets, p.Mounts} {
		if len(a) > 2048 {
			return p, bad
		}
		for _, v := range a {
			if v == "" || len(v) > 128 {
				return p, bad
			}
		}
	}
	for _, v := range []float64{p.Appearance.HairStyle, p.Appearance.HairBangs, p.Appearance.HairMustache, p.Appearance.HairBeard, p.Appearance.HairFlower} {
		if !finite(v) {
			return p, bad
		}
	}
	// Accept Habitica's "wizard" spelling at this intake too; save the
	// normalized internal class so nothing but "mage" is ever stored.
	if p.Class != nil {
		c, ok := NormalizeClass(*p.Class)
		if !ok {
			return p, bad
		}
		p.Class = &c
	}
	if !ValidProfile(p) {
		return p, bad
	}
	return SanitizeProfile(p), nil
}
