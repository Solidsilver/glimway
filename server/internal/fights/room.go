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

// Camp size (design 1.3): the base mix is at most three; at the first aggro
// each extra account within CampScaleRadius of the camp adds one, up to five.
const CampBase = 3
const CampMax = 5
const CampScaleRadius = 160.0

const (
	kindWisp   = "wisp"
	kindBeetle = "beetle"
)

// The client's spawn offsets (src/game/wilds/entities.ts spawnCamp, one tile
// each), then the extras' spots for a scaled camp.
var campOffsets = [CampMax][2]float64{{0, 0}, {16, 0}, {0, 16}, {16, 16}, {-16, 0}}

type Key struct {
	World, Realm, Epoch string
	Layer, CX, CY       int32
}

func (k Key) Wire() *wire.FightRoomKey {
	return &wire.FightRoomKey{World: k.World, Realm: k.Realm, Epoch: k.Epoch, Layer: k.Layer, Cx: k.CX, Cy: k.CY}
}

// Camp is a generated camp as loaded at wake. Kinds is its generated mix in
// order. A Fallen camp's current cycle already has a fall record: it wakes
// with its base mix as dead rows (the completion a returning witness sees)
// and respawns its next cycle at RespawnAt (Unix ms; 0 never in this wake).
type Camp struct {
	ID        string
	Cycle     int64
	X, Y      float64
	Kinds     []string
	Fallen    bool
	RespawnAt int64
}

// RespawnAt is when a camp that fell at fellAtMs shows its next cycle. It is
// the fall writer's entity_state boundary (fell_at in whole seconds plus the
// camp timer), so an awake room and a fresh wake agree to the second.
func RespawnAt(fellAtMs int64) int64 {
	return (fellAtMs/1000 + int64(content.WildsRules.GetTimers().GetCampRespawnSeconds())) * 1000
}

type camp struct {
	Camp
	started   bool
	size      int
	next      int // the next slot number in this room's life; ids are never reused
	members   []*enemy
	witnesses map[string]bool
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
	kind               string
	camp               *camp
	x, y, homeX, homeY float64
	target             string
	dirX, dirY         float64
	aimLocked          bool
	readyAt            int64
	stateMS            int64 // grid ms the current state began
	holdMS             int64 // how long RECOVER or STUNNED lasts
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
	// Flight is a bolt's one impact across the rooms it was sent to (the
	// hub's); nil flies it in this room alone.
	Flight *Flight
}
type bolt struct {
	id               uint64
	flight           *Flight
	facingX, facingY float64
	damage           float64
	crit, tool       bool
	x, y             float64  // its spawn
	through          int      // samples looked at
	hit              *boltHit // this room's first impact, until the flight decides
}
type BoltResult struct {
	ID   uint64
	Hits []*wire.FightHitRow
}

// Fall goes to F-F's single durable writer (Server.EnqueueFall), one per
// camp and cycle. At is Unix ms; Witnesses are account ids, sorted.
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

// Level-20 effects in the room (src/lib/combat-moves.ts CombatField), all
// expiring at Unix ms. Plants and decoys belong to a socket lifetime.
type patch struct {
	x, y, r, slow float64
	until         int64
}
type plant struct {
	until   int64
	stagger float64
}
type decoy struct {
	x, y  float64
	until int64
}

type Room struct {
	Key         Key
	Handle      uint32
	Geometry    Geometry
	players     map[string]*Player
	enemies     []*enemy // current membership, in index order
	camps       []*camp
	index       uint32
	rng         *rand.Rand
	lastTick    uint32
	lastMS      int64
	uncoveredAt int64
	published   []*wire.FightEnemy // the baseline the last delta (or creation) left
	removed     []uint32
	bolts       []bolt
	events      []*wire.FightEvent
	falls       []Fall
	patches     []patch
	plants      map[string]plant
	decoys      map[string]decoy
	EndsAt      int64 // Unix ms; 0 means no turning
}

