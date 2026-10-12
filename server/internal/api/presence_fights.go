package api

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"math"
	"sort"
	"strconv"
	"sync"
	"time"

	"buf.build/go/protovalidate"
	"github.com/coder/websocket"
	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/fights"
	"glimway/server/internal/frontier"
	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
	"glimway/server/internal/wilds"
	"google.golang.org/protobuf/proto"
)

type presenceFightRoom struct {
	key      fights.Key
	handle   uint32
	actor    *fights.Actor
	geometry fights.Geometry
}

// fightLocationEpoch resolves a physical location to its current immutable
// epoch. Its expiry bounds both positive and negative wake cache entries.
type fightLocation struct {
	world, realm  string
	layer, cx, cy int32
}
type fightLocationEpoch struct {
	key    fights.Key
	endsAt int64
	// geometry is the chunk's ground at wake, campless chunks included: a
	// Shadowstep dash slides along it across chunk edges (fightGround).
	geometry fights.Geometry
}

func fightSeed() uint32 {
	for {
		var b [4]byte
		if _, err := rand.Read(b[:]); err != nil {
			panic(err)
		}
		if seed := binary.LittleEndian.Uint32(b[:]); seed != 0 {
			return seed
		}
	}
}
func (h *presenceHub) fightObserver(p *presencePeer) string {
	if p.fightToken == "" {
		h.fightSocket++
		p.fightToken = strconv.FormatUint(h.fightSocket, 10)
		p.critSeed = fightSeed()
	}
	return p.fightToken
}

// Callers hold h.mu. Room input queues never call the hub synchronously.
func (h *presenceHub) leaveFightRoom(p *presencePeer, handle uint32, notify bool) {
	room := p.fightRooms[handle]
	if room == nil {
		return
	}
	// A pending cover has not established a client view yet.
	if notify && p.fightJoined[handle] {
		tick, off := rules.FightTickAt(h.now().UnixMilli())
		h.send(p, &wire.FightEvent{Room: handle, Tick: tick, OffsetMs: off, Kind: wire.FightEventKind_FIGHT_EVENT_KIND_ROOM_CLOSED})
	}
	room.actor.Leave(p.fightToken)
	delete(p.fightRooms, handle)
	delete(p.fightJoined, handle)
}
func (h *presenceHub) leaveFights(p *presencePeer, notify bool) {
	for handle := range p.fightRooms {
		h.leaveFightRoom(p, handle, notify)
	}
	p.fightRooms = nil
	p.fightJoined = nil
}

// Area labels may change on each chunk crossing; fight visibility follows
// the last physical position and is reconciled again on the next report.
func (h *presenceHub) retainFightCoverage(p *presencePeer) {
	_, _, outdoor := wildsRoomChunk(p.area)
	if !outdoor || p.pos == nil {
		h.leaveFights(p, true)
		return
	}
	tx, ty := wilds.TileOfPixel(p.pos.X, p.pos.Y)
	cx, cy := wilds.ChunkOf(tx, ty)
	for handle, room := range p.fightRooms {
		key := room.key
		if key.World != p.identity.World || key.Realm != content.WildsRules.GetRealm() || key.Layer != 0 || intAbs(int(key.CX)-cx) > 1 || intAbs(int(key.CY)-cy) > 1 {
			h.leaveFightRoom(p, handle, true)
		}
	}
}
func (a *Server) fightOutput(room *presenceFightRoom, out fights.Output) {
	b, err := encodePresence(out.Message)
	h := a.presence
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, p := range h.peers {
		if p.fightRooms[room.handle] != room || p.detached || out.Observer != "" && out.Observer != p.fightToken {
			continue
		}
		_, join := out.Message.(*wire.FightJoin)
		if !join && !p.fightJoined[room.handle] {
			continue
		}
		if err != nil {
			p.stop(websocket.StatusInternalError, "internal")
		} else {
			h.enqueue(p, b)
			if p.ctx.Err() == nil {
				a.RecordFightBytes(len(b))
			}
			if join && p.ctx.Err() == nil {
				if p.fightJoined == nil {
					p.fightJoined = map[uint32]bool{}
				}
				p.fightJoined[room.handle] = true
			}
		}
	}
}
func (a *Server) fightClosed(room *presenceFightRoom) {
	h := a.presence
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.fightRooms[room.key] == room {
		delete(h.fightRooms, room.key)
	}
	for _, p := range h.peers {
		if p.fightRooms[room.handle] == room {
			delete(p.fightRooms, room.handle)
			delete(p.fightJoined, room.handle)
		}
	}
}

