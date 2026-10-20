//go:build dev

package main

import (
	"glimway/server/internal/api"
	"glimway/server/internal/location"
	"glimway/server/internal/settings"
	"glimway/server/internal/worldlab"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
)

// devBuild: this build has dev tools (go build -tags dev).
const devBuild = true

// devLog is the server log's shape, for dev mode's own lines.
var devLog = log.New(os.Stdout, "glimway ", log.LstdFlags|log.LUTC)

// everyTool is local dev's: every tool, for this machine.
var everyTool = settings.Tools{Grant: true, Hooks: true, Clock: true, FightFall: true, WorldLab: true}

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
// (server/internal/api/dev_grant.go), POST /api/dev/fight-fall
// (server/internal/api/dev_fights.go), POST /api/dev/warp (dev_warp.go) and
// the world lab under /api/dev/worldlab/ (server/internal/worldlab). Dev
// builds only; a caller without the tool finds no such route. (The clock's:
// dev_clock.go. Which tools a player has reaches the client in GET
// /api/web-settings.)
func devRoutes(a *api.Server, caller devCaller) func(http.Handler) http.Handler {
	lab := devWorldLab(a)
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			inLab := strings.HasPrefix(r.URL.Path, worldlab.Prefix)
			if r.URL.Path != api.DevGrantPath && r.URL.Path != api.DevFightFallPath && r.URL.Path != api.DevWarpPath && !inLab {
				next.ServeHTTP(w, r)
				return
			}
			w.Header().Set("X-Glimway-Now", strconv.FormatInt(a.Config.Now().Unix(), 10))
			w.Header().Set("Cache-Control", "no-store")
			tools := caller(r)
			switch {
			case inLab && tools.WorldLab && lab != nil:
				lab.ServeHTTP(w, r)
			case r.URL.Path == api.DevFightFallPath && tools.FightFall:
				a.DevFightFall(w, r)
			case r.URL.Path == api.DevWarpPath && (tools.Hooks || tools.WorldLab):
				a.DevWarp(w, r)
			case r.URL.Path == api.DevGrantPath && tools.Grant:
				a.DevGrant(w, r)
			default:
				http.NotFound(w, r)
			}
		})
	}
}

// worldLabWorker is the hidden command a world lab render runs in: this
// binary again, in a process of its own (server/internal/worldlab).
const worldLabWorker = "_worldlab-worker"

// devWorldLab is the world lab, its renders in workers of this binary.
func devWorldLab(a *api.Server) *worldlab.Lab {
	exe, err := os.Executable()
	if err != nil {
		devLog.Printf("world lab off: %v", err)
		return nil
	}
	// Every world has the same grid now (the world border, 0.14).
	onGrid := func(_ string, cx, cy int) bool { return location.OnGrid(cx, cy) }
	return worldlab.NewLab([]string{exe, worldLabWorker}, a.DevWorldLabHere, onGrid)
}

// devCommand runs a dev build's hidden commands (a world lab worker),
// before anything else: no settings, database or listener.
func devCommand(args []string) (bool, error) {
	if len(args) == 1 && args[0] == worldLabWorker {
		return true, worldlab.RunWorker(os.Stdin, os.Stdout)
	}
	return false, nil
}
