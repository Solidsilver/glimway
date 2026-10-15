package api

import (
	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/location"
	"testing"
)

func TestCommonsPresenceWakesOnlyGeneratedFightRooms(t *testing.T) {
	x, p, _, _ := adapterFightFixture(t)
	h := x.api.presence
	// Join may lag the position at a chunk crossing. Coverage follows feet.
	for _, room := range []string{"outdoors:0:0", "outdoors:0:1"} {
		h.mu.Lock()
		p.area = room
		p.pos = &presencePosition{X: 40, Y: 392}
		h.mu.Unlock()
		x.api.syncFightPresence(p)
		h.mu.Lock()
		if len(p.fightRooms) != 1 {
			t.Fatalf("Commons player did not cover Tangle: %d rooms", len(p.fightRooms))
		}
		for _, r := range p.fightRooms {
			if r.key.CX != 0 || r.key.CY != 0 {
				t.Fatal("unexpected fight room", r.key)
			}
			if r.geometry.Safe == nil || !r.geometry.Safe(40, 384) || r.geometry.Safe(40, 383) {
				t.Fatal("wake geometry lacks seam safety")
			}
		}
		for loc := range h.fightLocations {
			if location.SourceOf(int(loc.cx), int(loc.cy)).Kind != location.SourceGenerated {
				t.Fatal("fixed Commons fight ground loaded", loc)
			}
		}
		h.mu.Unlock()
	}
	// Farther south the Commons no longer covers Tangle; no fixed room wakes.
	h.mu.Lock()
	p.area = "outdoors:0:2"
	p.pos = &presencePosition{X: 40, Y: 776}
	h.mu.Unlock()
	x.api.syncFightPresence(p)
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(p.fightRooms) != 0 {
		t.Fatal("Commons rooms woke", len(p.fightRooms))
	}
}

func TestTogetherAcrossOutdoorChunkEdges(t *testing.T) {
	h := newPresenceHub(nil, nil)
	p := &presencePeer{identity: presenceIdentity{ID: "a", World: "world"}, area: "outdoors:0:0", pos: &presencePosition{X: 40, Y: 383}}
	q := &presencePeer{identity: presenceIdentity{ID: "b", World: "world"}, area: "outdoors:0:1", pos: &presencePosition{X: 40, Y: 385}}
	h.peers[p.identity.ID], h.peers[q.identity.ID] = p, q
	if !h.together("world", "a", "b", 2) || h.together("world", "a", "b", 1) {
		t.Fatal("seam proximity")
	}
	q.area, q.pos = "outdoors:1:0", &presencePosition{X: 385, Y: 40}
	p.pos = &presencePosition{X: 383, Y: 40}
	if !h.together("world", "a", "b", 2) {
		t.Fatal("horizontal chunk proximity")
	}
	q.area = "in:village:library"
	if h.together("world", "a", "b", 2) {
		t.Fatal("different coordinate frames together")
	}
	q.area = "outdoors:1:0"
	q.identity.World = "other"
	if h.together("world", "a", "b", 2) {
		t.Fatal("different worlds together")
	}
	q.identity.World, q.detached = "world", true
	if h.together("world", "a", "b", 2) {
		t.Fatal("detached peer together")
	}
}

func TestFixedPresenceRoomsOnGrid(t *testing.T) {
	for _, room := range []string{"outdoors:-1:1", "outdoors:0:1", "outdoors:1:2"} {
		if !validPresenceRoom(room) {
			t.Fatal("fixed room refused", room)
		}
	}
	for _, room := range []string{"outdoors:5:4", "outdoors:5:1", "outdoors:01:1", "outdoors", "wilds:0:0"} {
		if validPresenceRoom(room) {
			t.Fatal("off-grid or malformed room admitted", room)
		}
	}
	if !positionInsideFrontier("world", 40, 392) || positionInsideFrontier("world", 2000, 3200) {
		t.Fatal("presence grid ignores fixed footprint")
	}
}

