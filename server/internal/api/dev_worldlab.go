//go:build dev

package api

import (
	"glimway/content"
	"glimway/server/internal/store"
	"glimway/server/internal/worldlab"
	"net/http"
	"strconv"
)

// DevWorldLabHere is the signed-in caller's world, for the world lab's
// defaults (server/internal/worldlab, mounted by
// server/cmd/glimway-server/dev_routes.go): its seed, and the wick season
// the calendar is in now, the one its wick chunks are made at. It only
// reads, and doesn't refresh the session. World: the world's id, for
// whether a hero may stand somewhere (location.OnGrid). Dev
// builds only.
func (a *Server) DevWorldLabHere(r *http.Request) (worldlab.Here, bool) {
	c, err := r.Cookie(CookieName)
	if err != nil || len(c.Value) != 64 {
		return worldlab.Here{}, false
	}
	now := a.Config.Now().Unix()
	var world, seed string
	err = a.Store.DB.QueryRowContext(r.Context(), "SELECT w.id,w.seed FROM sessions s JOIN players p ON p.account_id=s.account_id JOIN worlds w ON w.id=p.world_id WHERE s.id_hash=? AND s.expires_at>? AND s.created_at>?",
		store.Hash(c.Value), now, now-int64(SessionTTL.Seconds())).Scan(&world, &seed)
	if err != nil {
		return worldlab.Here{}, false
	}
	day := content.CalendarAt(content.CalendarRules, now)
	return worldlab.Here{World: world, Seed: seed, Epoch: "t:" + strconv.FormatInt(day.StartsAt, 10) + ":" + strconv.FormatInt(day.NextTurning, 10)}, true
}