// NewRoom consumes only already-loaded values. Its seed includes the wake
// number, so a replay can supply exactly the same wake and input log.
func NewRoom(key Key, handle uint32, geometry Geometry, camps []Camp, seed uint64, now time.Time, endsAt int64) *Room {
	tick, _ := rules.FightTickAt(now.UnixMilli())
	r := &Room{Key: key, Handle: handle, Geometry: geometry, players: map[string]*Player{}, plants: map[string]plant{}, decoys: map[string]decoy{}, rng: rand.New(rand.NewPCG(seed, seed^0x9e3779b97f4a7c15)), lastTick: tick, lastMS: now.UnixMilli(), uncoveredAt: now.UnixMilli(), EndsAt: endsAt}
	for _, c := range camps {
		state := &camp{Camp: c, witnesses: map[string]bool{}}
		state.Kinds = append([]string(nil), c.Kinds...)
		r.camps = append(r.camps, state)
		r.spawnBase(state, now.UnixMilli(), false)
		if c.Fallen {
			// A fall recorded for this cycle: its rows stand as the dead the
			// fight left, so the camp reads won, and nothing acts until respawn.
			for _, e := range state.members {
				e.row.Hp = 0
				r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_DEAD, now.UnixMilli())
			}
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
func tuningHP(kind string) float64 {
	if kind == kindBeetle {
		return content.EnemyRules.GetBeetle().GetHp()
	}
	return content.EnemyRules.GetWisp().GetHp()
}
func wireKind(kind string) wire.FightEnemyKind {
	if kind == kindBeetle {
		return wire.FightEnemyKind_FIGHT_ENEMY_KIND_BEETLE
	}
	return wire.FightEnemyKind_FIGHT_ENEMY_KIND_WISP
}

// spawn adds one enemy to a camp at its slot's spot; announced spawns rise
// with a SPAWN event (scaling and a cycle's respawn), a wake's do not.
func (r *Room) spawn(c *camp, kind string, slot int, ms int64, announce bool) *enemy {
	x, y := c.X+campOffsets[slot][0], c.Y+campOffsets[slot][1]
	// A generated anchor is open, but an offset may straddle solid tiles.
	if !r.Geometry.CanStand(x, y, EnemyRadius) {
		x, y = r.openHome(c.X, c.Y)
	}
	tick, _ := rules.FightTickAt(ms)
	e := &enemy{kind: kind, camp: c, x: x, y: y, homeX: x, homeY: y, stateMS: ms / 100 * 100, readyAt: ms + int64(400+float64(r.rng.Float64()*600))}
	hp := tuningHP(kind)
	e.row = wire.FightEnemy{Enemy: r.index, Id: fmt.Sprintf("wilds:%s:%d", c.ID, c.next), Kind: wireKind(kind), CampId: c.ID, MaxHp: hp, Hp: hp, State: wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE, StateTick: tick}
	e.history = []sample{{ms, x, y}}
	r.index++
	c.next++
	r.enemies = append(r.enemies, e)
	c.members = append(c.members, e)
	if announce {
		r.event(e, wire.FightEventKind_FIGHT_EVENT_KIND_SPAWN, ms)
	}
	return e
}
func (r *Room) spawnBase(c *camp, ms int64, announce bool) {
	c.size = min(len(c.Kinds), CampBase)
	for i := 0; i < c.size; i++ {
		r.spawn(c, c.Kinds[i], i, ms, announce)
	}
}

// startCamp is a camp's first aggro (an enemy took a target, or a blow
// landed): its witnesses begin and its size freezes for this cycle.
func (r *Room) startCamp(c *camp, ms int64) {
	if c.started || c.Fallen {
		return
	}
	c.started = true
	accounts := map[string]bool{}
	for _, p := range r.players {
		c.witnesses[p.ID] = true
		if !p.Down && math.Hypot(p.X-c.X, p.Y-c.Y) <= CampScaleRadius {
			accounts[p.ID] = true
		}
	}
	size := min(CampMax, c.size+max(0, len(accounts)-1))
	if len(c.Kinds) == 0 {
		return
	}
	for slot := c.size; slot < size; slot++ {
		r.spawn(c, c.Kinds[slot%len(c.Kinds)], slot, ms, true)
	}
	c.size = max(c.size, size)
}

// respawn starts a fallen camp's next cycle: the dead rows leave, the base
// mix rises fresh, and nothing of the old cycle (its fall) is touched.
func (r *Room) respawn(c *camp, ms int64) {
	gone := map[*enemy]bool{}
	for _, e := range c.members {
		gone[e] = true
		r.removed = append(r.removed, e.row.Enemy)
	}
	live := r.enemies[:0]
	for _, e := range r.enemies {
		if !gone[e] {
			live = append(live, e)
		}
	}
	r.enemies = live
	c.members = nil
	c.Cycle++
	c.Fallen, c.RespawnAt, c.started = false, 0, false
	c.witnesses = map[string]bool{}
	r.spawnBase(c, ms, true)
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

// Join is the published baseline: the next delta's patches, spawns and
// removals are relative to exactly these rows and this tick.
func (r *Room) Join(seed uint32) *wire.FightJoin {
	rows := make([]*wire.FightEnemy, 0, len(r.published))
	for _, row := range r.published {
		rows = append(rows, proto.Clone(row).(*wire.FightEnemy))
	}
	return &wire.FightJoin{RoomKey: r.Key.Wire(), Room: r.Handle, Tick: r.lastTick, Enemies: rows, CritSeed: seed}
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
	for _, c := range r.camps {
		if c.started && !c.Fallen {
			c.witnesses[p.ID] = true
		}
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
	delete(r.plants, observer)
	delete(r.decoys, observer)
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
		if p := r.players[e.target]; p != nil && kind != wire.FightEventKind_FIGHT_EVENT_KIND_SPAWN {
			_, _, id := r.aim(p, ms)
			v.Target = proto.String(id)
		}
	}
	r.events = append(r.events, v)
}
func (r *Room) state(e *enemy, state wire.FightEnemyState, ms int64) {
	e.row.State = state
	e.row.StateTick, _ = rules.FightTickAt(ms)
	e.stateMS = ms / 100 * 100
}
func (r *Room) hold(e *enemy, state wire.FightEnemyState, seconds float64, ms int64) {
	r.state(e, state, ms)
	e.holdMS = wholeMs(seconds)
}
func wholeMs(seconds float64) int64 { return int64(math.Floor(float64(seconds*1000) + 0.5)) }

// aim is where enemies see a player: an Echo's decoy while it lasts
// (CombatField.aimFor), named decoy:<account> in events.
func (r *Room) aim(p *Player, ms int64) (float64, float64, string) {
	if d, ok := r.decoys[p.Observer]; ok && ms < d.until {
		return d.x, d.y, "decoy:" + p.ID
	}
	return p.X, p.Y, p.ID
}
func (r *Room) aimLeashed(e *enemy, p *Player, ms int64) bool {
	if p == nil || p.Down {
		return false
	}
	x, y, _ := r.aim(p, ms)
	return math.Hypot(x-e.homeX, y-e.homeY) < CampLeash
}
func aggroOf(kind string) float64 {
	if kind == kindBeetle {
		return content.EnemyRules.GetBeetle().GetAggro()
	}
	return content.EnemyRules.GetWisp().GetAggro()
}

// target picks who an enemy goes for, and where it aims: the nearest
// player (or their decoy) in aggro range between attacks. A wind-up and its
// lunge stay committed so the tell stays readable; a current target can be
// chased past aggro range while it stays inside the camp leash.
func (r *Room) target(e *enemy, ms int64) (*Player, float64, float64) {
	var closest *Player
	distance := aggroOf(e.kind)
	if p := r.players[e.target]; r.aimLeashed(e, p, ms) {
		x, y, _ := r.aim(p, ms)
		if e.row.State == wire.FightEnemyState_FIGHT_ENEMY_STATE_TELEGRAPH || e.row.State == wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE {
			return p, x, y
		}
		closest = p
		distance = math.Min(distance, math.Hypot(x-e.x, y-e.y))
	} else {
		e.target = ""
	}
	// Stable iteration makes equal-distance targets and replays deterministic.
	ids := make([]string, 0, len(r.players))
	for id := range r.players {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		p := r.players[id]
		x, y, _ := r.aim(p, ms)
		d := math.Hypot(x-e.x, y-e.y)
		if r.aimLeashed(e, p, ms) && d < distance {
			closest = p
			distance = d
			e.target = id
		}
	}
	if closest == nil {
		return nil, 0, 0
	}
	x, y, _ := r.aim(closest, ms)
	return closest, x, y
}
func direction(dx, dy float64) (float64, float64) {
	d := math.Hypot(dx, dy)
	if d == 0 {
		return 1, 0
	}
	return dx / d, dy / d
}

// slowAt is Kindle's multiplier at a point: the slowest live patch it
// stands in (CombatField.slowAt), 1 outside them all.
func (r *Room) slowAt(x, y float64, ms int64) float64 {
	k := 1.0
	for _, p := range r.patches {
		if ms < p.until && inCircle(x, y, p.x, p.y, p.r) {
			k = math.Min(k, p.slow)
		}
	}
	return k
}
func inCircle(px, py, cx, cy, r float64) bool {
	dx, dy := px-cx, py-cy
	return float64(dx*dx)+float64(dy*dy) <= r*r
}

// standMargin is src/lib/combat-moves.ts STAND_MARGIN: a lunge that comes
// this close past its reach still stops short of a planted hero.
const standMargin = 4.0

func lungeReach(kind string) float64 {
	if kind == kindBeetle {
		return content.EnemyRules.GetBeetle().GetChargeReach()
	}
	return content.EnemyRules.GetWisp().GetHopReach()
}

// planted reports the stagger of a planted player (Stand) the lunging enemy
// has reached, measured middle to middle as the client's touch does
// (hero feet − 8, enemy feet − 6).
func (r *Room) planted(e *enemy, ms int64) (float64, bool) {
	observers := make([]string, 0, len(r.plants))
	for o := range r.plants {
		observers = append(observers, o)
	}
	sort.Strings(observers)
	for _, o := range observers {
		pl := r.plants[o]
		p := r.players[o]
		if p == nil || p.Down || ms >= pl.until {
			continue
		}
		if math.Hypot(p.X-e.x, (p.Y-8)-(e.y-6)) < lungeReach(e.kind)+standMargin {
			return pl.stagger, true
		}
	}
	return 0, false
}

// stagger is a lunge stopped short against a planted hero: a beetle is
// dazed (and takes more), a wisp squashes into its recovery.
func (r *Room) stagger(e *enemy, seconds float64, ms int64) {
	if e.kind == kindBeetle {
		r.hold(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_STUNNED, seconds, ms)
	} else {
		r.hold(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER, seconds, ms)
	}
}

// lunge moves an enemy along its locked aim in small steps, so a planted
// hero and a wall are both met where they are, not a tick later.
func (r *Room) lunge(e *enemy, dx, dy float64, ms int64) (blocked, staggered bool) {
	n := max(1, int(math.Ceil(math.Max(math.Abs(dx), math.Abs(dy))/4)))
	for range n {
		var hit bool
		e.x, e.y, hit = r.Geometry.MoveBlocked(e.x, e.y, dx/float64(n), dy/float64(n))
		if seconds, ok := r.planted(e, ms); ok {
			r.stagger(e, seconds, ms)
			return false, true
		}
		if hit {
			return true, false
		}
	}
	return false, false
}

func (r *Room) walkHome(e *enemy, speed, slow float64, ms int64) {
	if e.row.State != wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE {
		r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE, ms)
	}
	d := math.Hypot(e.homeX-e.x, e.homeY-e.y)
	if d > 0.1 {
		dx, dy := direction(e.homeX-e.x, e.homeY-e.y)
		step := math.Min(d, speed*.1) * slow
		e.x, e.y = r.Geometry.Move(e.x, e.y, dx*step, dy*step)
		e.row.Facing = rules.FightFacingStep(dx, dy)
	}
}

// telegraph is the shared wind-up: facing follows the aim until it locks
// (an AIM_LOCK event stamped at the lock), then the attack launches.
func (r *Room) telegraph(e *enemy, dx, dy float64, ms int64) {
	tick, _ := rules.FightTickAt(ms)
	elapsed := rules.FightTickDiff(tick, e.row.StateTick)
	if !e.aimLocked {
		e.row.Facing = rules.FightFacingStep(dx, dy)
		if rules.FightAimLocked(e.kind, elapsed) {
			e.aimLocked = true
			e.dirX, e.dirY = dx, dy
			lock, _, _ := rules.FightWindupTicks(e.kind)
			r.event(e, wire.FightEventKind_FIGHT_EVENT_KIND_AIM_LOCK, ms-int64(elapsed-int32(lock))*100)
		}
	}
	if rules.FightLaunched(e.kind, elapsed) {
		r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE, ms)
	}
}
func (r *Room) windup(e *enemy, ms int64) {
	r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_TELEGRAPH, ms)
	e.aimLocked = false
	r.event(e, wire.FightEventKind_FIGHT_EVENT_KIND_WINDUP_START, ms)
}

