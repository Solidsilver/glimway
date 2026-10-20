//go:build dev

package main

import (
	"glimway/server/internal/api"
	"glimway/server/internal/settings"
	"net/http"
	"strings"
	"testing"
	"time"
)

// The world lab answers only an account the settings give it (or this
// machine with no settings file); everyone else finds no route.
func TestDevWorldLabIsGatedLikeTheOtherTools(t *testing.T) {
	a := &api.Server{Config: api.Config{Now: func() time.Time { return time.Unix(1234, 0) }}}
	off := false
	conf := settings.Default()
	conf.Dev.Enable, conf.Dev.Accounts = true, []string{devOwner}
	h := devRoutes(a, configuredCaller(&conf))(inner)
	state := func(account, remote string) int {
		return devRequest(h, http.MethodGet, "/api/dev/worldlab/state", "", remote, account).Code
	}
	if got := state(devOwner, "127.0.0.1:5000"); got != http.StatusOK {
		t.Fatal("the allowed account was refused:", got)
	}
	if got := state(devOther, "127.0.0.1:5000"); got != http.StatusNotFound {
		t.Fatal("another account reached the lab:", got)
	}
	if got := state("", "127.0.0.1:5000"); got != http.StatusNotFound {
		t.Fatal("a caller without a session reached the lab:", got)
	}
	render := devRequest(h, http.MethodPost, "/api/dev/worldlab/render", `{"view":"atlas"}`, "127.0.0.1:5000", devOther, "Content-Type", "application/json")
	if render.Code != http.StatusNotFound {
		t.Fatal("another account reached a render:", render.Code)
	}
	conf.Server.Dev.WorldLab = &off
	if got := state(devOwner, "127.0.0.1:5000"); got != http.StatusNotFound {
		t.Fatal("the lab answered with world_lab = false:", got)
	}
	local := devRoutes(a, localCaller)(inner)
	if w := devRequest(local, http.MethodGet, "/api/dev/worldlab/state", "", "203.0.113.9:5000", ""); w.Code != http.StatusNotFound {
		t.Fatal("a caller elsewhere reached the local lab:", w.Code)
	}
	if w := devRequest(local, http.MethodGet, "/api/dev/worldlab/state", "", "127.0.0.1:5000", ""); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"rules"`) {
		t.Fatal("this machine didn't reach the local lab:", w.Code)
	}
	if ok, _ := devCommand([]string{"-listen", "x"}); ok {
		t.Fatal("ordinary flags ran a hidden command")
	}
}
