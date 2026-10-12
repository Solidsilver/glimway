package fights

import (
	"fmt"
	"glimway/content"
	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
	"math"
	"math/rand/v2"
	"sort"
	"time"

	"google.golang.org/protobuf/proto"
)

const SleepAfter = 30 * time.Second
const HistoryMillis = 1000
const RewindMillis = 250

// Mounted rolls reach 288 px/s. Forty pixels per tick includes that speed
// and 11.2 px of slack. Multiple reports in one tick share this budget.
const MovementPerTick = 40.0
const CampLeash = 160.0

type Key struct {
	World, Realm, Epoch string
	Layer, CX, CY       int32
}

func (k Key) Wire() *wire.FightRoomKey {
	return &wire.FightRoomKey{World: k.World, Realm: k.Realm, Epoch: k.Epoch, Layer: k.Layer, Cx: k.CX, Cy: k.CY}
}

type Camp struct {
	ID     string
	Cycle  int64
	X, Y   float64
	Count  int
	Fallen bool
}
type Player struct {
	ID       string // account id, used by target events and fall witnesses
	Observer string // socket lifetime, used only for delivery
	Seed     uint32
	X, Y     float64
	Down     bool
	Kit      rules.CombatKit
	capTick  uint32
	budget   float64
}
type sample struct {
	ms   int64
	x, y float64
}
type enemy struct {
	row                wire.FightEnemy
	x, y, homeX, homeY float64
	target             string
	dirX, dirY         float64
	aimLocked          bool
	readyAt            int64
	knockX, knockY     float64
	knockLeft          float64
	history            []sample
}
type Attack struct {
	Player string
	Swing  *wire.FightSwing
	Crit   bool
	Damage float64
	ID     uint64
}
type bolt struct {
	attack     Attack
	x, y       float64
	started    int64
	advancedAt int64
}
type BoltResult struct {
	ID   uint64
	Hits []*wire.FightHitRow
}

// Fall is an output seam for F-F's single writer; the prototype keeps it in
// memory and leaves claims on their existing path.
type Fall struct {
	Key       Key
	Camp      string
	Cycle     int64
	At        int64
	Witnesses []string
}
type Frame struct {
	Events []*wire.FightEvent
	Delta  *wire.FightDelta
	Bolts  []BoltResult
	Falls  []Fall
	Closed bool
}
type Room struct {
	Key         Key
	Handle      uint32
	Geometry    Geometry
	players     map[string]*Player
	enemies     []*enemy
	camps       []Camp
	witnesses   map[string]bool
	started     bool
	fallen      bool
	rng         *rand.Rand
	lastTick    uint32
	lastMS      int64
	uncoveredAt int64
	published   []*wire.FightEnemy
	bolts       []bolt
	events      []*wire.FightEvent
	falls       []Fall
	EndsAt      int64 // Unix ms; 0 means no turning
}

