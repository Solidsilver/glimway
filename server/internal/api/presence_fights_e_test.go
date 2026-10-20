package api

import (
	"context"
	"database/sql"
	"testing"
	"time"

	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/fights"
	chunkwire "glimway/server/internal/gen/glimway/v1"
	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/location"
	"glimway/server/internal/rules"
	"glimway/server/internal/wilds"
	"google.golang.org/protobuf/proto"
)

// beetleCampSource gives camp:0:0:0 a mixed beetle camp; every other chunk
// keeps its generated camp.
type beetleCampSource struct{ chunks.ChunkSource }

func (s beetleCampSource) Chunk(ctx context.Context, tx *sql.Tx, world, epoch string, layer, cx, cy int32) (*chunkwire.WorldChunk, error) {
	c, err := s.ChunkSource.Chunk(ctx, tx, world, epoch, layer, cx, cy)
	if err != nil || cx != 0 || cy != 0 {
		return c, err
	}
	c = proto.Clone(c).(*chunkwire.WorldChunk)
	for _, e := range c.Entities {
		if e.Kind == "camp" {
			e.Enemies = []string{"beetle", "wisp"}
		}
	}
	return c, nil
}

// camplessChunks strips every camp, for tests that walk the Wilds without fights.
type camplessChunks struct{ chunks.ChunkSource }

func (s camplessChunks) Chunk(ctx context.Context, tx *sql.Tx, world, epoch string, layer, cx, cy int32) (*chunkwire.WorldChunk, error) {
	c, err := s.ChunkSource.Chunk(ctx, tx, world, epoch, layer, cx, cy)
	if err != nil {
		return nil, err
	}
	c = proto.Clone(c).(*chunkwire.WorldChunk)
	c.Entities = withoutCamps(c.Entities)
	return c, nil
}

// Every chunk with a camp in the physical 3x3 wakes its own room, beetle
// mixes included, with no opt-in; a second report loads nothing again.
func TestFightEveryCampChunkInThe3x3Wakes(t *testing.T) {
	x, p, _, _ := adapterFightFixture(t)
	counter := x.api.Config.Chunks.(*fightChunkCounter)
	x.api.Config.Chunks = beetleCampSource{ChunkSource: counter.ChunkSource}
	x.api.syncFightPresence(p)
	want := 0
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			if wilds.InsideBorder(dx, dy) && location.SourceOf(dx, dy).Kind == location.SourceGenerated {
				want++
			}
		}
	}
	if want < 2 {
		t.Fatal("fixture has too few chunks inside the border", want)
	}
	joins := map[[2]int32]*wire.FightJoin{}
	for len(joins) < want {
		j := queuedFightFrame(t, p).GetFightJoin()
		if j == nil {
			continue
		}
		if j.RoomKey.Realm != content.WildsRules.GetRealm() || j.RoomKey.Epoch == "" || len(j.Enemies) == 0 {
			t.Fatal("bad join", j)
		}
		joins[[2]int32{j.RoomKey.Cx, j.RoomKey.Cy}] = j
	}
	home := joins[[2]int32{0, 0}]
	if home == nil || len(home.Enemies) != 2 || home.Enemies[0].Kind != wire.FightEnemyKind_FIGHT_ENEMY_KIND_BEETLE || home.Enemies[0].MaxHp != content.EnemyRules.GetBeetle().GetHp() {
		t.Fatal("beetle camp did not wake", home)
	}
	h := x.api.presence
	h.mu.Lock()
	rooms := len(h.fightRooms)
	h.mu.Unlock()
	if rooms != want || len(p.fightRooms) != want {
		t.Fatal("rooms", rooms, len(p.fightRooms), want)
	}
	x.api.syncFightPresence(p)
	h.mu.Lock()
	again := len(h.fightRooms)
	h.mu.Unlock()
	if again != want {
		t.Fatal("second report woke more rooms", again)
	}
}

func castFor(ability string, x, y, fx float64, counter uint32, predicted ...*wire.FightTarget) *wire.PresenceAbility {
	tick, _ := rules.FightTickAt(100000)
	return &wire.PresenceAbility{Ability: ability, X: x, Y: y, Fight: &wire.FightCast{Facing: &wire.FightFacing{X: fx}, SeenTick: tick, SwingCounter: counter, Predicted: predicted}}
}

