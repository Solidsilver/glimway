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

// wardPulseOffsets is when a ward's pulses land (4.3 and 4.5): the same
// rule the screen runs (`wardPulseTimes` in src/lib/combat-moves.ts) — the
// first a second in, the last a second before the ward fades, evenly
// between. The table's Ward-light (5 s, 3 pulses) gets 1, 2.5 and 4 s.
// Derived from content (review finding 15), so the two sides cannot drift
// and a fourth pulse is scheduled, not silently dropped.
func wardPulseOffsets(a *content.Ability) []time.Duration {
	n := a.GetNumbers()
	pulses := int(n.GetPulses())
	if pulses <= 0 {
		return nil
	}
	at := func(s float64) time.Duration { return time.Duration(math.Round(s*1000)) * time.Millisecond }
	if pulses == 1 {
		return []time.Duration{at(min(1, n.GetDurationSeconds()))}
	}
	first := min(1, n.GetDurationSeconds()/2)
	last := max(first, n.GetDurationSeconds()-1)
	step := (last - first) / float64(pulses-1)
	out := make([]time.Duration, 0, pulses)
	for i := 0; i < pulses; i++ {
		out = append(out, at(first+step*float64(i)))
	}
	return out
}

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

// wardReservation is the credit one open report holds out of the pool
// (review finding 11), keyed by the report's sequence: the same report
// reserving twice gets its own credit back, and no other report can see it
// while the first is open.
type wardReservation struct {
	seq    float64
	credit *wardCredit
}

// reserveWardCredit takes every pulse still waiting for this account out of
// the pool, under h.mu (review finding 11), and holds it for one report. Two
// reports in the same ward window can then never spend the same pulse: the
// first reserves it, the second sees none. What the report's HP did not need
// goes back in settleWardCredit, with each pulse's own expiry untouched.
func (h *presenceHub) reserveWardCredit(id string, seq float64) float64 {
	if h == nil {
		return 0
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if r := h.wardReserved[id]; r != nil && r.seq == seq {
		return r.credit.use(h.now())
	}
	c := h.ward[id]
	if c == nil {
		return 0
	}
	delete(h.ward, id)
	c.prune(h.now())
	if len(c.grants) == 0 {
		return 0
	}
	h.wardReserved[id] = &wardReservation{seq: seq, credit: c}
	return c.use(h.now())
}

// settleWardCredit is where a landed report spends what its HP took (the
// rest waits for the next report or its expiry) — or, when the report never
// landed, where the whole reservation goes back to the pool.
func (h *presenceHub) settleWardCredit(id string, seq, used float64) {
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	r := h.wardReserved[id]
	if r == nil || r.seq != seq {
		return
	}
	delete(h.wardReserved, id)
	now := h.now()
	r.credit.spend(now, used)
	for _, g := range r.credit.grants {
		h.addWardCredit(id, g)
	}
}

// reserveWardCredit and settleWardCredit are the report's view of the credit
// (no hub: no credit).
func (a *Server) reserveWardCredit(id string, seq float64) float64 {
	return a.presence.reserveWardCredit(id, seq)
}

func (a *Server) settleWardCredit(id string, seq, used float64) {
	a.presence.settleWardCredit(id, seq, used)
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

// presenceCastSlack: how far a cast may stand past its reach from the last
// stored position (review finding 3). A moving or riding caster's stored
// position lags the cast: the client sends one at most every 150 ms and
// flushes none just before `ability`, and the hub drops positions closer
// together than its own throttle. At the fastest movement on screen (riding,
// 155 px/s) one gap plus transport jitter is about 55 px — the slack below.
// It stays inside the trust model: the effect is still only near the caster.
const presenceCastSlack = 155.0 * (0.150 + 0.200)

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
	// a cast further than its reach, a tile of slack and the moving-caster
	// slack above from their last known position goes (review finding 10).
	// Before the first position there is nothing to measure from, and a cast
	// may not skip the check: it is dropped until a position arrives (review
	// finding 16).
	if p.pos == nil {
		return false
	}
	reach := (a.GetNumbers().GetReachTiles()+1)*wildsTileSize + presenceCastSlack
	dx, dy := event.GetX()-p.pos.X, event.GetY()-p.pos.Y
	if dx*dx+dy*dy > reach*reach {
		return false
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
	for _, offset := range wardPulseOffsets(a) {
		// The hub's timer, injected: tests fire the pulses by hand (review
		// finding 12), so no ward test waits in real time.
		h.afterFunc(offset, func() { h.wardPulse(world, area, caster, cx, cy, radius, pulse) })
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
// there is dropped. Callers hold h.mu (the caster's magic refreshes under it).
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
