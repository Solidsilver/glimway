//go:build dev

package api

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"glimway/server/internal/fights"
)

// Dev mode (local playtesting and e2e fixtures only): POST
// /api/dev/fight-fall {"entity": "camp:<cx>:<cy>:<n>"} puts one live server
// camp down through its own room, as if its last blow landed now. The fall
// is the sim's: witnesses are the accounts covering that room (from the
// camp's first aggro, which the clear starts), and it goes to the durable
// writer (EnqueueFall) like any fall, then DrainFalls before answering. No
// claim, fall record or eligibility is written any other way. The caller's
// own socket must be covering the camp's awake room: a cold room is refused
// (409 not-here), never woken and never written around. A camp already down
// this cycle answers 200 with nothing new; an unknown camp 404. Compiled only into `-tags dev` builds and mounted by the
// dev server command (server/cmd/glimway-server/dev_routes.go) for callers
// on this machine, or for the accounts a settings file's [dev] table allows.

// DevFightFallPath is the route's path.
const DevFightFallPath = "/api/dev/fight-fall"

type devFightFall struct {
	Entity    string   `json:"entity"`
	Room      uint32   `json:"room"`
	Epoch     string   `json:"epoch"`
	Cycle     int64    `json:"cycle"`
	FellAt    int64    `json:"fellAt"`
	Witnesses []string `json:"witnesses"`
}

func (a *Server) DevFightFall(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	out, err := a.devFightFall(w, r)
	if err != nil {
		problem(w, err)
		return
	}
	write(w, 200, out)
}

// devCampChunk reads camp:<cx>:<cy>:<n>, the chunk the camp's room is keyed by.
func devCampChunk(id string) (int32, int32, bool) {
	parts := strings.Split(id, ":")
	if len(parts) != 4 || parts[0] != "camp" {
		return 0, 0, false
	}
	cx, e1 := strconv.ParseInt(parts[1], 10, 32)
	cy, e2 := strconv.ParseInt(parts[2], 10, 32)
	_, e3 := strconv.ParseUint(parts[3], 10, 32)
	return int32(cx), int32(cy), e1 == nil && e2 == nil && e3 == nil
}

func (a *Server) devFightFall(w http.ResponseWriter, r *http.Request) (devFightFall, error) {
	var req struct {
		Entity string `json:"entity"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return devFightFall{}, fail(400, "invalid-json")
	}
	cx, cy, ok := devCampChunk(req.Entity)
	if !ok {
		return devFightFall{}, fail(404, "entity-not-found")
	}
	// Who is asking; the transaction ends before the room or the writer is
	// touched (the store has one connection, and the writer needs it).
	tx, err := a.beginTx(r.Context())
	if err != nil {
		return devFightFall{}, err
	}
	account, _, err := a.auth(r.Context(), tx, r)
	tx.Rollback()
	if err != nil {
		return devFightFall{}, err
	}
	h := a.presence
	h.mu.Lock()
	var room *presenceFightRoom
	if p := h.peers[account]; p != nil && !p.detached && p.ctx.Err() == nil {
		for handle, candidate := range p.fightRooms {
			if p.fightJoined[handle] && candidate.key.CX == cx && candidate.key.CY == cy {
				room = candidate
			}
		}
	}
	h.mu.Unlock()
	if room == nil {
		return devFightFall{}, fail(409, "not-here")
	}
	cleared := make(chan fights.Cleared, 1)
	if !room.actor.Submit(fights.Command{Clear: req.Entity, Cleared: cleared}) {
		return devFightFall{}, fail(409, "not-here")
	}
	var answer fights.Cleared
	select {
	case answer = <-cleared:
	case <-time.After(2 * time.Second):
		return devFightFall{}, errors.New("dev fight-fall: room did not answer")
	case <-r.Context().Done():
		return devFightFall{}, r.Context().Err()
	}
	if !answer.Found {
		return devFightFall{}, fail(404, "entity-not-found")
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()
	if err := a.DrainFalls(ctx); err != nil {
		return devFightFall{}, err
	}
	f := answer.Fall
	if !answer.Fresh {
		// Already down this cycle: idempotent, nothing new is written.
		return devFightFall{Entity: f.Camp, Room: room.handle, Epoch: f.Key.Epoch, Cycle: f.Cycle, Witnesses: []string{}}, nil
	}
	a.Config.Logger.Printf("dev fight-fall account=%s camp=%s cycle=%d witnesses=%d", account, f.Camp, f.Cycle, len(f.Witnesses))
	return devFightFall{Entity: f.Camp, Room: room.handle, Epoch: f.Key.Epoch, Cycle: f.Cycle, FellAt: f.At, Witnesses: f.Witnesses}, nil
}