// lungeStep is this tick's share of a lunge lasting `seconds`: a full tick,
// then the remainder, as the client's state timer runs.
func (r *Room) lungeStep(e *enemy, seconds float64, ms int64) (dt, elapsed float64) {
	elapsed = float64(ms-e.stateMS) / 1000
	return math.Max(0, math.Min(.1, seconds-(elapsed-.1))), elapsed
}

func (r *Room) step(e *enemy, ms int64) {
	if e.row.Hp <= 0 {
		return
	}
	slow := r.slowAt(e.x, e.y, ms)
	if e.knockLeft > 0 {
		// A shove through a Kindle patch is slowed like any other movement.
		dt := math.Min(.1, e.knockLeft)
		e.x, e.y = r.Geometry.Move(e.x, e.y, e.knockX*dt*slow, e.knockY*dt*slow)
		e.knockLeft = math.Max(0, e.knockLeft-.1)
		return
	}
	p, ax, ay := r.target(e, ms)
	if p != nil {
		r.startCamp(e.camp, ms)
	}
	if e.kind == kindBeetle {
		r.stepBeetle(e, p, ax, ay, slow, ms)
	} else {
		r.stepWisp(e, p, ax, ay, slow, ms)
	}
	// The chunk's collision is a hard leash; the home radius also bounds chases.
	if math.Hypot(e.x-e.homeX, e.y-e.homeY) > CampLeash {
		e.x, e.y = e.homeX, e.homeY
		e.target = ""
	}
}