// handleFightCast sends a cast to every room its effect can touch and
// answers once; the sim applies effects only (signature damage, no crit for
// Cleave), Stand and Echo reach every room, Ward-light none, and a downed
// caster's cast lands nothing.
func TestFightCastRoutesEffectsAndAnswersOnce(t *testing.T) {
	h := newPresenceHub(nil, func() time.Time { return time.UnixMilli(100000) })
	a := &Server{presence: h}
	p := unitFightPeer(t, h)
	p.identity.Magic.Kit.SignatureDamage = 4
	p.identity.Magic.Kit.CritChance = 1 // a Cleave still never crits
	addUnitFightRoom(t, a, p, 1, -1, -10)
	addUnitFightRoom(t, a, p, 2, 0, 10)
	h.mu.Lock()
	h.handleFightCast(p, castFor("cleave", 0, 112, 1, 1, &wire.FightTarget{Room: 2, Enemy: 0}))
	h.mu.Unlock()
	result := queuedFightResult(t, p)
	if result.SwingCounter != 1 || result.Crit || len(result.Hits) != 2 || result.Hits[0].Room != 1 || result.Hits[1].Damage != 4 {
		t.Fatal("cleave across both rooms", result)
	}
	for _, ability := range []string{"stand", "echo", "kindle", "ward-light"} {
		h.mu.Lock()
		h.handleFightCast(p, castFor(ability, 0, 112, 1, 2))
		h.mu.Unlock()
		if r := queuedFightResult(t, p); r.RefusedReason != 0 || len(r.Hits) != 0 {
			t.Fatal(ability, r)
		}
	}
	if fights.CastRadius("stand") >= 0 || fights.CastRadius("ward-light") != 0 {
		t.Fatal("routing radius")
	}
	p.identity.Magic.Down = true
	h.mu.Lock()
	h.handleFightCast(p, castFor("cleave", 0, 112, 1, 3, &wire.FightTarget{Room: 2, Enemy: 0}))
	h.mu.Unlock()
	if r := queuedFightResult(t, p); len(r.Hits) != 1 || r.Hits[0].RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_UNKNOWN_ENEMY {
		t.Fatal("downed caster struck", r)
	}
	h.fightGathers.Wait()
}

// Over the socket: allowAbility is the one cost owner. An allowed Cleave
// relays and strikes the server camp; the same move inside its cooldown is
// refused NOT_ALLOWED, and a repeated counter STALE_COUNTER.
func TestFightSocketCastsGoThroughAllowAbility(t *testing.T) {
	x := newRig(t)
	warrior := profile("alice", 20, 0, 20)
	class := "warrior"
	warrior.Class = &class
	x.set(warrior)
	c, s := x.ready("alice")
	x.api.Config.Chunks = &fightChunkCounter{ChunkSource: x.api.Config.Chunks}
	cfg := presenceTestConfig()
	cfg.RevalidateMs = 10000
	ts := startPresence(t, x, cfg)
	w := wsConnect(t, ts, c, s.Lease)
	w.join("outdoors:0:0")
	w.send(map[string]any{"type": "pos", "x": 185, "y": 208, "facing": map[string]any{"x": 1, "y": 0}, "moving": false})
	join := socketFight(t, w, "fightJoin").GetFightJoin()
	h := x.api.presence
	h.mu.Lock()
	kit := h.peers[x.account("alice")].identity.Magic.Kit
	h.mu.Unlock()
	tick, _ := rules.FightTickAt(x.now.Load() * 1000)
	cleave := &wire.PresenceAbility{Ability: "cleave", X: 185, Y: 208, Fight: &wire.FightCast{Facing: &wire.FightFacing{X: 1}, SeenTick: tick, Predicted: []*wire.FightTarget{{Room: join.Room, Enemy: 0}}}}
	writeFight(t, w, cleave)
	hit := socketFight(t, w, "fightSwingResult").GetFightSwingResult()
	if hit.RefusedReason != 0 || hit.Crit || len(hit.Hits) != 1 || hit.Hits[0].RefusedReason != 0 || hit.Hits[0].Damage != kit.SignatureDamage {
		t.Fatal("allowed cleave", hit, kit.SignatureDamage)
	}
	again := proto.Clone(cleave).(*wire.PresenceAbility)
	again.Fight.SwingCounter = 1
	writeFight(t, w, again)
	if r := socketFight(t, w, "fightSwingResult").GetFightSwingResult(); r.SwingCounter != 1 || r.RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_NOT_ALLOWED {
		t.Fatal("cooldown cast was not refused", r)
	}
	writeFight(t, w, again)
	if r := socketFight(t, w, "fightSwingResult").GetFightSwingResult(); r.RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_STALE_COUNTER {
		t.Fatal("repeated counter", r)
	}
}
