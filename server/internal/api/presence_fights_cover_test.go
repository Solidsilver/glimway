package api

import (
	"context"
	"database/sql"
	"sync"
	"testing"
	"time"

	"glimway/server/internal/chunks"
	"glimway/server/internal/fights"
	chunkwire "glimway/server/internal/gen/glimway/v1"
	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/rules"
)

// Covers go to a room's actor under h.mu (coverFightRoom), so admission and
// withdrawal are ordered by the one lock. These guard what the scale review
// (.agent/REVIEW-1.md) found when covers were submitted after releasing it.

// coverFixture: a bare hub, one admitted peer standing in a room's chunk,
// and one actor-run room whose outputs fan out through the hub; joined
// reports each FightJoin the actor emitted.
func coverFixture(t *testing.T) (*presenceHub, *presencePeer, *presenceFightRoom, *fights.Room, <-chan struct{}) {
	t.Helper()
	now := time.UnixMilli(100000)
	h := newPresenceHub(nil, func() time.Time { return now })
	a := &Server{presence: h}
	ctx, cancel := context.WithCancel(context.Background())
	p := &presencePeer{identity: presenceIdentity{ID: "alice", World: "world", Magic: presenceMagic{Kit: rules.CombatKitFor(nil, "", 0)}}, ctx: ctx, cancel: cancel, queue: make(chan []byte, 16), area: "outdoors:0:0", pos: &presencePosition{X: 0, Y: 112}}
	h.admit(p)
	key := fights.Key{World: "world", Realm: "hearthwick", Epoch: "epoch"}
	g := fights.Geometry{Size: 24, Open: make([]bool, 24*24)}
	for i := range g.Open {
		g.Open[i] = true
	}
	room := &presenceFightRoom{key: key, handle: 1, geometry: g}
	sim := fights.NewRoom(key, 1, g, []fights.Camp{{ID: "camp", Kinds: []string{"wisp"}, X: 10, Y: 112}}, 1, now, 0)
	joined := make(chan struct{}, 16)
	room.actor = fights.Start(sim, fights.ActorConfig{Now: h.now, Ticks: make(chan time.Time), Emit: func(out fights.Output) {
		a.fightOutput(room, out)
		if _, ok := out.Message.(*wire.FightJoin); ok {
			joined <- struct{}{}
		}
	}})
	h.fightRooms[key] = room
	t.Cleanup(func() { cancel(); room.actor.Stop(); <-room.actor.Done() })
	return h, p, room, sim, joined
}
func awaitJoin(t *testing.T, joined <-chan struct{}) {
	t.Helper()
	select {
	case <-joined:
	case <-time.After(time.Second):
		t.Fatal("actor did not process the cover")
	}
}
func roomSleeps(h *presenceHub, room *presenceFightRoom, sim *fights.Room) bool {
	room.actor.Stop()
	<-room.actor.Done()
	return sim.ShouldClose(h.now().Add(fights.SleepAfter + time.Second))
}

// A removed peer's cover is withdrawn with it: the actor keeps no member
// the hub forgot, so the room can sleep.
func TestFightCoverWithdrawnWithRemovedPeer(t *testing.T) {
	h, p, room, sim, joined := coverFixture(t)
	h.mu.Lock()
	h.coverFightRoom(p, room)
	h.mu.Unlock()
	awaitJoin(t, joined)
	h.mu.Lock()
	p.stop(presenceReplaced, "replaced")
	h.remove(p)
	stillViewed := p.fightRooms[room.handle] != nil || room.viewers[p]
	h.mu.Unlock()
	if stillViewed {
		t.Fatal("removed peer still views the room")
	}
	if !roomSleeps(h, room, sim) {
		t.Fatal("removed peer remains an actor member; the room cannot sleep")
	}
}

// Covers reach the actor in hub-lock order: a fall committed under h.mu
// after an older cover is what the sim ends up with, never the older state.
func TestFightNewerCoverWinsUnderHubLock(t *testing.T) {
	h, p, room, sim, joined := coverFixture(t)
	h.mu.Lock()
	h.coverFightRoom(p, room)
	h.mu.Unlock()
	awaitJoin(t, joined)
	h.mu.Lock()
	p.identity.Magic.Down = true
	h.coverFightRoom(p, room)
	h.mu.Unlock()
	// A sentinel queued behind the cover: answered once the cover applied.
	applied := make(chan fights.Cleared, 1)
	if !room.actor.Submit(fights.Command{Clear: "absent", Cleared: applied}) {
		t.Fatal("sentinel refused")
	}
	<-applied
	room.actor.Stop()
	<-room.actor.Done()
	rows := sim.Slash(fights.Attack{Player: p.fightToken, Damage: 1, Swing: swingForPeer(p, &wire.FightTarget{Room: 1, Enemy: 0})}, h.now())
	if len(rows) != 0 {
		t.Fatalf("hub says Down=true but the sim accepted a slash: %v", rows)
	}
}

