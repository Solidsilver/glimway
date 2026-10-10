package api

import (
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
	"math"
	"time"

	"google.golang.org/protobuf/proto"
)

// The hub's side of the moves (docs/design/crafts.md 4.5): what a cast must
// show before it is relayed to the room, and the ward credit Ward-light
// leaves behind for the players standing in its circle.

// presenceMagic is the account's state a cast is checked against (4.5),
// read from the account's state at auth and refreshed on the hub's
// revalidation (revalidateMs). Heal is the caster's own Mend amount (the
// server's formula from their stats), 0 for every other craft.
type presenceMagic struct {
	Class     string
	LevelMark float64
	Heal      float64
}

// presenceMagicFor: the craft and the level mark allow the moves (the mark
// reads max(mark, profile level), lane F's `levelMarkOf`); a missing profile
// (no Habitica hero) has no craft and casts nothing.
func presenceMagicFor(p *rules.Profile, classMark string, levelMark float64) presenceMagic {
	if p == nil {
		return presenceMagic{}
	}
	mark := rules.LevelMark(p, levelMark)
	m := presenceMagic{Class: rules.Craft(p, classMark, mark), LevelMark: mark}
	if m.Class == "healer" {
		m.Heal = rules.MendHeal(p)
	}
	return m
}

// wardPulseOffsets: when a ward-light's pulses land (4.3 and 4.5: at 1, 2.5
// and 4 s). The table's `pulses` counts them; a test pins the two together.
var wardPulseOffsets = []time.Duration{time.Second, 2500 * time.Millisecond, 4 * time.Second}

// wardCreditSeconds: how long a pulse waits for its report (4.5).
const wardCreditSeconds = 60

// wardGrant is one pulse of one ward's heal on one account.
type wardGrant struct {
	amount float64
	at     time.Time
}

// wardCredit: the pulses other healers' ward-lights left on an account
// (4.5). Each pulse waits a minute for a report, so a restart loses whatever
// pulses are unspent — with lane F's 10 s reports that is about one ward's
// heal (review finding 2). A report spends only what its HP needed; the
// rest waits for the next report or its expiry (review finding 3).
type wardCredit struct {
	grants []wardGrant
}

func (c *wardCredit) prune(now time.Time) {
	live := c.grants[:0]
	for _, g := range c.grants {
		if now.Sub(g.at) < wardCreditSeconds*time.Second {
			live = append(live, g)
		}
	}
	c.grants = live
}

// use is the credit one report may raise HP by: every pulse still waiting.
func (c *wardCredit) use(now time.Time) float64 {
	c.prune(now)
	sum := 0.0
	for _, g := range c.grants {
		sum += g.amount
	}
	return sum
}

// spend takes what a landed report used up, oldest pulses first.
func (c *wardCredit) spend(now time.Time, used float64) {
	c.prune(now)
	for len(c.grants) > 0 && used > 0 {
		take := math.Min(used, c.grants[0].amount)
		c.grants[0].amount -= take
		used -= take
		// A rounding sliver is spent, not left to the next report.
		if c.grants[0].amount <= 1e-9 {
			c.grants = c.grants[1:]
		}
	}
}

// addWardCredit: one pulse on an account. Callers hold h.mu.
func (h *presenceHub) addWardCredit(id string, grant wardGrant) {
	c := h.ward[id]
	if c == nil {
		c = &wardCredit{}
		h.ward[id] = c
	}
	c.prune(grant.at)
	c.grants = append(c.grants, grant)
}