// syncFightPresence runs after the reader releases h.mu. Loading is serialized
// separately from fan-out and never happens in a tick or while holding h.mu.
// Every chunk with a generated camp in the player's physical 3x3 has a room;
// a chunk without one is remembered as empty for its epoch and never wakes.
func (a *Server) syncFightPresence(p *presencePeer) {
	h := a.presence
	h.fightLoad.Lock()
	defer h.fightLoad.Unlock()
	h.mu.Lock()
	if h.peers[p.identity.ID] != p || p.detached || p.ctx.Err() != nil || h.closing {
		h.mu.Unlock()
		return
	}
	h.retainFightCoverage(p)
	_, _, outdoor := wildsRoomChunk(p.area)
	if p.pos == nil || !outdoor {
		h.leaveFights(p, true)
		h.mu.Unlock()
		return
	}
	px, py := wilds.TileOfPixel(p.pos.X, p.pos.Y)
	pcx, pcy := wilds.ChunkOf(px, py)
	world := p.identity.World
	now := h.now()
	rooms := []*presenceFightRoom{}
	missing := []fightLocation{}
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			cx, cy := pcx+dx, pcy+dy
			if !frontier.Inside(world, cx, cy) {
				continue
			}
			location := fightLocation{world: world, realm: content.WildsRules.GetRealm(), layer: 0, cx: int32(cx), cy: int32(cy)}
			resolved, known := h.fightLocations[location]
			if known && resolved.endsAt > 0 && now.UnixMilli() >= resolved.endsAt {
				delete(h.fightLocations, location)
				delete(h.fightFailedWakes, resolved.key)
				known = false
			}
			if !known {
				missing = append(missing, location)
				continue
			}
			// fightFailedWakes: this chunk holds no camp in this epoch.
			if h.fightFailedWakes[resolved.key] {
				continue
			}
			// Exact physical identity: never choose a realm/layer/epoch by map order.
			if room := h.fightRooms[resolved.key]; room != nil && room.key == resolved.key {
				rooms = append(rooms, room)
			} else {
				missing = append(missing, location)
			}
		}
	}
	h.mu.Unlock()
	if len(missing) > 0 {
		woken, ok := a.wakeFightRooms(p, world, missing, now)
		if !ok {
			return
		}
		rooms = append(rooms, woken...)
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.peers[p.identity.ID] != p || p.ctx.Err() != nil || p.detached || p.identity.World != world || h.closing || p.pos == nil {
		return
	}
	for _, room := range rooms {
		h.coverFightRoom(p, room)
	}
}