// A refused first join (full queue) leaves no view behind, under the same
// lock, so no later cover can be mistaken for it; the later accepted cover
// is kept, and withdrawn when the peer goes.
func TestFightRefusedJoinLeavesNoViewAndLaterCoverIsWithdrawn(t *testing.T) {
	h, p, room, sim, _ := coverFixture(t)
	room.actor.Stop()
	<-room.actor.Done()
	a := &Server{presence: h}
	entered, release := make(chan struct{}), make(chan struct{})
	joined := make(chan struct{}, 16)
	room.actor = fights.Start(sim, fights.ActorConfig{Now: h.now, Ticks: make(chan time.Time), Emit: func(out fights.Output) {
		if out.Observer == "blocker" {
			close(entered)
			<-release
			return
		}
		a.fightOutput(room, out)
		if _, ok := out.Message.(*wire.FightJoin); ok {
			joined <- struct{}{}
		}
	}})
	t.Cleanup(func() { room.actor.Stop(); <-room.actor.Done() })
	// A blocked actor and a full queue refuse the next cover.
	if !room.actor.Submit(fights.Command{Player: &fights.Player{ID: "blocker", Observer: "blocker"}}) {
		t.Fatal("blocker refused")
	}
	<-entered
	for range 127 {
		if !room.actor.Submit(fights.Command{}) {
			t.Fatal("could not fill the queue")
		}
	}
	drained := make(chan fights.Cleared, 1)
	if !room.actor.Submit(fights.Command{Clear: "absent", Cleared: drained}) {
		t.Fatal("sentinel refused")
	}
	h.mu.Lock()
	h.coverFightRoom(p, room)
	viewed := p.fightRooms[room.handle] != nil || room.viewers[p]
	h.mu.Unlock()
	if viewed {
		t.Fatal("refused first join left a view")
	}
	close(release)
	room.actor.Leave("blocker")
	<-drained
	h.mu.Lock()
	h.coverFightRoom(p, room)
	h.mu.Unlock()
	awaitJoin(t, joined)
	h.mu.Lock()
	kept := p.fightRooms[room.handle] == room && room.viewers[p] && p.fightJoined[room.handle]
	p.stop(presenceReplaced, "replaced")
	h.remove(p)
	h.mu.Unlock()
	if !kept {
		t.Fatal("accepted cover was not kept")
	}
	if !roomSleeps(h, room, sim) {
		t.Fatal("accepted member was not withdrawn with the peer")
	}
}

// blockingChunks holds the first chunk load until released, so a test can
// move the peer while a wake is in flight (h.fightLoad held, h.mu not).
type blockingChunks struct {
	chunks.ChunkSource
	entered, release chan struct{}
	once             sync.Once
}

func (c *blockingChunks) Chunk(ctx context.Context, tx *sql.Tx, world, epoch string, layer, cx, cy int32) (*chunkwire.WorldChunk, error) {
	c.once.Do(func() { close(c.entered); <-c.release })
	return c.ChunkSource.Chunk(ctx, tx, world, epoch, layer, cx, cy)
}

// A wake releases h.mu between scan and cover. A peer reconciled to a new
// 3x3 meanwhile is not covered for the old one: the sync scans again.
func TestFightWakeRescansWhenPeerMovedMeanwhile(t *testing.T) {
	x, p, _, _ := adapterFightFixture(t)
	source := &blockingChunks{ChunkSource: x.api.Config.Chunks, entered: make(chan struct{}), release: make(chan struct{})}
	x.api.Config.Chunks = source
	done := make(chan struct{})
	go func() { defer close(done); x.api.syncFightPresence(p) }()
	<-source.entered
	// Far from the 3x3 the wake is loading, still inside the frontier.
	h := x.api.presence
	h.mu.Lock()
	p.area = "outdoors:3:-4"
	p.pos = &presencePosition{X: 3*384 + 200, Y: -4*384 + 208}
	h.mu.Unlock()
	close(source.release)
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("sync did not finish")
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, room := range p.fightRooms {
		if intAbs(int(room.key.CX)-3) > 1 || intAbs(int(room.key.CY)+4) > 1 {
			t.Fatalf("stale 3x3 covered after the move: room %d,%d", room.key.CX, room.key.CY)
		}
	}
}

// Fixture peers obey the production index invariant: a replaced peer
// leaves its old world's index, and a removed one leaves the index.
func TestFixturePeersKeepWorldIndex(t *testing.T) {
	t.Run("replace_world", func(t *testing.T) {
		x := newRig(t)
		x.stand("fixture-peer", "old-world", "village", 10, 10)
		x.stand("fixture-peer", "new-world", "village", 10, 10)
		if x.api.presence.worlds["old-world"]["fixture-peer"] != nil {
			t.Fatal("stand left the replaced peer in its old world's index")
		}
	})
	t.Run("remove", func(t *testing.T) {
		x := newRig(t)
		x.stand("fixture-peer", "world", "village", 10, 10)
		x.stand("fixture-peer", "world", "", 0, 0)
		if x.api.presence.worlds["world"]["fixture-peer"] != nil {
			t.Fatal("stand removed the peer but kept it indexed")
		}
	})
}
