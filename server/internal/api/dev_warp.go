//go:build dev

package api

import (
	"encoding/json"
	"net/http"

	contract "glimway/server/internal/gen/glimway/v1"
)

// Dev mode (local playtesting, staging and e2e): POST /api/dev/warp
// {"x": px, "y": py} is a dev warp's server half. The warp itself is the
// client's (WorldScene.warpWilds: the hero goes there and reports it); this
// moves the caller's sight anchor (sight.go) there first, as a server's own
// move would, so the reads round the new spot answer. Nothing else changes:
// not the saved place, not the version. Outdoors, inside the border only.
// Compiled only into `-tags dev` builds and mounted by the dev server
// command (server/cmd/glimway-server/dev_routes.go) for callers with the
// hooks or the world lab.

// DevWarpPath is the route's path.
const DevWarpPath = "/api/dev/warp"

func (a *Server) DevWarp(w http.ResponseWriter, r *http.Request) {
	r, _ = a.withTxClock(r)
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if err := a.devWarp(w, r); err != nil {
		problem(w, err)
		return
	}
	write(w, 200, map[string]any{})
}

func (a *Server) devWarp(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		X float64 `json:"x"`
		Y float64 `json:"y"`
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&req); err != nil {
		return fail(400, "invalid-json")
	}
	where := &contract.Where{Area: outdoorsArea, X: req.X, Y: req.Y}
	if !finiteWhere(where) || !wildsWhereInside(where) {
		return fail(409, "beyond-border")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := a.requestTime(r.Context()).Unix()
	// The saved place stays the last seen, so the anchor stands where it is put,
	// with all the travel it may save: a report from before the warp, landing
	// after it, can't leave it stranded short of the hero.
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO player_sight(account_id,world_id,x,y,saved,at,seen_area,seen_x,seen_y) VALUES(?,?,?,?,?,?,?,?,?)
 ON CONFLICT(account_id) DO UPDATE SET world_id=excluded.world_id,x=excluded.x,y=excluded.y,saved=excluded.saved,at=excluded.at,seen_area=excluded.seen_area,seen_x=excluded.seen_x,seen_y=excluded.seen_y`,
		s.AccountID, s.WorldID, req.X, req.Y, sightSaved, now, s.State.Area, s.State.Position.X, s.State.Position.Y); err != nil {
		return err
	}
	return tx.Commit()
}
