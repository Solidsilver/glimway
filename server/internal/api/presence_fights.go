package api

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"fmt"
	"hash/fnv"
	"math"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"buf.build/go/protovalidate"
	"github.com/coder/websocket"
	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/fights"
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
}

// FightPrototypeChunk validates an opt-in camp id, e.g. camp:0:0:0.
// Its chunk must be in the Tangle and its generated mix must contain wisps
// only. Empty disables the prototype. This validates identity, not visibility.
func FightPrototypeChunk(id string) (cx, cy int, err error) {
	parts := strings.Split(id, ":")
	if len(parts) != 4 || parts[0] != "camp" {
		return 0, 0, fmt.Errorf("fight prototype must name camp:<cx>:<cy>:<slot>")
	}
	coords := [3]int{}
	for i := range 3 {
		v, e := strconv.Atoi(parts[i+1])
		if e != nil || strconv.Itoa(v) != parts[i+1] {
			return 0, 0, fmt.Errorf("invalid fight camp coordinates")
		}
		coords[i] = v
	}
	p := wilds.FootprintAt(coords[0], coords[1])
	if coords[2] < 0 || p == nil || p.GetId() != "tangle" {
		return 0, 0, fmt.Errorf("fight prototype must be a Tangle camp")
	}
	return coords[0], coords[1], nil
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
// The single configured chunk is the prototype's entire wake set; F-E can
// extend this adapter to load all camp-bearing chunks in the same 3x3.
func (a *Server) syncFightPresence(p *presencePeer) {
	campID := a.Config.FightPrototypeCamp
	if campID == "" {
		return
	}
	cx, cy, err := FightPrototypeChunk(campID)
	if err != nil {
		return
	}
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
	if intAbs(pcx-cx) > 1 || intAbs(pcy-cy) > 1 {
		h.leaveFights(p, true)
		h.mu.Unlock()
		return
	}
	world := p.identity.World
	location := fightLocation{world: world, realm: content.WildsRules.GetRealm(), layer: 0, cx: int32(cx), cy: int32(cy)}
	resolved, known := h.fightLocations[location]
	if known && resolved.endsAt > 0 && h.now().UnixMilli() >= resolved.endsAt {
		delete(h.fightLocations, location)
		delete(h.fightFailedWakes, resolved.key)
		known = false
	}
	var room *presenceFightRoom
	if known {
		// Exact physical identity: never choose a realm/layer/epoch by map order.
		key := fights.Key{World: world, Realm: location.realm, Layer: location.layer, CX: location.cx, CY: location.cy, Epoch: resolved.key.Epoch}
		if key == resolved.key {
			room = h.fightRooms[key]
			if room != nil && room.key != key {
				room = nil
			}
			if h.fightFailedWakes[key] {
				h.mu.Unlock()
				return
			}
		}
	}
	h.mu.Unlock()
	if room == nil {
		ctx, cancel := context.WithTimeout(p.ctx, 2*time.Second)
		defer cancel()
		tx, err := a.beginTx(ctx)
		if err != nil {
			a.logUnexpected("fight-wake", err)
			return
		}
		defer tx.Rollback()
		now := h.now()
		ep, err := a.epochAt(ctx, tx, world, cx, cy, now.Unix())
		if err != nil {
			a.logUnexpected("fight-wake", err)
			return
		}
		chunk, err := a.Config.Chunks.Chunk(ctx, tx, world, ep.Id, 0, int32(cx), int32(cy))
		if err != nil {
			a.logUnexpected("fight-wake", err)
			return
		}
		key := fights.Key{World: world, Realm: chunk.Realm, Epoch: ep.Id, Layer: chunk.Layer, CX: chunk.Cx, CY: chunk.Cy}
		ends := int64(0)
		if ep.EndsAt != nil {
			ends = int64(ep.EndsAt.Value * 1000)
		}
		// Stored camp bodies cannot change within this epoch. Commit newly
		// generated epoch/chunk identity before caching a deterministic refusal.
		failedWake := func() {
			if err := tx.Commit(); err != nil {
				a.logUnexpected("fight-wake", err)
				return
			}
			h.mu.Lock()
			defer h.mu.Unlock()
			h.fightLocations[location] = fightLocationEpoch{key: key, endsAt: ends}
			h.fightFailedWakes[key] = true
			a.Config.Logger.Printf("fight prototype unavailable: stored camp missing, empty or not wisp-only")
		}
		camps := []fights.Camp{}
		for _, entity := range chunk.Entities {
			if entity.Id != campID || entity.Kind != "camp" {
				continue
			}
			if len(entity.Enemies) == 0 {
				failedWake()
				return
			}
			for _, kind := range entity.Enemies {
				if kind != "wisp" {
					failedWake()
					return
				}
			}
			state, e := readEntityRow(ctx, tx, ep.Id, campID)
			if e != nil {
				a.logUnexpected("fight-wake", e)
				return
			}
			state = state.projected("camp", now.Unix())
			camps = append(camps, fights.Camp{ID: campID, Cycle: state.cycle, X: float64(cx*int(chunk.Size)*16 + int(entity.Tx)*16 + 8), Y: float64(cy*int(chunk.Size)*16 + int(entity.Ty)*16 + 16), Count: len(entity.Enemies), Fallen: state.state != "available"})
		}
		if len(camps) == 0 {
			failedWake()
			return
		}
		ground, err := groundChanges(ctx, tx, world, ep, cx, cy, now.Unix())
		if err != nil {
			a.logUnexpected("fight-wake", err)
			return
		}
		geometry := fights.GeometryAtWake(chunks.NewEffective(chunk, ground))
		if err = tx.Commit(); err != nil {
			a.logUnexpected("fight-wake", err)
			return
		}
		h.mu.Lock()
		if h.closing || h.peers[p.identity.ID] != p || p.identity.World != world || p.ctx.Err() != nil {
			h.mu.Unlock()
			return
		}
		if h.fightHandle == math.MaxUint32 {
			h.mu.Unlock()
			return
		} // never reuse a handle
		h.fightHandle++
		room = &presenceFightRoom{key: key, handle: h.fightHandle, geometry: geometry}
		h.fightRooms[key] = room
		h.fightLocations[location] = fightLocationEpoch{key: key, endsAt: ends}
		seed := fnv.New64a()
		fmt.Fprintf(seed, "%s/%s/%d/%d/%d/%s/%d/%d", key.World, key.Realm, key.Layer, key.CX, key.CY, key.Epoch, camps[0].Cycle, room.handle)
		sim := fights.NewRoom(key, room.handle, geometry, camps, seed.Sum64(), now, ends)
		created := room
		room.actor = fights.Start(sim, fights.ActorConfig{Now: h.now, Emit: func(out fights.Output) { a.fightOutput(created, out) }, Closed: func() { a.fightClosed(created) }})
		h.mu.Unlock()
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.peers[p.identity.ID] != p || p.ctx.Err() != nil || p.detached || p.identity.World != world || h.closing || p.pos == nil {
		return
	}
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
func fightTouches(g fights.Geometry, s *wire.FightSwing, x, y float64) bool {
	tuning := content.CombatRules.GetAttack()
	// A slash's reach extends from the player's feet; a bolt's full flight is
	// bounded by its lifetime, not only its spawn. This also covers corners.
	radius := tuning.GetSlashRadius() + math.Max(tuning.GetSlashOffsetX(), tuning.GetSlashOffsetY()) + tuning.GetOriginYOffset()
	if s.Kind == wire.FightSwingKind_FIGHT_SWING_KIND_BOLT {
		radius = float64(tuning.GetBoltSpeed()*tuning.GetBoltLifetimeSeconds()) + tuning.GetBoltRadius() + tuning.GetBoltSpawnOffsetX()
	}
	size := float64(g.Size * fights.TilePixels)
	minX, minY := float64(g.CX*g.Size*fights.TilePixels), float64(g.CY*g.Size*fights.TilePixels)
	return x+radius >= minX && x-radius <= minX+size && y+radius >= minY && y-radius <= minY+size
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
	// never crits. Signatures are F-E, and share the same socket counter.
	replies := make(chan []*wire.FightHitRow, len(p.fightRooms))
	pending := 0
	handles := []uint32{}
	for handle := range p.fightRooms {
		handles = append(handles, handle)
	}
	sort.Slice(handles, func(i, j int) bool { return handles[i] < handles[j] })
	for _, handle := range handles {
		room := p.fightRooms[handle]
		if !fightTouches(room.geometry, s, p.pos.X, p.pos.Y) {
			continue
		}
		owned := attack
		owned.Swing = proto.Clone(s).(*wire.FightSwing)
		if room.actor.Submit(fights.Command{Attack: &owned, Result: replies}) {
			pending++
		}
		// Partial dispatch must still gather the rooms which took the swing.
		// Missing predictions become UNKNOWN_ENEMY, without closing the socket.
	}
	ctx := p.ctx
	token := p.fightToken
	h.fightGathers.Add(1)
	go func() {
		defer h.fightGathers.Done()
		timer := time.NewTimer(2 * time.Second)
		defer timer.Stop()
		hits, connected := gatherFightHits(ctx, replies, pending, timer.C)
		if !connected {
			return
		}
		for _, target := range s.Predicted {
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
			h.send(p, &wire.FightSwingResult{SwingCounter: s.SwingCounter, Crit: crit, Hits: hits})
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
