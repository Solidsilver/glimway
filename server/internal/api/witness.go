package api

import (
	"context"
	"fmt"
	contract "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/store"
	"strings"
	"unicode"
)

// Story operations relay a beat after commit. Nearby connected peers receive
// a server-owned journal mark; each witness and doer pair records it once.

// WitnessTiles: how near (in tiles) a witness stands to the doer.
const WitnessTiles = 10

// echoMembers: the Six, whose Echoes settle in the Whitequiet
// (src/content/echoes.ts echoFlag).
var echoMembers = []string{"hollis", "tam", "bett", "dorrit", "joss", "nan"}

// beatRoom: where a beat happens, as the doer's saved area and their
// presence room must both say. The Warden and the shrine lantern stand in
// Ashwatch Ruin; Echo camps in a Wilds chunk.
func beatRoom(beat, area, room string) bool {
	if strings.HasPrefix(beat, "echo:") {
		return strings.HasPrefix(area, "wilds:") && strings.HasPrefix(room, area+":")
	}
	return area == "ruin" && room == "ruin"
}

// witnessed returns the after-commit relay for an operation's beats.
func (a *Server) witnessed(s store.Snapshot, beats []string) func() {
	return func() {
		for _, b := range beats {
			a.presenceWitness(s.WorldID, s.AccountID, s.DisplayName, s.State.Area, b)
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
	encoded, err := encodePresence(&contract.PresenceWitness{Beat: beat, AccountId: doer, Name: capDonor(name)})
	h.mu.Lock()

	p := h.peers[doer]
	if p == nil || p.detached || p.identity.World != world || p.pos == nil || !beatRoom(beat, area, p.area) {
		h.mu.Unlock()
		return
	}
	radius := float64(WitnessTiles * wildsTileSize)
	var witnesses []*presencePeer
	for _, q := range h.peers {
		if q == p || q.detached || q.identity.World != world || q.area != p.area || q.pos == nil || q.queue == nil {
			continue
		}
		dx, dy := q.pos.X-p.pos.X, q.pos.Y-p.pos.Y
		if dx*dx+dy*dy <= radius*radius {
			witnesses = append(witnesses, q)
		}
	}
	h.mu.Unlock()
	if err != nil {
		return
	}
	ctx := context.Background()
	tx, e := a.Store.DB.BeginTx(ctx, nil)
	if e != nil {
		return
	}
	defer tx.Rollback()
	delivered := []*presencePeer{}
	for _, q := range witnesses {
		mark := witnessMark(beat, doer, name)
		if mark == "" {
			continue
		}
		prefix := "witness:" + strings.Replace(beat, ":", "-", 1) + ":"
		doerPrefix := prefix + doer + ":"
		var count, already int
		if e := tx.QueryRowContext(ctx, "SELECT count(*),COALESCE(SUM(substr(mark,1,?)=?),0) FROM story_marks WHERE account_id=? AND substr(mark,1,?)=?", len(doerPrefix), doerPrefix, q.identity.ID, len(prefix), prefix).Scan(&count, &already); e != nil {
			return
		}
		if count >= 5 || already > 0 {
			continue
		}
		res, e := tx.ExecContext(ctx, "INSERT OR IGNORE INTO story_marks VALUES(?,?,'server',?)", q.identity.ID, mark, a.Config.Now().Unix())
		if e != nil {
			return
		}
		added, e := res.RowsAffected()
		if e != nil {
			return
		}
		if added == 1 {
			s := store.Snapshot{AccountID: q.identity.ID}
			if e = store.BumpVersion(ctx, tx, &s); e != nil {
				return
			}
			delivered = append(delivered, q)
		}
	}
	if e = tx.Commit(); e != nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, q := range delivered {
		if !q.detached {
			h.enqueue(q, encoded)
		}
	}
}

// Same construction as src/content/witness.ts witnessFlag; byte cuts keep whole runes.
func witnessMark(beat, doer, name string) string {
	if doer == "" || strings.Contains(doer, ":") {
		return ""
	}
	prefix := fmt.Sprintf("witness:%s:%s:", strings.Replace(beat, ":", "-", 1), doer)
	if len(prefix) > 256 {
		return ""
	}
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, name))
	runes := []rune(name)
	if len(runes) > 40 {
		name = string(runes[:40])
	}
	name = strings.TrimSpace(name)
	if name == "" {
		name = "A fellow traveler"
	}
	used := 0
	for _, r := range name {
		n := len(string(r))
		if len(prefix)+used+n > 256 {
			break
		}
		used += n
	}
	return prefix + strings.TrimRightFunc(name[:used], unicode.IsSpace)
}
