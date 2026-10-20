//go:build dev

package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"glimway/server/internal/api"
	"glimway/server/internal/settings"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// localCaller is a dev build with no settings file: this machine only.
var localCaller = devCallerWith(func(*http.Request) (string, bool) { return "", false }, devAccess{})

const (
	devOwner = "0f9d6d9e-7c55-4b8e-9d3a-2a1c3b4d5e6f"
	devOther = "1f9d6d9e-7c55-4b8e-9d3a-2a1c3b4d5e6f"
)

// configuredCaller is a deployed dev server: the settings `conf`, and a
// session cookie "hab" naming its Habitica account.
func configuredCaller(conf *settings.Settings) devCaller {
	who := func(r *http.Request) (string, bool) {
		c, err := r.Cookie("hab")
		if err != nil {
			return "", false
		}
		return c.Value, true
	}
	return devCallerWith(who, devAccess{configured: true, settings: func() settings.Settings { return *conf }})
}

func devRequest(h http.Handler, method, path, body, remote, account string, header ...string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = remote
	if account != "" {
		r.AddCookie(&http.Cookie{Name: "hab", Value: account})
	}
	for i := 0; i+1 < len(header); i += 2 {
		r.Header.Set(header[i], header[i+1])
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

// webTools is the dev part of GET /api/web-settings for a request (nil: none).
func webTools(t *testing.T, conf settings.Settings, caller devCaller, movable bool, r *http.Request) *settings.Tools {
	t.Helper()
	live := &liveSettings{}
	live.cur.Store(&conf)
	b, err := json.Marshal(webSettings(live, caller, movable)(r))
	if err != nil {
		t.Fatal(err)
	}
	var out struct{ Dev *settings.Tools }
	if err = json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out.Dev
}

func webRequest(remote, account string, header ...string) *http.Request {
	r := httptest.NewRequest(http.MethodGet, "/api/web-settings", nil)
	r.RemoteAddr = remote
	if account != "" {
		r.AddCookie(&http.Cookie{Name: "hab", Value: account})
	}
	for i := 0; i+1 < len(header); i += 2 {
		r.Header.Set(header[i], header[i+1])
	}
	return r
}

// With no settings file a forwarded request isn't this machine's: a proxy on
// this host (Caddy) connects from loopback for everyone.
func TestDevLocalRefusesProxiedCallers(t *testing.T) {
	conf := settings.Default()
	if got := webTools(t, conf, localCaller, true, webRequest("127.0.0.1:5000", "")); got == nil || *got != everyTool {
		t.Fatal("this machine has no tools:", got)
	}
	if got := webTools(t, conf, localCaller, false, webRequest("[::1]:5000", "")); got == nil || got.Clock {
		t.Fatal("a clock tool without a movable clock:", got)
	}
	a := &api.Server{Config: api.Config{Now: func() time.Time { return time.Unix(1234, 0) }}}
	for _, h := range []string{"X-Forwarded-For", "Forwarded"} {
		if got := webTools(t, conf, localCaller, true, webRequest("127.0.0.1:5000", "", h, "203.0.113.9")); got != nil {
			t.Fatal("a proxied caller got tools through", h)
		}
		if w := devRequest(devRoutes(a, localCaller)(inner), http.MethodPost, api.DevGrantPath, `{}`, "127.0.0.1:5000", "", h, "203.0.113.9"); w.Code != 404 {
			t.Fatal("a proxied caller reached the grant route through", h, w.Code)
		}
	}
}

// With a settings file, the settings decide per account; the address says nothing.
func TestDevConfiguredGatesOnSettingsAndAccounts(t *testing.T) {
	conf := settings.Default()
	caller := configuredCaller(&conf)
	c := devSetupConfigured(t)
	a := &api.Server{Config: api.Config{Now: c.now}}
	h := c.mount(devRoutes(a, caller)(inner), caller)
	tools := func(account string) *settings.Tools {
		return webTools(t, conf, caller, c.movable, webRequest("127.0.0.1:5000", account))
	}
	clock := func(account string) int {
		return devRequest(h, http.MethodPost, devClockPath, `{"advance_seconds":60}`, "127.0.0.1:5000", account).Code
	}
	// Dev mode off: nothing, even from loopback, even signed in.
	if tools(devOwner) != nil || clock(devOwner) != 404 {
		t.Fatal("dev tools answered with dev mode off")
	}
	conf.Dev.Enable = true
	if got := tools(devOwner); got == nil || *got != everyTool {
		t.Fatal(got)
	}
	if tools("") != nil || clock("") != 404 {
		t.Fatal("a caller without a session reached the tools")
	}
	if clock(devOwner) != 200 {
		t.Fatal("the clock didn't move for an allowed account")
	}
	// A tool switched off on its own, on either side.
	off := false
	conf.Server.Dev.Clock = &off
	conf.Web.Dev.Hooks = &off
	if got := tools(devOwner); got == nil || got.Clock || got.Hooks || !got.Grant || clock(devOwner) != 404 {
		t.Fatal("clock = false or hooks = false not applied", got)
	}
	if w := devRequest(h, http.MethodPost, api.DevGrantPath, `{}`, "127.0.0.1:5000", "", "Content-Type", "application/json"); w.Code != 404 {
		t.Fatal("the grant route answered a caller without a session:", w.Code)
	}
	// The accounts list.
	conf.Dev.Accounts = []string{devOwner}
	if tools(devOther) != nil {
		t.Fatal("an account off the list got the tools")
	}
	if got := tools(strings.ToUpper(devOwner)); got == nil || !got.Grant {
		t.Fatal("the listed account lost the tools")
	}
}

func devSetupConfigured(t *testing.T) clockSetup {
	t.Helper()
	f := flag.NewFlagSet("test", flag.ContinueOnError)
	start := devClock(f)
	if err := f.Parse(nil); err != nil {
		t.Fatal(err)
	}
	c, err := start(true)
	if err != nil {
		t.Fatal(err)
	}
	if !c.movable || time.Since(c.now()).Abs() > time.Second {
		t.Fatal("a configured dev build's clock should be movable, from now")
	}
	return c
}

// SIGHUP's reload: live settings change, a bad file changes nothing, and a
// startup setting waits for the restart.
func TestDevSettingsReload(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.toml")
	write := func(s string) {
		if err := os.WriteFile(path, []byte(s), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	write("")
	conf, err := settings.Load(path, envLookup, devBuild)
	if err != nil {
		t.Fatal(err)
	}
	live := &liveSettings{path: path}
	live.cur.Store(&conf)
	var out bytes.Buffer
	logger := log.New(&out, "", 0)
	write("[dev]\nenable = true\naccounts = [\"" + devOwner + "\"]\n[server.login]\nrate = 3\n")
	live.reload(logger)
	if got := live.get(); !got.Dev.Enable || got.Server.Login.Rate != 10 || !strings.Contains(out.String(), "server.login.rate change at the next restart") {
		t.Fatal(got, out.String())
	}
	write("[dev]\nenabel = false\n")
	live.reload(logger)
	if !live.get().Dev.Enable || !strings.Contains(out.String(), "unknown setting dev.enabel") {
		t.Fatal("a bad file changed the settings:", out.String())
	}
}