// wardCreditFor: what an accepted report may raise HP by right now. It only
// peeks: what the HP needed is spent when the report lands (review findings
// 3 and 13).
func (h *presenceHub) wardCreditFor(id string) float64 {
	if h == nil {
		return 0
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	c := h.ward[id]
	if c == nil {
		return 0
	}
	credit := c.use(h.now())
	if len(c.grants) == 0 {
		delete(h.ward, id)
	}
	return credit
}

// spendWardCredit: the part a landed report used; the rest waits.
func (h *presenceHub) spendWardCredit(id string, used float64) {
	if h == nil || used <= 0 {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	c := h.ward[id]
	if c == nil {
		return
	}
	c.spend(h.now(), used)
	if len(c.grants) == 0 {
		delete(h.ward, id)
	}
}

// wardCredit and spendWardCredit are the report's view of it (no hub: no
// credit).
func (a *Server) wardCredit(id string) float64 {
	if a.presence == nil {
		return 0
	}
	return a.presence.wardCreditFor(id)
}

func (a *Server) spendWardCredit(id string, used float64) {
	if a.presence == nil {
		return
	}
	a.presence.spendWardCredit(id, used)
}

// cooldownTolerance: the client sends on its own clock while the hub
// measures arrivals, so a cast counts as on time at cooldown − tolerance
// (review finding 5): 150 ms or a tenth of the cooldown, capped at 250 ms.
func cooldownTolerance(cooldown time.Duration) time.Duration {
	t := cooldown / 10
	if t < 150*time.Millisecond {
		t = 150 * time.Millisecond
	}
	if t > 250*time.Millisecond {
		t = 250 * time.Millisecond
	}
	return t
}

// allowAbility is the hub's PresenceAbility check (4.5): the move is in the
// table, the sender's craft and level mark allow it, it is cast where the
// sender stands, and its own cooldown (kept in memory) has passed. Anything
// else is dropped, like an emote over its cooldown. Signatures go the same
// way, so friends see a Fingersnap. Callers hold h.mu.
func (h *presenceHub) allowAbility(p *presencePeer, now time.Time, event *contract.PresenceAbility) bool {
	if p.area == "" {
		return false
	}
	a, ok := content.AbilityFor(event.GetAbility())
	if !ok || !finitePresence(event.GetX()) || !finitePresence(event.GetY()) || math.Abs(event.GetX()) > 1e6 || math.Abs(event.GetY()) > 1e6 {
		return false
	}
	m := p.identity.Magic
	if !rules.Unlocked(m.Class, m.LevelMark, a) {
		return false
	}
	// 4.5 puts the effect at the caster's feet (Kindle, two tiles ahead):
	// a cast further than its reach, with a tile of slack, from their last
	// known position goes (review finding 10).
	if p.pos != nil {
		reach := (a.GetNumbers().GetReachTiles() + 1) * wildsTileSize
		dx, dy := event.GetX()-p.pos.X, event.GetY()-p.pos.Y
		if dx*dx+dy*dy > reach*reach {
			return false
		}
	}
	cooldown := time.Duration(a.GetCooldownSeconds() * float64(time.Second))
	last := h.abilityReady[p.identity.ID][a.GetId()]
	if !last.IsZero() && now.Sub(last) < cooldown-cooldownTolerance(cooldown) {
		return false
	}
	if h.abilityReady[p.identity.ID] == nil {
		h.abilityReady[p.identity.ID] = map[string]time.Time{}
	}
	h.abilityReady[p.identity.ID][a.GetId()] = now
	return true
}

// scheduleWard: a ward-light leaves its pulse checks behind (4.5). Each one
// credits every room member whose last known position is inside the circle
// the caster's feet centre, other than the caster — whose own heal comes
// with their report. The circle never moves, so the room it was cast in is
// the room it keeps healing.
func (h *presenceHub) scheduleWard(p *presencePeer, event *contract.PresenceAbility) {
	a, ok := content.AbilityFor(event.GetAbility())
	if !ok {
		return
	}
	n := a.GetNumbers()
	if n == nil || n.GetPulses() <= 0 || n.GetPulseHealFraction() <= 0 {
		return
	}
	pulse := wardPulseOf(p.identity.Magic, a)
	if pulse <= 0 {
		return
	}
	world, area, caster := p.identity.World, p.area, p.identity.ID
	cx, cy := event.GetX(), event.GetY()
	radius := n.GetRadiusTiles() * wildsTileSize
	for i, offset := range wardPulseOffsets {
		if i >= int(n.GetPulses()) {
			break
		}
		time.AfterFunc(offset, func() { h.wardPulse(world, area, caster, cx, cy, radius, pulse) })
	}
}

// wardPulseOf: one pulse of a ward the caster casts, rules.WardPulseHeal
// from their profile (presenceMagic keeps the Mend); 0 for any other move or
// craft. The relay and the credit both read it, so a friend's screen mends
// what the world credits (review finding 11).
func wardPulseOf(m presenceMagic, a *content.Ability) float64 {
	return m.Heal * a.GetNumbers().GetPulseHealFraction()
}

// relayedAbility is the cast the room hears (4.5): the sender's account_id
// and, for a Ward-light, the hub's own pulse_heal; whatever the client put
// there goes. Callers hold h.mu (the caster's magic refreshes under it).
func relayedAbility(p *presencePeer, event *contract.PresenceAbility) ([]byte, error) {
	out := proto.Clone(event).(*contract.PresenceAbility)
	out.AccountId = proto.String(p.identity.ID)
	out.PulseHeal = nil
	if a, ok := content.AbilityFor(event.GetAbility()); ok {
		if pulse := wardPulseOf(p.identity.Magic, a); pulse > 0 {
			out.PulseHeal = proto.Float64(pulse)
		}
	}
	return encodePresence(out)
}

// wardPulse: one pulse of one ward (4.5). Idle players count: the hub keeps
// the last position each socket sent until they move or leave.
func (h *presenceHub) wardPulse(world, area, caster string, cx, cy, radius, pulse float64) {
	h.mu.Lock()
	defer h.mu.Unlock()
	grant := wardGrant{amount: pulse, at: h.now()}
	for _, q := range h.peers {
		if q.identity.ID == caster || q.detached || q.identity.World != world || q.area != area || q.pos == nil {
			continue
		}
		dx, dy := q.pos.X-cx, q.pos.Y-cy
		if dx*dx+dy*dy <= radius*radius {
			h.addWardCredit(q.identity.ID, grant)
		}
	}
}

// maxAbilityCooldown: the longest cooldown in the table. Older cooldown
// memory can no longer bound a cast.
func maxAbilityCooldown() time.Duration {
	var longest time.Duration
	for _, a := range content.AbilitiesRules.GetAbilities() {
		if d := time.Duration(a.GetCooldownSeconds() * float64(time.Second)); d > longest {
			longest = d
		}
	}
	return longest
}

// pruneAbilityReady keeps the cooldown map bounded without resetting it
// (review finding 4): an account's entry goes only when every timestamp in
// it is older than the table's longest cooldown.
func (h *presenceHub) pruneAbilityReady(now time.Time) {
	older := maxAbilityCooldown()
	for id, per := range h.abilityReady {
		stale := true
		for _, at := range per {
			if now.Sub(at) < older {
				stale = false
				break
			}
		}
		if stale {
			delete(h.abilityReady, id)
		}
	}
}
