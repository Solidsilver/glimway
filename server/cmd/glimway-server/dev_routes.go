//go:build dev

package main

import (
	"glimway/server/internal/api"
	"net/http"
	"strconv"
)

// devRoutes mounts dev mode's routes (local playtesting): POST
// /api/dev/grant (server/internal/api/dev_grant.go) and POST
// /api/dev/fight-fall (server/internal/api/dev_fights.go). Dev builds only,
// for callers on this machine; anyone else finds no such route.
func devRoutes(a *api.Server) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != api.DevGrantPath && r.URL.Path != api.DevFightFallPath {
				next.ServeHTTP(w, r)
				return
			}
			w.Header().Set("X-Glimway-Now", strconv.FormatInt(a.Config.Now().Unix(), 10))
			if !devLocal(r) {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Cache-Control", "no-store")
			if r.URL.Path == api.DevFightFallPath {
				a.DevFightFall(w, r)
				return
			}
			a.DevGrant(w, r)
		})
	}
}
