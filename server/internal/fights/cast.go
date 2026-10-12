package fights

import (
	"glimway/content"
	wire "glimway/server/internal/gen/glimway/v2"
	"math"
	"time"
)

// Cast is an allowed ability (the hub's allowAbility already charged its
// cooldown and mana): the sim only applies its effect. X and Y are the
// PresenceAbility's spot, the caster's feet (Kindle: its patch). Crit is the
// seeded roll the hub made for the counter; Damage the kit's signature.
type Cast struct {
	Player  string
	Ability string
	X, Y    float64
	Fight   *wire.FightCast
	Crit    bool
	Damage  float64
	ID      uint64
	// Dash is Shadowstep's travel from the feet (X, Y), worked out once by
	// the hub over the caster's 3x3 (Ground.Dash), so every room strikes at
	// the same end. Nil: this room's own chunk decides (direct sim use).
	Dash *Dash
	// Flight is a Fingersnap bolt's one impact across rooms (Attack.Flight).
	Flight *Flight
}
type Dash struct{ X, Y float64 }

// Strike is a signature's circle (fight-rules.ts Strike): its centre and
// reach, judged to an enemy's middle, the boundary open. The numbers are
// content (combat.json signatures), shared with the client and pinned by
// the signature vectors (content/vectors/fights.json).
type Strike struct{ X, Y, Reach float64 }

// Reaches is fight-rules.ts strikeReaches for a signature.
func (s Strike) Reaches(enemyX, enemyY float64) bool {
	dx, dy := enemyX-s.X, enemyY-content.CombatRules.GetAttack().GetEnemyYOffset()-s.Y
	return float64(dx*dx)+float64(dy*dy) < s.Reach*s.Reach
}

// CleaveStrike is a wide arc ahead along the unit facing.
func CleaveStrike(x, y, fx, fy float64) Strike {
	b := content.CombatRules.GetSignatures().GetCleave()
	return Strike{X: x + float64(fx*b.GetAheadX()), Y: y - b.GetUp() + float64(fy*b.GetAheadY()), Reach: b.GetReach()}
}

// MendStrike is the damaging pulse around the caster.
func MendStrike(x, y float64) Strike {
	b := content.CombatRules.GetSignatures().GetMend()
	return Strike{X: x, Y: y - b.GetUp(), Reach: b.GetReach()}
}

// Snapstrike is Shadowstep's strike where the dash ended: wider after a
// dash that carried the hero, close after one a wall stopped.
func Snapstrike(x, y float64, travelled bool) Strike {
	s := content.CombatRules.GetSignatures().GetShadowstep()
	reach := s.GetStillReach()
	if travelled {
		reach = s.GetReach()
	}
	return Strike{X: x, Y: y - s.GetUp(), Reach: reach}
}

// DashTravelled is combat.ts snapstrikeReach's test: the dash moved the
// hero more than `travelled` px, in two dimensions.
func DashTravelled(dx, dy float64) bool {
	return math.Hypot(dx, dy) > content.CombatRules.GetSignatures().GetShadowstep().GetTravelled()
}

