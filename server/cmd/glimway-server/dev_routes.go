//go:build dev

package main

import (
	"glimway/server/internal/api"
	"glimway/server/internal/settings"
	"log"
	"net/http"
	"os"
	"strconv"
)

// devBuild: this build has dev tools (go build -tags dev).
const devBuild = true

// devLog is the server log's shape, for dev mode's own lines.
var devLog = log.New(os.Stdout, "glimway ", log.LstdFlags|log.LUTC)

// everyTool is local dev's: every tool, for this machine.
var everyTool = settings.Tools{Grant: true, Hooks: true, Clock: true, FightFall: true}

// devCallerFor is how a dev build decides who may use its tools.
func devCallerFor(a *api.Server, access devAccess) devCaller {
	return devCallerWith(a.DevCaller, access)
}

// devCallerWith decides it with who (api.Server.DevCaller: the request's
// signed-in Habitica account). With no settings file: callers on this
// machine, as local dev and e2e always had. With one: the dev tools the
// settings give that account (behind a proxy every caller is loopback, so
// the address says nothing).
func devCallerWith(who func(*http.Request) (string, bool), access devAccess) devCaller {
	return func(r *http.Request) settings.Tools {
		if !access.configured {
			if devLocal(r) {
				return everyTool
			}
			return settings.Tools{}
		}
		s := access.settings()
		if !s.Tools().Any() {
			return settings.Tools{}
		}
		id, ok := who(r)
		if !ok {
			return settings.Tools{}
		}
		return s.ToolsFor(id)
	}
}

// devRoutes mounts dev mode's routes: POST /api/dev/grant
// (server/internal/api/dev_grant.go) and POST /api/dev/fight-fall
// (server/internal/api/dev_fights.go). Dev builds only; a caller without
// the tool finds no such route. (The clock's: dev_clock.go. Which tools a
// player has reaches the client in GET /api/web-settings.)
func devRoutes(a *api.Server, caller devCaller) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != api.DevGrantPath && r.URL.Path != api.DevFightFallPath {
				next.ServeHTTP(w, r)
				return
			}
			w.Header().Set("X-Glimway-Now", strconv.FormatInt(a.Config.Now().Unix(), 10))
			w.Header().Set("Cache-Control", "no-store")
			tools := caller(r)
			switch {
			case r.URL.Path == api.DevFightFallPath && tools.FightFall:
				a.DevFightFall(w, r)
			case r.URL.Path == api.DevGrantPath && tools.Grant:
				a.DevGrant(w, r)
			default:
				http.NotFound(w, r)
			}
		})
	}
}