// inFightRoom: the account's socket covers a fight room, so a committed fall
// must reach the sim before its next swing or target choice.
func (a *Server) inFightRoom(id string) bool {
	h := a.presence
	if h == nil {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	p := h.peers[id]
	return p != nil && len(p.fightRooms) > 0
}

// fightWake is one chunk's state, loaded at a lifecycle boundary.
type fightWake struct {
	location fightLocation
	key      fights.Key
	endsAt   int64
	camps    []fights.Camp
	geometry fights.Geometry
}

// wakeFightRooms loads every missing chunk of a 3x3 in one transaction, then
// starts a room for each chunk with a camp. Store work stays here, never in
// a tick: the fall lookup decides which camps wake already fallen.
func (a *Server) wakeFightRooms(p *presencePeer, world string, missing []fightLocation, now time.Time) ([]*presenceFightRoom, bool) {
	h := a.presence
	ctx, cancel := context.WithTimeout(p.ctx, 2*time.Second)
	defer cancel()
	tx, err := a.beginTx(ctx)
	if err != nil {
		a.logUnexpected("fight-wake", err)
		return nil, false
	}
	defer tx.Rollback()
	wakes := make([]fightWake, 0, len(missing))
	for _, location := range missing {
		w, err := a.loadFightChunk(ctx, tx, world, location, now)
		if err != nil {
			a.logUnexpected("fight-wake", err)
			return nil, false
		}
		wakes = append(wakes, w)
	}
	// Commit newly generated epoch/chunk identity before caching anything.
	if err = tx.Commit(); err != nil {
		a.logUnexpected("fight-wake", err)
		return nil, false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing || h.peers[p.identity.ID] != p || p.identity.World != world || p.ctx.Err() != nil {
		return nil, false
	}
	rooms := []*presenceFightRoom{}
	for _, w := range wakes {
		h.fightLocations[w.location] = fightLocationEpoch{key: w.key, endsAt: w.endsAt, geometry: w.geometry}
		if len(w.camps) == 0 {
			h.fightFailedWakes[w.key] = true
			continue
		}
		if room := h.fightRooms[w.key]; room != nil {
			rooms = append(rooms, room)
			continue
		}
		if h.fightHandle == math.MaxUint32 {
			continue
		} // never reuse a handle
		h.fightHandle++
		room := &presenceFightRoom{key: w.key, handle: h.fightHandle, geometry: w.geometry}
		h.fightRooms[w.key] = room
		seed := fnv.New64a()
		fmt.Fprintf(seed, "%s/%s/%d/%d/%d/%s/%d", w.key.World, w.key.Realm, w.key.Layer, w.key.CX, w.key.CY, w.key.Epoch, room.handle)
		for _, c := range w.camps {
			fmt.Fprintf(seed, "/%s:%d", c.ID, c.Cycle)
		}
		sim := fights.NewRoom(w.key, room.handle, w.geometry, w.camps, seed.Sum64(), now, w.endsAt)
		created := room
		room.actor = fights.Start(sim, fights.ActorConfig{
			Now:          h.now,
			Emit:         func(out fights.Output) { a.fightOutput(created, out) },
			Closed:       func() { a.fightClosed(created) },
			Fall:         a.fightFell,
			TickDuration: a.RecordFightTick,
		})
		rooms = append(rooms, room)
	}
	return rooms, true
}

// loadFightChunk reads one chunk's epoch, camps and effective geometry. A
// camp's projected entity row gives its current cycle; that cycle wakes down
// when its fall is recorded, or when a 0.8 claim cleared it (no fall, so
// nothing to claim again), until the row's timer.
func (a *Server) loadFightChunk(ctx context.Context, tx *sql.Tx, world string, location fightLocation, now time.Time) (fightWake, error) {
	cx, cy := int(location.cx), int(location.cy)
	ep, err := a.epochAt(ctx, tx, world, cx, cy, now.Unix())
	if err != nil {
		return fightWake{}, err
	}
	chunk, err := a.Config.Chunks.Chunk(ctx, tx, world, ep.Id, 0, int32(cx), int32(cy))
	if err != nil {
		return fightWake{}, err
	}
	if chunk.Cx != location.cx || chunk.Cy != location.cy {
		return fightWake{}, fmt.Errorf("fight wake: chunk %d,%d answered for %d,%d", chunk.Cx, chunk.Cy, cx, cy)
	}
	w := fightWake{location: location, key: fights.Key{World: world, Realm: chunk.Realm, Epoch: ep.Id, Layer: chunk.Layer, CX: chunk.Cx, CY: chunk.Cy}}
	if ep.EndsAt != nil {
		w.endsAt = int64(ep.EndsAt.Value * 1000)
	}
	for _, entity := range chunk.Entities {
		if entity.Kind != "camp" || len(entity.Enemies) == 0 {
			continue
		}
		// The projected cycle, held down while it fell (its fall stored or
		// still queued) or while a 0.8 claim's cleared row keeps its timer.
		at, err := a.CampAtWake(ctx, tx, w.key, entity.Id, now)
		if err != nil {
			return fightWake{}, err
		}
		w.camps = append(w.camps, fights.Camp{ID: entity.Id, Cycle: at.Cycle, X: float64(cx*int(chunk.Size)*16 + int(entity.Tx)*16 + 8), Y: float64(cy*int(chunk.Size)*16 + int(entity.Ty)*16 + 16), Kinds: append([]string(nil), entity.Enemies...), Fallen: at.Fallen, RespawnAt: at.RespawnAt})
	}
	// Campless chunks keep their ground too: a dash crosses chunk edges.
	ground, err := groundChanges(ctx, tx, world, ep, cx, cy, now.Unix())
	if err != nil {
		return fightWake{}, err
	}
	w.geometry = fights.GeometryAtWake(chunks.NewEffective(chunk, ground))
	return w, nil
}

// fightFell hands a camp's fall to F-F's durable writer, on the actor
// goroutine after the tick. The writer never blocks and never drops.
func (a *Server) fightFell(f fights.Fall) {
	if err := a.EnqueueFall(f); err != nil {
		a.logUnexpected("fight-fall", err)
	}
}

// coverFightRoom reports one covered room's player; callers hold h.mu.
func (h *presenceHub) coverFightRoom(p *presencePeer, room *presenceFightRoom) {
	token := h.fightObserver(p)
	if p.fightRooms == nil {
		p.fightRooms = map[uint32]*presenceFightRoom{}
	}
	join := p.fightRooms[room.handle] == nil
	p.fightRooms[room.handle] = room
	player := &fights.Player{ID: p.identity.ID, Observer: token, Seed: p.critSeed, X: p.pos.X, Y: p.pos.Y, Down: p.identity.Magic.Down, Kit: p.identity.Magic.Kit}
	if !room.actor.Submit(fights.Command{Player: player, Join: join}) && join {
		// Closing rooms and full queues are transient. Do not subscribe before
		// a cover is admitted; the next position report retries with a full join.
		delete(p.fightRooms, room.handle)
		delete(p.fightJoined, room.handle)
	}
}

var fightValidator = sync.OnceValue(func() protovalidate.Validator {
	v, err := protovalidate.New()
	if err != nil {
		panic(err)
	}
	return v
})

func validateFightInput(m *wire.PresenceMessage) error {
	if swing := m.GetFightSwing(); swing != nil {
		return fightValidator().Validate(swing)
	}
	if ability := m.GetAbility(); ability != nil && ability.Fight != nil {
		return fightValidator().Validate(ability.Fight)
	}
	return nil
}
func (h *presenceHub) refuseFight(p *presencePeer, counter uint32, reason wire.FightRefusedReason) {
	h.send(p, &wire.FightSwingResult{SwingCounter: counter, RefusedReason: reason})
}
func (h *presenceHub) takeFightCounter(p *presencePeer, counter uint32) bool {
	if p.hasCounter && !rules.FightCounterAhead(p.lastCounter, counter) {
		h.refuseFight(p, counter, wire.FightRefusedReason_FIGHT_REFUSED_REASON_STALE_COUNTER)
		return false
	}
	p.lastCounter, p.hasCounter = counter, true
	return true
}

// fightTouches: a blow from (x, y) that may reach `radius` touches the room's chunk.
func fightTouches(g fights.Geometry, x, y, radius float64) bool {
	size := float64(g.Size * fights.TilePixels)
	minX, minY := float64(g.CX*g.Size*fights.TilePixels), float64(g.CY*g.Size*fights.TilePixels)
	return x+radius >= minX && x-radius <= minX+size && y+radius >= minY && y-radius <= minY+size
}
func swingRadius(s *wire.FightSwing) float64 {
	tuning := content.CombatRules.GetAttack()
	// A slash's reach extends from the player's feet; a bolt's full flight is
	// bounded by its lifetime, not only its spawn. This also covers corners.
	if s.Kind == wire.FightSwingKind_FIGHT_SWING_KIND_BOLT {
		return fights.BoltRadius()
	}
	return tuning.GetSlashRadius() + math.Max(tuning.GetSlashOffsetX(), tuning.GetSlashOffsetY()) + tuning.GetOriginYOffset()
}

// sortedFightRooms: a peer's rooms in handle order, so dispatch is stable.
func sortedFightRooms(p *presencePeer) []*presenceFightRoom {
	handles := make([]uint32, 0, len(p.fightRooms))
	for handle := range p.fightRooms {
		handles = append(handles, handle)
	}
	sort.Slice(handles, func(i, j int) bool { return handles[i] < handles[j] })
	rooms := make([]*presenceFightRoom, 0, len(handles))
	for _, handle := range handles {
		rooms = append(rooms, p.fightRooms[handle])
	}
	return rooms
}

// handleFightSwing runs under h.mu; cost/counter/cooldown ownership lives here,
// once per socket. Each sim decides only its own enemies. A buffered gatherer
// returns one result and fills every unrecognised prediction with UNKNOWN.
func (h *presenceHub) handleFightSwing(p *presencePeer, s *wire.FightSwing) {
	if !h.takeFightCounter(p, s.SwingCounter) {
		return
	}
	now := h.now()
	_, _, outdoor := wildsRoomChunk(p.area)
	kit := p.identity.Magic.Kit
	if p.pos == nil || !outdoor || len(p.fightRooms) == 0 || p.identity.Magic.Down || s.Kind == wire.FightSwingKind_FIGHT_SWING_KIND_BOLT && kit.Class != "mage" || s.Kind == wire.FightSwingKind_FIGHT_SWING_KIND_SLASH && kit.Class == "mage" && !s.Tool {
		h.refuseFight(p, s.SwingCounter, wire.FightRefusedReason_FIGHT_REFUSED_REASON_NOT_ALLOWED)
		return
	}
	if !p.lastSwing.IsZero() && now.Sub(p.lastSwing) < time.Duration(kit.BasicAttackCooldown*float64(time.Second)) {
		h.refuseFight(p, s.SwingCounter, wire.FightRefusedReason_FIGHT_REFUSED_REASON_COOLDOWN)
		return
	}
	crit := s.Kind != wire.FightSwingKind_FIGHT_SWING_KIND_BOLT && rules.FightCrit(p.critSeed, s.SwingCounter, kit.CritChance)
	p.lastSwing = now
	h.fightAttack++
	attack := fights.Attack{ID: h.fightAttack, Player: p.fightToken, Crit: crit, Damage: kit.MeleeDamage}
	// Matches today's Projectiles: a mage's basic bolt uses meleeDamage and
	// never crits. Signatures arrive as casts and share the same counter.
	replies := make(chan []*wire.FightHitRow, len(p.fightRooms))
	pending := 0
	radius := swingRadius(s)
	if s.Kind == wire.FightSwingKind_FIGHT_SWING_KIND_BOLT {
		attack.Flight = h.boltFlight(p, s.X, s.Y, s.Facing.X, s.Facing.Y, now)
	}
	for _, room := range sortedFightRooms(p) {
		if !fightTouches(room.geometry, p.pos.X, p.pos.Y, radius) {
			continue
		}
		owned := attack
		owned.Swing = proto.Clone(s).(*wire.FightSwing)
		if h.submitFight(room, fights.Command{Attack: &owned, Result: replies}, attack.Flight) {
			pending++
		}
		// Partial dispatch must still gather the rooms which took the swing.
		// Missing predictions become UNKNOWN_ENEMY, without closing the socket.
	}
	if attack.Flight != nil {
		attack.Flight.Seal()
	}
	h.answerFight(p, s.SwingCounter, crit, s.Predicted, replies, pending)
}

// handleFightCast runs under h.mu, after allowAbility took the cast (its
// cooldown, reach and unlock are charged there, once): every awake room its
// effect can touch applies it, and one result answers the counter. The crit
// is the seed's roll; of the signatures only Shadowstep crits, at twice the
// kit's chance (fight-rules.ts snapstrike). A downed caster's cast lands
// nothing.
func (h *presenceHub) handleFightCast(p *presencePeer, event *wire.PresenceAbility) {
	cast := event.Fight
	ability, ok := content.AbilityFor(event.GetAbility())
	_, _, outdoor := wildsRoomChunk(p.area)
	if !ok || p.pos == nil || !outdoor || p.identity.Magic.Down {
		h.answerFight(p, cast.SwingCounter, false, cast.Predicted, nil, 0)
		return
	}
	kit := p.identity.Magic.Kit
	crit := ability.GetId() == "shadowstep" && rules.FightCrit(p.critSeed, cast.SwingCounter, 2*kit.CritChance)
	damage := 0.0
	if ability.GetKind() == "signature" {
		damage = kit.SignatureDamage
	}
	h.fightAttack++
	c := fights.Cast{Player: h.fightObserver(p), Ability: ability.GetId(), X: event.GetX(), Y: event.GetY(), Crit: crit, Damage: damage, ID: h.fightAttack}
	if c.Ability == "shadowstep" && cast.Facing != nil {
		// One dash for every room: worked out here over the 3x3's ground,
		// so the rooms on either side of a chunk edge strike at one end.
		ex, ey := h.fightGround(p, c.X, c.Y).Dash(c.X, c.Y, cast.Facing.X, cast.Facing.Y)
		c.Dash = &fights.Dash{X: ex - c.X, Y: ey - c.Y}
	}
	if c.Ability == "fingersnap" && cast.Facing != nil {
		c.Flight = h.boltFlight(p, c.X, c.Y, cast.Facing.X, cast.Facing.Y, h.now())
	}
	replies := make(chan []*wire.FightHitRow, len(p.fightRooms))
	pending := 0
	radius := fights.CastRadius(ability.GetId())
	for _, room := range sortedFightRooms(p) {
		if radius == 0 || radius > 0 && !fightTouches(room.geometry, c.X, c.Y, radius) {
			continue
		}
		owned := c
		owned.Fight = proto.Clone(cast).(*wire.FightCast)
		if h.submitFight(room, fights.Command{Cast: &owned, Result: replies}, c.Flight) {
			pending++
		}
	}
	if c.Flight != nil {
		c.Flight.Seal()
	}
	h.answerFight(p, cast.SwingCounter, crit, cast.Predicted, replies, pending)
}

// boltFlight is one bolt's single impact across the rooms it goes to: its
// launch instant, and how far it flies before the 3x3's walls or its
// lifetime stop it, worked out once here. Callers hold h.mu.
func (h *presenceHub) boltFlight(p *presencePeer, x, y, fx, fy float64, now time.Time) *fights.Flight {
	return fights.NewFlight(now.UnixMilli(), h.fightGround(p, x, y).BoltSamples(x, y, fx, fy))
}

// submitFight hands one room its copy of a swing or cast. A bolt's copy
// joins its flight first (the room's actor is woken when the flight
// decides), and leaves it again if the room cannot take it.
func (h *presenceHub) submitFight(room *presenceFightRoom, cmd fights.Command, flight *fights.Flight) bool {
	if flight != nil {
		actor := room.actor
		flight.Join(room.handle, func() { actor.Submit(fights.Command{Settle: true}) })
	}
	if room.actor.Submit(cmd) {
		return true
	}
	if flight != nil {
		flight.Withdraw(room.handle)
	}
	return false
}

// fightGround is the ground around (x, y) as this hub woke it: the peer's
// rooms and every known chunk of the 3x3 (campless ones too). A chunk it
// has not loaded, or beyond the frontier, is solid. Callers hold h.mu.
func (h *presenceHub) fightGround(p *presencePeer, x, y float64) fights.Ground {
	geometries := []fights.Geometry{}
	for _, room := range p.fightRooms {
		geometries = append(geometries, room.geometry)
	}
	tx, ty := wilds.TileOfPixel(x, y)
	cx, cy := wilds.ChunkOf(tx, ty)
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			location := fightLocation{world: p.identity.World, realm: content.WildsRules.GetRealm(), layer: 0, cx: int32(cx + dx), cy: int32(cy + dy)}
			if known, ok := h.fightLocations[location]; ok {
				geometries = append(geometries, known.geometry)
			}
		}
	}
	return fights.NewGround(geometries...)
}

