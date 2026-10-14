package api

import (
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
	q.area = "commons"
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
	for _, room := range []string{"outdoors:0:3", "outdoors:2:1", "outdoors:01:1", "outdoors", "wilds:0:0"} {
		if validPresenceRoom(room) {
			t.Fatal("off-grid or malformed room admitted", room)
		}
	}
	if !positionInsideFrontier("world", 40, 392) || positionInsideFrontier("world", 40, 1200) {
		t.Fatal("presence grid ignores fixed footprint")
	}
}