// NewRoom consumes only already-loaded values. Its seed includes the wake
// number, so a replay can supply exactly the same wake and input log.
func NewRoom(key Key, handle uint32, geometry Geometry, camps []Camp, seed uint64, now time.Time, endsAt int64) *Room {
	tick, _ := rules.FightTickAt(now.UnixMilli())
	r := &Room{Key: key, Handle: handle, Geometry: geometry, camps: append([]Camp(nil), camps...), players: map[string]*Player{}, witnesses: map[string]bool{}, rng: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15)), lastTick: tick, lastMS: now.UnixMilli(), uncoveredAt: now.UnixMilli(), EndsAt: endsAt}
	offsets := [][2]float64{{0, 0}, {16, 0}, {0, 16}}
	for _, camp := range camps {
		if camp.Fallen {
			continue
		}
		for i := 0; i < min(camp.Count, 3); i++ {
			x, y := camp.X+offsets[i][0], camp.Y+offsets[i][1]
			// A generated anchor is open, but an offset may straddle solid tiles.
			if !geometry.CanStand(x, y, EnemyRadius) {
				x, y = r.openHome(camp.X, camp.Y)
			}
			e := &enemy{x: x, y: y, homeX: x, homeY: y, readyAt: now.UnixMilli() + int64(400+float64(r.rng.Float64()*600))}
			e.row = wire.FightEnemy{Enemy: uint32(len(r.enemies)), Id: fmt.Sprintf("wilds:%s:%d", camp.ID, i), Kind: wire.FightEnemyKind_FIGHT_ENEMY_KIND_WISP, CampId: camp.ID, MaxHp: content.EnemyRules.GetWisp().GetHp(), Hp: content.EnemyRules.GetWisp().GetHp(), State: wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE, StateTick: tick}
			e.history = []sample{{now.UnixMilli(), x, y}}
			r.enemies = append(r.enemies, e)
		}
	}
	r.published = r.rows()
	return r
}
func (r *Room) openHome(x, y float64) (float64, float64) {
	for radius := 0; radius < r.Geometry.Size; radius++ {
		for dy := -radius; dy <= radius; dy++ {
			for dx := -radius; dx <= radius; dx++ {
				nx, ny := x+float64(dx*TilePixels), y+float64(dy*TilePixels)
				if r.Geometry.CanStand(nx, ny, EnemyRadius) {
					return nx, ny
				}
			}
		}
	}
	return x, y
}
func (r *Room) rows() []*wire.FightEnemy {
	rows := make([]*wire.FightEnemy, 0, len(r.enemies))
	for _, e := range r.enemies {
		row := proto.Clone(&e.row).(*wire.FightEnemy)
		row.X, row.Y = int32(math.Floor(e.x+0.5)), int32(math.Floor(e.y+0.5))
		rows = append(rows, row)
	}
	return rows
}
func (r *Room) Join(seed uint32) *wire.FightJoin {
	return &wire.FightJoin{RoomKey: r.Key.Wire(), Room: r.Handle, Tick: r.lastTick, Enemies: r.rows(), CritSeed: seed}
}
func (r *Room) Cover(p Player, now time.Time) bool {
	previous := r.players[p.Observer]
	fresh := previous == nil
	tick, _ := rules.FightTickAt(now.UnixMilli())
	if fresh {
		p.capTick = tick
		p.budget = MovementPerTick
	} else {
		elapsed := rules.FightTickDiff(tick, previous.capTick)
		budget := previous.budget
		if elapsed > 0 {
			budget = MovementPerTick * float64(min(elapsed, 5))
		}
		x, y, spent := capPosition(previous.X, previous.Y, p.X, p.Y, budget)
		p.X, p.Y, p.budget = x, y, math.Max(0, budget-spent)
		p.capTick = tick
	}
	r.players[p.Observer] = &p
	r.uncoveredAt = 0
	if r.started {
		r.witnesses[p.ID] = true
	}
	return fresh
}
func capPosition(x, y, nx, ny, budget float64) (float64, float64, float64) {
	dx, dy := nx-x, ny-y
	dist := math.Hypot(dx, dy)
	if dist <= budget {
		return nx, ny, dist
	}
	if dist == 0 {
		return x, y, 0
	}
	return x + float64(dx*(budget/dist)), y + float64(dy*(budget/dist)), budget
}
func (r *Room) Leave(observer string, now time.Time) {
	delete(r.players, observer)
	if len(r.players) == 0 && r.uncoveredAt == 0 {
		r.uncoveredAt = now.UnixMilli()
	}
}
func (r *Room) ShouldClose(now time.Time) bool {
	ms := now.UnixMilli()
	return r.EndsAt > 0 && ms >= r.EndsAt || len(r.players) == 0 && ms-r.uncoveredAt >= SleepAfter.Milliseconds()
}
func (r *Room) event(e *enemy, kind wire.FightEventKind, ms int64) {
	tick, offset := rules.FightTickAt(ms)
	v := &wire.FightEvent{Room: r.Handle, Tick: tick, OffsetMs: offset, Kind: kind}
	if e != nil {
		v.Enemy = proto.Uint32(e.row.Enemy)
		if e.target != "" {
			if p := r.players[e.target]; p != nil {
				v.Target = proto.String(p.ID)
			}
		}
	}
	r.events = append(r.events, v)
}
func (r *Room) state(e *enemy, state wire.FightEnemyState, ms int64) {
	e.row.State = state
	e.row.StateTick, _ = rules.FightTickAt(ms)
}
func (r *Room) playerLeashed(e *enemy, p *Player) bool {
	return p != nil && !p.Down && math.Hypot(p.X-e.homeX, p.Y-e.homeY) < CampLeash
}
func (r *Room) target(e *enemy) *Player {
	if p := r.players[e.target]; r.playerLeashed(e, p) {
		return p
	}
	e.target = ""
	var closest *Player
	distance := content.EnemyRules.GetWisp().GetAggro()
	// Stable iteration makes equal-distance targets and replays deterministic.
	ids := make([]string, 0, len(r.players))
	for id := range r.players {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		p := r.players[id]
		d := math.Hypot(p.X-e.x, p.Y-e.y)
		if r.playerLeashed(e, p) && d < distance {
			closest = p
			distance = d
			e.target = id
		}
	}
	return closest
}
func direction(dx, dy float64) (float64, float64) {
	d := math.Hypot(dx, dy)
	if d == 0 {
		return 1, 0
	}
	return dx / d, dy / d
}
func (r *Room) startFight() {
	if !r.started {
		r.started = true
		for _, p := range r.players {
			r.witnesses[p.ID] = true
		}
	}
}
func (r *Room) stepWisp(e *enemy, ms int64) {
	if e.row.Hp <= 0 {
		return
	}
	t := content.EnemyRules.GetWisp()
	if e.knockLeft > 0 {
		dt := math.Min(.1, e.knockLeft)
		e.x, e.y = r.Geometry.Move(e.x, e.y, e.knockX*dt, e.knockY*dt)
		e.knockLeft = math.Max(0, e.knockLeft-.1)
		return
	}
	p := r.target(e)
	if p == nil {
		if e.row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE {
			r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE, ms)
		}
		d := math.Hypot(e.homeX-e.x, e.homeY-e.y)
		if d > 0.1 {
			dx, dy := direction(e.homeX-e.x, e.homeY-e.y)
			step := math.Min(d, t.GetChase()*.1)
			e.x, e.y = r.Geometry.Move(e.x, e.y, dx*step, dy*step)
			e.row.Facing = rules.FightFacingStep(dx, dy)
		}
		return
	}
	r.startFight()
	dx, dy := direction(p.X-e.x, p.Y-e.y)
	dist := math.Hypot(p.X-e.x, p.Y-e.y)
	switch e.row.State {
	case wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE:
		e.row.Facing = rules.FightFacingStep(dx, dy)
		if dist < t.GetHopRange() && ms >= e.readyAt {
			r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_TELEGRAPH, ms)
			e.aimLocked = false
			r.event(e, wire.FightEventKind_FIGHT_EVENT_KIND_WINDUP_START, ms)
		} else if dist > t.GetHopRange()*.7 {
			e.x, e.y = r.Geometry.Move(e.x, e.y, dx*t.GetChase()*.1, dy*t.GetChase()*.1)
		}
	case wire.FightEnemyState_FIGHT_ENEMY_STATE_TELEGRAPH:
		tick, _ := rules.FightTickAt(ms)
		elapsed := rules.FightTickDiff(tick, e.row.StateTick)
		if !e.aimLocked {
			e.row.Facing = rules.FightFacingStep(dx, dy)
			if rules.FightAimLocked("wisp", elapsed) {
				e.aimLocked = true
				e.dirX, e.dirY = dx, dy
				lock, _, _ := rules.FightWindupTicks("wisp")
				r.event(e, wire.FightEventKind_FIGHT_EVENT_KIND_AIM_LOCK, ms-int64(elapsed-int32(lock))*100)
			}
		}
		if rules.FightLaunched("wisp", elapsed) {
			r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE, ms)
		}
	case wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE:
		tick, _ := rules.FightTickAt(ms)
		elapsed := float64(float64(rules.FightTickDiff(tick, e.row.StateTick)) * .1)
		dt := math.Max(0, math.Min(.1, t.GetHopTime()-(elapsed-.1)))
		e.x, e.y = r.Geometry.Move(e.x, e.y, e.dirX*t.GetHopSpeed()*dt, e.dirY*t.GetHopSpeed()*dt)
		if elapsed >= t.GetHopTime() {
			r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER, ms)
		}
	case wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER:
		tick, _ := rules.FightTickAt(ms)
		if float64(rules.FightTickDiff(tick, e.row.StateTick))*.1 >= t.GetRecover() {
			r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE, ms)
			e.readyAt = ms + int64(t.GetCooldown()*(.8+float64(r.rng.Float64()*.5))*1000)
		}
	}
	// The chunk's collision is a hard leash; the home radius also bounds chases.
	if math.Hypot(e.x-e.homeX, e.y-e.homeY) > CampLeash {
		e.x, e.y = e.homeX, e.homeY
		e.target = ""
	}
}