// answerFight gathers the rooms that took a swing or cast off h.mu and sends
// its one FightSwingResult, with a row for every prediction.
func (h *presenceHub) answerFight(p *presencePeer, counter uint32, crit bool, predicted []*wire.FightTarget, replies chan []*wire.FightHitRow, pending int) {
	ctx := p.ctx
	token := p.fightToken
	predicted = append([]*wire.FightTarget(nil), predicted...)
	h.fightGathers.Add(1)
	go func() {
		defer h.fightGathers.Done()
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		hits, connected := gatherFightHits(ctx, replies, pending, timer.C)
		if !connected {
			return
		}
		for _, target := range predicted {
			found := false
			for _, row := range hits {
				if row.Room == target.Room && row.Enemy == target.Enemy {
					found = true
					break
				}
			}
			if !found {
				hits = append(hits, &wire.FightHitRow{Room: target.Room, Enemy: target.Enemy, RefusedReason: wire.FightRefusedReason_FIGHT_REFUSED_REASON_UNKNOWN_ENEMY})
			}
		}
		sort.Slice(hits, func(i, j int) bool {
			if hits[i].Room != hits[j].Room {
				return hits[i].Room < hits[j].Room
			}
			return hits[i].Enemy < hits[j].Enemy
		})
		h.mu.Lock()
		defer h.mu.Unlock()
		if h.peers[p.identity.ID] == p && p.fightToken == token {
			h.send(p, &wire.FightSwingResult{SwingCounter: counter, Crit: crit, Hits: hits})
		}
	}()
}

// A common reply queue preserves all completed rooms even if another room is
// stalled. Timeout ends the gather, not the response; its caller fills every
// unresolved prediction and sends one result. Only a disconnected socket exits.
func gatherFightHits(ctx context.Context, replies <-chan []*wire.FightHitRow, pending int, deadline <-chan time.Time) ([]*wire.FightHitRow, bool) {
	hits := []*wire.FightHitRow{}
	for pending > 0 {
		select {
		case rows := <-replies:
			hits = append(hits, rows...)
			pending--
		case <-ctx.Done():
			return nil, false
		case <-deadline:
			for pending > 0 {
				select {
				case rows := <-replies:
					hits = append(hits, rows...)
					pending--
				default:
					return hits, true
				}
			}
		}
	}
	return hits, true
}
