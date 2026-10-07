package api

import (
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"slices"
	"strings"
)

// Witnessing (docs/home-server.md "Witnessing"). When a player's progress
// lands with one of the story's shared beats in it (speaking the naming to
// the Warden, settling an Echo, lighting the last lantern), the players
// standing near them in the same room see it: the hub sends each a
// "witness" message. It comes only from the server's own record of the
// beat, the doer's merge adding it, so it reaches each witness once per beat
// and doer (the merge only ever adds a beat once), and no client can send
// one. The witness's story doesn't move; their client keeps a journal line
// (a story flag, never a reward).

// WitnessTiles: how near (in tiles) a witness stands to the doer.
const WitnessTiles = 10

// echoMembers: the Six, whose Echoes settle in the Whitequiet
// (src/content/echoes.ts echoFlag).
var echoMembers = []string{"hollis", "tam", "bett", "dorrit", "joss", "nan"}

// storyBeats are the beats a merge added: "warden" (the quest reached
// guardian-defeated), "lantern" (lantern-lit) and "echo:<member>".
func storyBeats(before, after rules.State) []string {
	beats := []string{}
	stage := func(s rules.State) int { return slices.Index(rules.Stages, s.Quest) }
	for _, b := range []struct{ beat, stage string }{{"warden", "guardian-defeated"}, {"lantern", "lantern-lit"}} {
		at := slices.Index(rules.Stages, b.stage)
		if stage(before) < at && stage(after) >= at {
			beats = append(beats, b.beat)
		}
	}
	for _, m := range echoMembers {
		f := "echo:" + m
		if slices.Contains(after.Flags, f) && !slices.Contains(before.Flags, f) {
			beats = append(beats, f)
		}
	}
	return beats
}

// beatRoom: where a beat happens, as the doer's saved area and their
// presence room must both say. The Warden and the shrine lantern stand in
// Ashwatch Ruin; Echo camps in a Wilds chunk.
func beatRoom(beat, area, room string) bool {
	if strings.HasPrefix(beat, "echo:") {
		return area == "wilds" && strings.HasPrefix(room, "wilds:")
	}
	return area == "ruin" && room == "ruin"
}

// witnessed returns the after-commit relay for the beats an upload recorded.
func (a *Server) witnessed(s store.Snapshot, beats []string) func() {
	return func() {
		for _, b := range beats {
			a.presenceWitness(s.WorldID, s.HabiticaID, s.DisplayName, s.State.Area, b)
		}
	}
}

// presenceWitness sends the beat to every player connected in the doer's
// world and room who last stood within WitnessTiles of where the doer last
// stood. Nothing when the doer isn't standing in that room right now (an
// offline journey caught up later is no one's moment to see).
func (a *Server) presenceWitness(world, doer, name, area, beat string) {
	h := a.presence
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	p := h.peers[doer]
	if p == nil || p.detached || p.identity.World != world || p.pos == nil || !beatRoom(beat, area, p.area) {
		return
	}
	radius := float64(WitnessTiles * wildsTileSize)
	m := &contract.PresenceWitness{Beat: beat, HabiticaId: doer, Name: capDonor(name)}
	for _, q := range h.peers {
		if q == p || q.detached || q.identity.World != world || q.area != p.area || q.pos == nil || q.queue == nil {
			continue
		}
		dx, dy := q.pos.X-p.pos.X, q.pos.Y-p.pos.Y
		if dx*dx+dy*dy <= radius*radius {
			h.send(q, m)
		}
	}
}