func (r *Room) Step(now time.Time) Frame {
	ms := now.UnixMilli()
	tick, _ := rules.FightTickAt(ms)
	if rules.FightTickDiff(tick, r.lastTick) <= 0 {
		return Frame{}
	}
	r.lastTick, r.lastMS = tick, ms
	if r.ShouldClose(now) {
		r.event(nil, wire.FightEventKind_FIGHT_EVENT_KIND_ROOM_CLOSED, ms)
		return Frame{Closed: true, Events: r.takeEvents()}
	}
	for _, e := range r.enemies {
		r.stepWisp(e, ms)
		e.history = append(e.history, sample{ms, e.x, e.y})
		for len(e.history) > 1 && e.history[1].ms < ms-HistoryMillis {
			e.history = e.history[1:]
		}
	}
	results := r.stepBolts(ms)
	rows := r.rows()
	delta := &wire.FightDelta{Room: r.Handle, Tick: tick}
	// Prototype membership is fixed. F-E must resize published and emit spawned/
	// removed rows before adding or removing enemies; indexing assumes that invariant.
	for i, row := range rows {
		old := r.published[i]
		p := &wire.FightEnemyPatch{Enemy: row.Enemy}
		if old.X != row.X {
			p.X = proto.Int32(row.X)
		}
		if old.Y != row.Y {
			p.Y = proto.Int32(row.Y)
		}
		if old.State != row.State || old.StateTick != row.StateTick {
			p.State = &row.State
			p.StateTick = proto.Uint32(row.StateTick)
		}
		if old.Hp != row.Hp {
			p.Hp = proto.Float64(row.Hp)
		}
		if old.Facing != row.Facing {
			p.Facing = proto.Uint32(row.Facing)
		}
		if p.X != nil || p.Y != nil || p.State != nil || p.Hp != nil || p.Facing != nil {
			delta.Changed = append(delta.Changed, p)
		}
	}
	r.published = rows
	if len(delta.Changed) == 0 {
		delta = nil
	}
	falls := r.falls
	r.falls = nil
	return Frame{Delta: delta, Events: r.takeEvents(), Bolts: results, Falls: falls}
}
func (r *Room) takeEvents() []*wire.FightEvent { events := r.events; r.events = nil; return events }
func RewindAt(now time.Time, seenTick, offset uint32) int64 {
	tick, nowOffset := rules.FightTickAt(now.UnixMilli())
	age := int64(rules.FightTickDiff(tick, seenTick))*100 + int64(nowOffset) - int64(offset)
	return now.UnixMilli() - max(0, min(RewindMillis, age))
}
func (e *enemy) at(ms int64) (float64, float64) {
	if len(e.history) == 0 {
		return e.x, e.y
	}
	left := e.history[0]
	for _, right := range e.history[1:] {
		if ms <= right.ms {
			if ms <= left.ms {
				return left.x, left.y
			}
			f := float64(ms-left.ms) / float64(right.ms-left.ms)
			return left.x + float64((right.x-left.x)*f), left.y + float64((right.y-left.y)*f)
		}
		left = right
	}
	return left.x, left.y
}
func (r *Room) hit(e *enemy, a Attack, x, y float64, ms int64) *wire.FightHitRow {
	damage := rules.FightDamage(a.Damage, a.Crit, 1, a.Swing.Tool)
	e.row.Hp = math.Max(0, e.row.Hp-damage)
	if e.row.Hp == 0 {
		r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_DEAD, ms)
		r.event(e, wire.FightEventKind_FIGHT_EVENT_KIND_DEATH, ms)
	} else {
		dx, dy := direction(e.x-x, (e.y-y)*.5)
		e.knockX = dx * content.EnemyRules.GetKnock().GetSmall()
		e.knockY = dy * content.EnemyRules.GetKnock().GetSmall()
		e.knockLeft = content.EnemyRules.GetKnock().GetTime()
		if e.row.State == wire.FightEnemyState_FIGHT_ENEMY_STATE_TELEGRAPH || e.row.State == wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE {
			r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER, ms)
		}
	}
	r.startFight()
	if !r.fallen {
		all := true
		for _, other := range r.enemies {
			if other.row.Hp > 0 {
				all = false
				break
			}
		}
		if all {
			r.fallen = true
			ids := []string{}
			for id := range r.witnesses {
				ids = append(ids, id)
			}
			sort.Strings(ids)
			for _, c := range r.camps {
				r.falls = append(r.falls, Fall{Key: r.Key, Camp: c.ID, Cycle: c.Cycle, At: ms, Witnesses: ids})
			}
		}
	}
	return &wire.FightHitRow{Room: r.Handle, Enemy: e.row.Enemy, Damage: damage}
}