func TestSafeOriginsRefuseSwingsWithoutCooldown(t *testing.T) {
	for _, kind := range []wire.FightSwingKind{wire.FightSwingKind_FIGHT_SWING_KIND_SLASH, wire.FightSwingKind_FIGHT_SWING_KIND_BOLT} {
		for _, facing := range []*wire.FightFacing{{X: 1}, {X: -1}, {Y: 1}, {Y: -1}} {
			h := newPresenceHub(nil, nil)
			a := &Server{presence: h}
			p := unitFightPeer(t, h)
			if kind == wire.FightSwingKind_FIGHT_SWING_KIND_BOLT {
				p.identity.Magic.Kit.Class = "mage"
			}
			addUnitFightRoom(t, a, p, 1, 0, 40)
			// Last position is unsafe: refusal must use the reported origin.
			s := &wire.FightSwing{Kind: kind, X: 40, Y: 391, Facing: facing, SwingCounter: 1}
			h.mu.Lock()
			h.handleFightSwing(p, s)
			h.mu.Unlock()
			if got := queuedFightResult(t, p); got.RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_NOT_ALLOWED {
				t.Fatal(got)
			}
			if !p.lastSwing.IsZero() || h.fightAttack != 0 {
				t.Fatal("safe refusal consumed attack cooldown or dispatched")
			}
			s.Y, s.SwingCounter = 375, 2
			h.mu.Lock()
			h.handleFightSwing(p, s)
			h.mu.Unlock()
			if p.lastSwing.IsZero() || h.fightAttack != 1 {
				t.Fatal("unsafe swing refused after safe swing")
			}
			if kind == wire.FightSwingKind_FIGHT_SWING_KIND_SLASH {
				if got := queuedFightResult(t, p); got.RefusedReason != 0 {
					t.Fatal(got)
				}
			}
		}
	}
}

func TestSafeOriginsRefuseEnemyWorkingsBeforeCooldown(t *testing.T) {
	for _, tc := range []struct{ id, class string }{{"cleave", "warrior"}, {"stand", "warrior"}, {"fingersnap", "mage"}, {"kindle", "mage"}, {"shadowstep", "rogue"}, {"echo", "rogue"}, {"mend", "healer"}, {"ward-light", "healer"}} {
		t.Run(tc.id, func(t *testing.T) {
			h := newPresenceHub(nil, nil)
			p := unitFightPeer(t, h)
			p.pos = &presencePosition{X: 40, Y: 375}
			p.identity.Magic.Class, p.identity.Magic.LevelMark = tc.class, 40
			e := &wire.PresenceAbility{Ability: tc.id, X: 40, Y: 391}
			if got := h.allowAbility(p, h.now(), e); got != (tc.id == "ward-light") {
				t.Fatalf("safe %s allowed=%v", tc.id, got)
			}
			if tc.id == "ward-light" {
				return
			}
			e.Fight = &wire.FightCast{SwingCounter: 1}
			h.handleFightCast(p, e)
			if got := queuedFightResult(t, p); got.RefusedReason != wire.FightRefusedReason_FIGHT_REFUSED_REASON_NOT_ALLOWED {
				t.Fatal(got)
			}
			if h.fightAttack != 0 {
				t.Fatal("safe cast dispatched")
			}
			if !h.abilityReady[p.identity.ID][tc.id].IsZero() {
				t.Fatal("safe cast consumed cooldown")
			}
			e.Y = 375
			if !h.allowAbility(p, h.now(), e) {
				t.Fatal("unsafe cast refused after safe cast")
			}
		})
	}
}

func TestEchoWitnessGateFollowsFeetWithLaggingRoom(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	_, o := x.ready("olive")
	x.hero("bob", "Bob", "p1")
	_, b := x.ready("bob")
	x.stand(b.AccountID, o.WorldID, "outdoors:0:1", 40, 392)
	// Returning south with a stale generated room must not record the beat.
	x.stand(o.AccountID, o.WorldID, "outdoors:0:0", 40, 392)
	x.api.presenceWitness(o.WorldID, o.AccountID, o.DisplayName, "outdoors", "echo:hollis")
	if n := count(t, x.db, "SELECT count(*) FROM story_marks WHERE account_id=? AND mark LIKE 'witness:echo-hollis:%'", b.AccountID); n != 0 {
		t.Fatal("fixed feet recorded echo", n)
	}
	// Crossing north with a stale fixed room must still record it, including
	// the safe bystander on the Commons side of the seam.
	x.stand(o.AccountID, o.WorldID, "outdoors:0:1", 40, 372)
	x.api.presenceWitness(o.WorldID, o.AccountID, o.DisplayName, "outdoors", "echo:hollis")
	if n := count(t, x.db, "SELECT count(*) FROM story_marks WHERE account_id=? AND mark LIKE 'witness:echo-hollis:%'", b.AccountID); n != 1 {
		t.Fatal("generated feet lost echo", n)
	}
}