// stepWisp is creatures.ts updateHopper: shuffle closer, a telegraphed hop at
// where you stood when the aim locked, then a squashed recovery.
func (r *Room) stepWisp(e *enemy, p *Player, ax, ay, slow float64, ms int64) {
	t := content.EnemyRules.GetWisp()
	if p == nil {
		r.walkHome(e, t.GetChase(), slow, ms)
		return
	}
	dx, dy := direction(ax-e.x, ay-e.y)
	dist := math.Hypot(ax-e.x, ay-e.y)
	switch e.row.State {
	case wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE:
		e.row.Facing = rules.FightFacingStep(dx, dy)
		if dist < t.GetHopRange() && ms >= e.readyAt {
			r.windup(e, ms)
		} else if dist > t.GetHopRange()*.7 {
			e.x, e.y = r.Geometry.Move(e.x, e.y, dx*t.GetChase()*.1*slow, dy*t.GetChase()*.1*slow)
		}
	case wire.FightEnemyState_FIGHT_ENEMY_STATE_TELEGRAPH:
		r.telegraph(e, dx, dy, ms)
	case wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE:
		dt, elapsed := r.lungeStep(e, t.GetHopTime(), ms)
		if _, staggered := r.lunge(e, e.dirX*t.GetHopSpeed()*dt*slow, e.dirY*t.GetHopSpeed()*dt*slow, ms); staggered {
			return
		}
		if elapsed >= t.GetHopTime() {
			r.hold(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER, t.GetRecover(), ms)
		}
	case wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER:
		if ms-e.stateMS >= e.holdMS {
			r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE, ms)
			e.readyAt = ms + int64(t.GetCooldown()*(.8+float64(r.rng.Float64()*.5))*1000)
		}
	}
}

