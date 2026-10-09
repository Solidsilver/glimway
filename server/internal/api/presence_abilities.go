package api

import (
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
	"math"
	"time"
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

// presenceMagicFor: the craft and level mark allow the moves; a missing
// profile (no Habitica hero) has no craft and casts nothing.
func presenceMagicFor(p *rules.Profile, classMark string, levelMark float64) presenceMagic {
	if p == nil {
		return presenceMagic{}
	}
	m := presenceMagic{Class: rules.Craft(p, classMark, levelMark), LevelMark: levelMark}
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
	// amount is one pulse; full is the whole ward it came from.
	amount, full float64
	at           time.Time
}

// wardCredit: the pulses other healers' ward-lights left on an account
// (4.5). It lives in memory for a minute, so a restart loses what is
// unspent — at most one ward's heal, because the credit never grows past
// the fullest single ward behind it.
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

// use is the credit one report may raise HP by (4.5): everything still
// live, no more than one ward's heal. It is used up either way.
func (c *wardCredit) use(now time.Time) float64 {
	c.prune(now)
	sum, full := 0.0, 0.0
	for _, g := range c.grants {
		sum += g.amount
		full = math.Max(full, g.full)
	}
	return math.Min(sum, full)
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

// takeWardCredit: the ward credit an accepted report may raise HP by, gone
// once taken (crafts.md 4.5).
func (h *presenceHub) takeWardCredit(id string) float64 {
	if h == nil {
		return 0
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	c := h.ward[id]
	if c == nil {
		return 0
	}
	now := time.Now()
	used := c.use(now)
	delete(h.ward, id)
	return used
}

// takeWardCredit: the report's view of it (no hub: no credit).
func (a *Server) takeWardCredit(id string) float64 {
	if a.presence == nil {
		return 0
	}
	return a.presence.takeWardCredit(id)
}

// allowAbility is the hub's PresenceAbility check (4.5): the move is in the
// table, the sender's craft and level mark allow it, and its own cooldown
// (kept in memory) has passed. Anything else is dropped, like an emote over
// its cooldown. Signatures go the same way, so friends see a Fingersnap.
// Callers hold h.mu.
func (h *presenceHub) allowAbility(p *presencePeer, now time.Time, event *contract.PresenceAbility) bool {
	a, ok := content.AbilityFor(event.GetAbility())
	if !ok || !finitePresence(event.GetX()) || !finitePresence(event.GetY()) || math.Abs(event.GetX()) > 1e6 || math.Abs(event.GetY()) > 1e6 {
		return false
	}
	m := p.identity.Magic
	if !rules.Unlocked(m.Class, m.LevelMark, a) {
		return false
	}
	last := h.abilityReady[p.identity.ID][a.GetId()]
	if !last.IsZero() && now.Sub(last) < time.Duration(a.GetCooldownSeconds()*float64(time.Second)) {
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
	pulse := p.identity.Magic.Heal * n.GetPulseHealFraction()
	if pulse <= 0 {
		return
	}
	grant := wardGrant{amount: pulse, full: pulse * float64(n.GetPulses())}
	world, area, caster := p.identity.World, p.area, p.identity.ID
	cx, cy := event.GetX(), event.GetY()
	radius := n.GetRadiusTiles() * wildsTileSize
	for i, offset := range wardPulseOffsets {
		if i >= int(n.GetPulses()) {
			break
		}
		time.AfterFunc(offset, func() { h.wardPulse(world, area, caster, cx, cy, radius, grant) })
	}
}

// wardPulse: one pulse of one ward (4.5). Idle players count: the hub keeps
// the last position each socket sent until they move or leave.
func (h *presenceHub) wardPulse(world, area, caster string, cx, cy, radius float64, grant wardGrant) {
	h.mu.Lock()
	defer h.mu.Unlock()
	grant.at = time.Now()
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