// Attack origins and position reports share a per-tick budget. This allows
// a press between position reports without trusting an arbitrary jump.
func (r *Room) attackPosition(p *Player, s *wire.FightSwing, now time.Time) *Player {
	next := *p
	next.X, next.Y = s.X, s.Y
	r.Cover(next, now)
	return r.players[p.Observer]
}

// Slash judges every live enemy and every prediction with the capped origin.
func (r *Room) Slash(a Attack, now time.Time) []*wire.FightHitRow {
	p := r.players[a.Player]
	if p == nil || p.Down {
		return nil
	}
	p = r.attackPosition(p, a.Swing, now)
	rewind := RewindAt(now, a.Swing.SeenTick, a.Swing.SeenOffsetMs)
	predicted := map[uint32]bool{}
	for _, t := range a.Swing.Predicted {
		if t.Room == r.Handle {
			predicted[t.Enemy] = true
		}
	}
	rows := []*wire.FightHitRow{}
	for _, e := range r.enemies {
		x, y := e.at(rewind)
		reached := rules.FightReach("slash", p.X, p.Y, a.Swing.Facing.X, a.Swing.Facing.Y, x, y)
		reason := wire.FightRefusedReason_FIGHT_REFUSED_REASON_UNSPECIFIED
		if e.row.Hp <= 0 {
			reason = wire.FightRefusedReason_FIGHT_REFUSED_REASON_ALREADY_DEAD
		} else if !reached {
			reason = wire.FightRefusedReason_FIGHT_REFUSED_REASON_OUT_OF_REACH
		}
		if reason == 0 {
			rows = append(rows, r.hit(e, a, p.X, p.Y, now.UnixMilli()))
		} else if predicted[e.row.Enemy] {
			rows = append(rows, &wire.FightHitRow{Room: r.Handle, Enemy: e.row.Enemy, RefusedReason: reason})
		}
	}
	return rows
}
func (r *Room) StartBolt(a Attack, now time.Time) bool {
	p := r.players[a.Player]
	if p == nil || p.Down {
		return false
	}
	p = r.attackPosition(p, a.Swing, now)
	x, y := rules.FightBoltSpawn(p.X, p.Y, a.Swing.Facing.X)
	r.bolts = append(r.bolts, bolt{attack: a, x: x, y: y, started: now.UnixMilli(), advancedAt: now.UnixMilli()})
	return true
}
func (r *Room) stepBolts(ms int64) []BoltResult {
	live := r.bolts[:0]
	results := []BoltResult{}
	tuning := content.CombatRules.GetAttack()
	for _, b := range r.bolts {
		age := float64(ms-b.started) / 1000
		end := min(ms, b.started+int64(tuning.GetBoltLifetimeSeconds()*1000))
		dt := math.Max(0, float64(end-b.advancedAt)/1000)
		b.advancedAt = end
		steps := max(1, int(math.Ceil(tuning.GetBoltSpeed()*dt/3)))
		var row *wire.FightHitRow
		for range steps {
			b.x += float64(b.attack.Swing.Facing.X * tuning.GetBoltSpeed() * dt / float64(steps))
			b.y += float64(b.attack.Swing.Facing.Y * tuning.GetBoltSpeed() * dt / float64(steps))
			// Projectiles stop at solid geometry; their centres differ from feet.
			if !r.Geometry.CanBoltFly(b.x, b.y) {
				break
			}
			for _, e := range r.enemies {
				if e.row.Hp > 0 && rules.FightReach("bolt", b.x, b.y, 0, 0, e.x, e.y) {
					row = r.hit(e, b.attack, b.x, b.y+tuning.GetOriginYOffset(), ms)
					break
				}
			}
			if row != nil {
				break
			}
		}
		if row != nil {
			results = append(results, BoltResult{ID: b.attack.ID, Hits: []*wire.FightHitRow{row}})
		} else if age >= tuning.GetBoltLifetimeSeconds() || !r.Geometry.CanBoltFly(b.x, b.y) {
			results = append(results, BoltResult{ID: b.attack.ID})
		} else {
			live = append(live, b)
		}
	}
	r.bolts = live
	return results
}