// stepBeetle is creatures.ts updateBeetle: keep a charging distance, paw the
// ground, charge along the locked aim; a charge into a wall or tree leaves
// it dazed (STUNNED, taking stunnedTakes).
func (r *Room) stepBeetle(e *enemy, p *Player, ax, ay, slow float64, ms int64) {
	t := content.EnemyRules.GetBeetle()
	if p == nil {
		r.walkHome(e, t.GetWalk(), slow, ms)
		return
	}
	dx, dy := direction(ax-e.x, ay-e.y)
	dist := math.Hypot(ax-e.x, ay-e.y)
	switch e.row.State {
	case wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE:
		e.row.Facing = rules.FightFacingStep(dx, dy)
		step := t.GetWalk() * .1 * slow
		if dist > t.GetKeepAway()+16 {
			e.x, e.y = r.Geometry.Move(e.x, e.y, dx*step, dy*step)
		} else if dist < t.GetKeepAway()-16 {
			e.x, e.y = r.Geometry.Move(e.x, e.y, -dx*step*.7, -dy*step*.7)
		}
		if ms >= e.readyAt && dist < t.GetChargeRange() {
			r.windup(e, ms)
		}
	case wire.FightEnemyState_FIGHT_ENEMY_STATE_TELEGRAPH:
		r.telegraph(e, dx, dy, ms)
	case wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE:
		dt, elapsed := r.lungeStep(e, t.GetChargeTime(), ms)
		crashed, staggered := r.lunge(e, e.dirX*t.GetChargeSpeed()*dt*slow, e.dirY*t.GetChargeSpeed()*dt*slow, ms)
		if staggered {
			return
		}
		if crashed {
			r.hold(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_STUNNED, t.GetStun(), ms)
		} else if elapsed >= t.GetChargeTime() {
			r.hold(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER, t.GetRecover(), ms)
		}
	case wire.FightEnemyState_FIGHT_ENEMY_STATE_STUNNED:
		if ms-e.stateMS >= e.holdMS {
			r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE, ms)
			e.readyAt = ms + wholeMs(t.GetCooldown())
		}
	case wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER:
		if ms-e.stateMS >= e.holdMS {
			r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_CHASE, ms)
			e.readyAt = ms + int64(t.GetCooldown()*(.8+float64(r.rng.Float64()*.4))*1000)
		}
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
	r.expire(ms)
	for _, c := range r.camps {
		if c.Fallen && c.RespawnAt > 0 && ms >= c.RespawnAt {
			r.respawn(c, ms)
		}
	}
	for _, e := range r.enemies {
		r.step(e, ms)
		e.history = append(e.history, sample{ms, e.x, e.y})
		for len(e.history) > 1 && e.history[1].ms < ms-HistoryMillis {
			e.history = e.history[1:]
		}
	}
	results := r.stepBolts(ms)
	delta := r.diff(tick)
	return Frame{Delta: delta, Events: r.takeEvents(), Bolts: results, Falls: r.takeFalls()}
}
func (r *Room) takeFalls() []Fall { falls := r.falls; r.falls = nil; return falls }