// Cast applies one ability in this room. It returns the rows it decided
// now, or pending: a Fingersnap bolt answers later as a BoltResult with ID.
// Moves that only change the field (Kindle, Stand, Echo) and Ward-light,
// which has no effect on enemies, return no rows.
func (r *Room) Cast(c Cast, now time.Time) ([]*wire.FightHitRow, bool) {
	p := r.players[c.Player]
	if p == nil || p.Down || c.Fight == nil || c.Fight.Facing == nil {
		return nil, false
	}
	ms := now.UnixMilli()
	fx, fy := c.Fight.Facing.X, c.Fight.Facing.Y
	a, _ := content.AbilityFor(c.Ability)
	n := a.GetNumbers()
	sig := content.CombatRules.GetSignatures()
	if c.Ability != "kindle" {
		// The caster's feet share the movement budget, as a swing's origin does.
		p = r.attackPosition(p, c.X, c.Y, now)
	}
	seen := RewindAt(now, c.Fight.SeenTick, c.Fight.SeenOffsetMs)
	switch c.Ability {
	case "cleave":
		s := CleaveStrike(p.X, p.Y, fx, fy)
		return r.strike(c, s, false, p.X, p.Y, min(ms, seen+wholeMs(sig.GetCleave().GetLandSeconds())), ms), false
	case "shadowstep":
		d := c.Dash
		if d == nil {
			ex, ey := NewGround(r.Geometry).Dash(p.X, p.Y, fx, fy)
			d = &Dash{X: ex - p.X, Y: ey - p.Y}
		}
		ex, ey := p.X+d.X, p.Y+d.Y
		t := sig.GetShadowstep()
		land := wholeMs(t.GetDashSeconds()) + wholeMs(t.GetLandSeconds())
		return r.strike(c, Snapstrike(ex, ey, DashTravelled(d.X, d.Y)), c.Crit, ex-float64(fx*t.GetKnockBack()), ey, min(ms, seen+land), ms), false
	case "mend":
		s := MendStrike(p.X, p.Y)
		return r.strike(c, s, false, p.X, p.Y, min(ms, seen+wholeMs(sig.GetMend().GetLandSeconds())), ms), false
	case "fingersnap":
		r.launch(c.ID, c.Flight, p.X, p.Y, fx, fy, c.Damage, false, false, ms)
		return nil, true
	case "kindle":
		r.patches = append(r.patches, patch{x: c.X, y: c.Y, r: n.GetRadiusTiles() * TilePixels, slow: n.GetSlow(), until: ms + wholeMs(n.GetDurationSeconds())})
	case "stand":
		r.plants[c.Player] = plant{until: ms + wholeMs(n.GetDurationSeconds()), stagger: n.GetStaggerSeconds()}
	case "echo":
		r.decoys[c.Player] = decoy{x: p.X, y: p.Y, until: ms + wholeMs(n.GetDurationSeconds())}
	}
	return []*wire.FightHitRow{}, false
}

// strike judges a signature's circle at the instant it lands on the
// caster's screen, rewound and capped like a swing.
func (r *Room) strike(c Cast, s Strike, crit bool, fromX, fromY float64, at, ms int64) []*wire.FightHitRow {
	return r.judge(c.Fight.Predicted, at, ms, s.Reaches, func(e *enemy) *wire.FightHitRow {
		return r.hit(e, c.Damage, crit, false, fromX, fromY, ms)
	})
}

// BoltRadius bounds a bolt's whole flight from the caster's feet.
func BoltRadius() float64 {
	t := content.CombatRules.GetAttack()
	return float64(t.GetBoltSpeed()*t.GetBoltLifetimeSeconds()) + t.GetBoltRadius() + t.GetBoltSpawnOffsetX()
}

// CastRadius is how far from its spot a cast's effect can reach an enemy's
// feet, for choosing the rooms it goes to. Negative: every room the caster
// is in (Stand and Echo change how that room's enemies treat the caster).
// Zero: no room (Ward-light has no effect on enemies).
func CastRadius(ability string) float64 {
	middle := content.CombatRules.GetAttack().GetEnemyYOffset()
	sig := content.CombatRules.GetSignatures()
	switch ability {
	case "cleave":
		b := sig.GetCleave()
		return math.Hypot(b.GetAheadX(), b.GetAheadY()) + b.GetUp() + b.GetReach() + middle
	case "shadowstep":
		b := sig.GetShadowstep()
		return b.GetDashSpeed()*b.GetDashSeconds() + b.GetUp() + b.GetReach() + middle
	case "mend":
		b := sig.GetMend()
		return b.GetUp() + b.GetReach() + middle
	case "fingersnap":
		return BoltRadius()
	case "kindle":
		a, _ := content.AbilityFor(ability)
		return a.GetNumbers().GetRadiusTiles() * TilePixels
	case "stand", "echo":
		return -1
	}
	return 0
}