// Cleared is a dev clear's answer: Found when the room runs the camp,
// Fresh when this clear made its fall (Fall then carries At and witnesses);
// a camp already down answers with its current cycle only.
type Cleared struct {
	Fall         Fall
	Found, Fresh bool
}

// Clear puts a live camp down at once, as if its last blow landed now: its
// first aggro (scaling, witnesses from the players covering the room) and
// its fall go through the same paths a fight's do. It is for dev fixtures
// only (the dev fight-fall route); no production path calls it.
func (r *Room) Clear(id string, now time.Time) Cleared {
	ms := now.UnixMilli()
	for _, c := range r.camps {
		if c.ID != id {
			continue
		}
		if c.Fallen {
			return Cleared{Fall: Fall{Key: r.Key, Camp: c.ID, Cycle: c.Cycle}, Found: true}
		}
		r.startCamp(c, ms)
		for _, e := range c.members {
			if e.row.Hp > 0 {
				e.row.Hp, e.knockLeft = 0, 0
				r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_DEAD, ms)
				r.event(e, wire.FightEventKind_FIGHT_EVENT_KIND_DEATH, ms)
			}
		}
		r.campFell(c, ms)
		return Cleared{Fall: r.falls[len(r.falls)-1], Found: true, Fresh: true}
	}
	return Cleared{}
}

// diff moves the published baseline to now: patches for rows that changed,
// whole rows for enemies that entered, and the indices that left.
func (r *Room) diff(tick uint32) *wire.FightDelta {
	rows := r.rows()
	old := make(map[uint32]*wire.FightEnemy, len(r.published))
	for _, row := range r.published {
		old[row.Enemy] = row
	}
	delta := &wire.FightDelta{Room: r.Handle, Tick: tick}
	for _, idx := range r.removed {
		if old[idx] != nil {
			delta.Removed = append(delta.Removed, idx)
		}
	}
	r.removed = nil
	for _, row := range rows {
		prev := old[row.Enemy]
		if prev == nil {
			delta.Spawned = append(delta.Spawned, proto.Clone(row).(*wire.FightEnemy))
			continue
		}
		p := &wire.FightEnemyPatch{Enemy: row.Enemy}
		if prev.X != row.X {
			p.X = proto.Int32(row.X)
		}
		if prev.Y != row.Y {
			p.Y = proto.Int32(row.Y)
		}
		if prev.State != row.State || prev.StateTick != row.StateTick {
			p.State = &row.State
			p.StateTick = proto.Uint32(row.StateTick)
		}
		if prev.Hp != row.Hp {
			p.Hp = proto.Float64(row.Hp)
		}
		if prev.Facing != row.Facing {
			p.Facing = proto.Uint32(row.Facing)
		}
		if p.X != nil || p.Y != nil || p.State != nil || p.Hp != nil || p.Facing != nil {
			delta.Changed = append(delta.Changed, p)
		}
	}
	r.published = rows
	if len(delta.Changed)+len(delta.Spawned)+len(delta.Removed) == 0 {
		return nil
	}
	return delta
}
func (r *Room) expire(ms int64) {
	live := r.patches[:0]
	for _, p := range r.patches {
		if ms < p.until {
			live = append(live, p)
		}
	}
	r.patches = live
	for o, p := range r.plants {
		if ms >= p.until {
			delete(r.plants, o)
		}
	}
	for o, d := range r.decoys {
		if ms >= d.until {
			delete(r.decoys, o)
		}
	}
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

// hit applies one landed blow (fight-rules.ts hitOutcome, knockFrom,
// knockInterrupts): a dazed beetle takes stunnedTakes, a charging beetle is
// too heavy to shove, and a shoved wisp loses its wind-up or hop.
func (r *Room) hit(e *enemy, base float64, crit, tool bool, x, y float64, ms int64) *wire.FightHitRow {
	stunned := 1.0
	if e.kind == kindBeetle && e.row.State == wire.FightEnemyState_FIGHT_ENEMY_STATE_STUNNED {
		stunned = content.EnemyRules.GetBeetle().GetStunnedTakes()
	}
	damage := rules.FightDamage(base, crit, stunned, tool)
	e.row.Hp = math.Max(0, e.row.Hp-damage)
	r.startCamp(e.camp, ms)
	if e.row.Hp == 0 {
		e.knockLeft = 0
		r.state(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_DEAD, ms)
		r.event(e, wire.FightEventKind_FIGHT_EVENT_KIND_DEATH, ms)
		r.campFell(e.camp, ms)
	} else if !(e.kind == kindBeetle && e.row.State == wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE) {
		dx, dy := direction(e.x-x, (e.y-y)*.5)
		e.knockX = dx * content.EnemyRules.GetKnock().GetSmall()
		e.knockY = dy * content.EnemyRules.GetKnock().GetSmall()
		e.knockLeft = content.EnemyRules.GetKnock().GetTime()
		if e.kind == kindWisp && (e.row.State == wire.FightEnemyState_FIGHT_ENEMY_STATE_TELEGRAPH || e.row.State == wire.FightEnemyState_FIGHT_ENEMY_STATE_LUNGE) {
			r.hold(e, wire.FightEnemyState_FIGHT_ENEMY_STATE_RECOVER, content.EnemyRules.GetWisp().GetRecover(), ms)
		}
	}
	return &wire.FightHitRow{Room: r.Handle, Enemy: e.row.Enemy, Damage: damage}
}

// campFell emits one fall per camp and cycle when its last enemy is down,
// and sets the next cycle's respawn at the fall writer's boundary.
func (r *Room) campFell(c *camp, ms int64) {
	if c.Fallen {
		return
	}
	for _, e := range c.members {
		if e.row.Hp > 0 {
			return
		}
	}
	c.Fallen = true
	c.RespawnAt = RespawnAt(ms)
	ids := make([]string, 0, len(c.witnesses))
	for id := range c.witnesses {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	r.falls = append(r.falls, Fall{Key: r.Key, Camp: c.ID, Cycle: c.Cycle, At: ms, Witnesses: ids})
}

// Attack origins and position reports share a per-tick budget. This allows
// a press between position reports without trusting an arbitrary jump.
func (r *Room) attackPosition(p *Player, x, y float64, now time.Time) *Player {
	next := *p
	next.X, next.Y = x, y
	r.Cover(next, now)
	return r.players[p.Observer]
}

// judge answers one blow against every enemy, at its rewound position:
// confirmed hits, plus a refusal for each prediction that missed.
func (r *Room) judge(predicted []*wire.FightTarget, at int64, ms int64, reaches func(x, y float64) bool, land func(*enemy) *wire.FightHitRow) []*wire.FightHitRow {
	want := map[uint32]bool{}
	for _, t := range predicted {
		if t.Room == r.Handle {
			want[t.Enemy] = true
		}
	}
	rows := []*wire.FightHitRow{}
	for _, e := range r.enemies {
		x, y := e.at(at)
		reason := wire.FightRefusedReason_FIGHT_REFUSED_REASON_UNSPECIFIED
		if e.row.Hp <= 0 {
			reason = wire.FightRefusedReason_FIGHT_REFUSED_REASON_ALREADY_DEAD
		} else if !reaches(x, y) {
			reason = wire.FightRefusedReason_FIGHT_REFUSED_REASON_OUT_OF_REACH
		}
		if reason == 0 {
			rows = append(rows, land(e))
		} else if want[e.row.Enemy] {
			rows = append(rows, &wire.FightHitRow{Room: r.Handle, Enemy: e.row.Enemy, RefusedReason: reason})
		}
	}
	return rows
}

// Slash judges every live enemy and every prediction with the capped origin.
func (r *Room) Slash(a Attack, now time.Time) []*wire.FightHitRow {
	p := r.players[a.Player]
	if p == nil || p.Down {
		return nil
	}
	s := a.Swing
	p = r.attackPosition(p, s.X, s.Y, now)
	return r.judge(s.Predicted, RewindAt(now, s.SeenTick, s.SeenOffsetMs), now.UnixMilli(), func(x, y float64) bool {
		return rules.FightReach("slash", p.X, p.Y, s.Facing.X, s.Facing.Y, x, y)
	}, func(e *enemy) *wire.FightHitRow {
		return r.hit(e, a.Damage, a.Crit, s.Tool, p.X, p.Y, now.UnixMilli())
	})
}
func (r *Room) StartBolt(a Attack, now time.Time) bool {
	p := r.players[a.Player]
	if p == nil || p.Down {
		return false
	}
	p = r.attackPosition(p, a.Swing.X, a.Swing.Y, now)
	r.launch(a.ID, a.Flight, p.X, p.Y, a.Swing.Facing.X, a.Swing.Facing.Y, a.Damage, a.Crit, a.Swing.Tool, now.UnixMilli())
	return true
}
func (r *Room) launch(id uint64, flight *Flight, x, y, fx, fy, damage float64, crit, tool bool, ms int64) {
	if flight == nil {
		// Alone: this room's ground, with ground off the chunk left open.
		flight = NewFlight(ms, BoltSamples(r.Geometry.CanBoltFly, x, y, fx, fy))
		flight.Join(r.Handle, nil)
		flight.Seal()
	}
	bx, by := rules.FightBoltSpawn(x, y, fx)
	r.bolts = append(r.bolts, bolt{id: id, flight: flight, facingX: fx, facingY: fy, damage: damage, crit: crit, tool: tool, x: bx, y: by})
}

// stepBolts looks along each bolt as far as it has flown by this tick, for
// this room's first impact (the nearest enemy at the earliest sample), and
// reports it to the bolt's flight; then settles every decided bolt.
func (r *Room) stepBolts(ms int64) []BoltResult {
	for i := range r.bolts {
		b := &r.bolts[i]
		if b.hit != nil {
			continue
		}
		for k, upto := b.through+1, b.flight.sampleAt(ms); k <= upto && b.hit == nil; k++ {
			b.hit = r.boltImpact(b, k)
			b.through = k
		}
		b.flight.report(r.Handle, b.through, b.hit)
	}
	return r.settleBolts(ms)
}

func (r *Room) boltImpact(b *bolt, k int) *boltHit {
	x, y := boltPoint(b.x, b.y, b.facingX, b.facingY, k)
	offset := content.CombatRules.GetAttack().GetEnemyYOffset()
	var best *boltHit
	for _, e := range r.enemies {
		if e.row.Hp <= 0 || !rules.FightReach("bolt", x, y, 0, 0, e.x, e.y) {
			continue
		}
		dx, dy := e.x-x, e.y-offset-y
		if d2 := float64(dx*dx) + float64(dy*dy); best == nil || d2 < best.d2 {
			best = &boltHit{k: k, d2: d2, room: r.Handle, enemy: e.row.Enemy, x: x, y: y}
		}
	}
	return best
}

// SettleBolts answers every bolt its flight has decided: the room that won
// lands its impact now (if that enemy still stands), the rest answer empty.
// The actor calls it when a flight wakes it, between ticks.
func (r *Room) SettleBolts(now time.Time) []BoltResult { return r.settleBolts(now.UnixMilli()) }

func (r *Room) settleBolts(ms int64) []BoltResult {
	live := r.bolts[:0]
	results := []BoltResult{}
	for _, b := range r.bolts {
		decided, won := b.flight.verdict(r.Handle)
		if !decided {
			live = append(live, b)
			continue
		}
		result := BoltResult{ID: b.id}
		if won != nil {
			for _, e := range r.enemies {
				if e.row.Enemy == won.enemy && e.row.Hp > 0 {
					result.Hits = []*wire.FightHitRow{r.hit(e, b.damage, b.crit, b.tool, won.x, won.y+content.CombatRules.GetAttack().GetOriginYOffset(), ms)}
				}
			}
		}
		results = append(results, result)
	}
	r.bolts = live
	return results
}

// AbandonBolts withdraws this room's copies from their flights (the room is
// closing), so no other room waits on them.
func (r *Room) AbandonBolts() {
	for _, b := range r.bolts {
		b.flight.Withdraw(r.Handle)
	}
	r.bolts = nil
}
