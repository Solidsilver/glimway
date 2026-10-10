//go:build dev

// Dev-tagged tests (this file, dev_routes_test.go and dev_grant_test.go) are
// named `TestDev…`: CI runs `-run '^TestDev'` against the dev build, so a dev
// test under any other name would build and then be skipped silently.
package main

import (
	"encoding/json"
	"flag"
	"glimway/server/internal/api"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"
)

func devSetup(t *testing.T, args ...string) clockSetup {
	t.Helper()
	f := flag.NewFlagSet("test", flag.ContinueOnError)
	start := devClock(f)
	if err := f.Parse(args); err != nil {
		t.Fatal(err)
	}
	c, err := start()
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func TestDevClockAdvancesAndRejectsBadInputAtStartup(t *testing.T) {
	c := devSetup(t, "-dev-clock=100")
	first := c.now()
	time.Sleep(2 * time.Millisecond)
	second := c.now()
	if first.Unix() != 100 || !second.After(first) {
		t.Fatal(first, second)
	}
	if err := run([]string{"-dev-clock=bad"}); err == nil || !strings.Contains(err.Error(), "invalid dev-clock") {
		t.Fatal(err)
	}
}

// inner stands for the API: it answers 418 so a passed-through request shows.
var inner = http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })

func post(h http.Handler, body, remote string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, devClockPath, strings.NewReader(body))
	r.RemoteAddr = remote
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestDevClockRouteMovesTheClockForwardOnly(t *testing.T) {
	c := devSetup(t, "-dev-clock=1000")
	h := c.mount(inner)
	local := "127.0.0.1:5000"
	if w := post(h, `{"advance_seconds": 3600}`, local); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"moved":true`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if got := c.now().Unix(); got < 4600 || got > 4601 {
		t.Fatal("advanced to", got)
	}
	if w := post(h, `{"unix": 90000}`, "[::1]:5000"); w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	if got := c.now().Unix(); got < 90000 || got > 90001 {
		t.Fatal("set to", got)
	}
	// Advancing by nothing reads the clock (it is not a move back).
	if w := post(h, `{"advance_seconds": 0}`, local); w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	// Never back: the clock stays.
	if w := post(h, `{"unix": 5000}`, local); w.Code != http.StatusConflict {
		t.Fatal(w.Code, w.Body.String())
	}
	if w := post(h, `{"advance_seconds": -10}`, local); w.Code != http.StatusConflict {
		t.Fatal(w.Code, w.Body.String())
	}
	if got := c.now().Unix(); got < 90000 {
		t.Fatal("moved back to", got)
	}
	// Exactly one of the two, nothing else.
	for _, body := range []string{`{}`, `{"unix": 1, "advance_seconds": 1}`, `{"days": 1}`, `nope`} {
		if w := post(h, body, local); w.Code != http.StatusBadRequest {
			t.Fatal(body, w.Code)
		}
	}
	// Only this machine may move it; anyone else finds no such route.
	if w := post(h, `{"advance_seconds": 60}`, "203.0.113.9:5000"); w.Code != http.StatusNotFound {
		t.Fatal(w.Code)
	}
	r := httptest.NewRequest(http.MethodGet, devClockPath, nil)
	r.RemoteAddr = local
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusMethodNotAllowed {
		t.Fatal(w.Code)
	}
	// Every other path is the API's.
	r = httptest.NewRequest(http.MethodPost, "/api/state", nil)
	r.RemoteAddr = local
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusTeapot {
		t.Fatal(w.Code)
	}
}

// "now" is the real clock to the instant (a stamp in whole seconds, read before
// the server started, would leave it behind real time), and still movable.
func TestDevClockNowKeepsRealTimeAndMoves(t *testing.T) {
	c := devSetup(t, "-dev-clock=now")
	if d := time.Since(c.now()); d < 0 || d > 50*time.Millisecond {
		t.Fatal("behind or ahead of real time by", d)
	}
	if w := post(c.mount(inner), `{"advance_seconds": 86400}`, "127.0.0.1:5000"); w.Code != http.StatusOK {
		t.Fatal(w.Code, w.Body.String())
	}
	if d := time.Until(c.now()); d < 86399*time.Second {
		t.Fatal("not moved a day:", d)
	}
}

func TestDevBuildWithoutDevClockHasNoRoute(t *testing.T) {
	c := devSetup(t)
	if w := post(c.mount(inner), `{"advance_seconds": 60}`, "127.0.0.1:5000"); w.Code != http.StatusTeapot {
		t.Fatal("the route answered without -dev-clock:", w.Code)
	}
	if d := time.Since(c.now()); d < 0 || d > time.Second {
		t.Fatal("not the real clock", d)
	}
}

func TestDevAPIAnswersFollowMovableClock(t *testing.T) {
	c := devSetup(t, "-dev-clock=1000")
	a := api.New(nil, nil, api.Config{Now: c.now})
	defer a.ClosePresence()
	h := c.mount(devRoutes(a)(a))
	check := func(path string, status int, want int64) {
		t.Helper()
		r := httptest.NewRequest(http.MethodGet, path, nil)
		r.RemoteAddr = "127.0.0.1:5000"
		r.Header.Set("X-Glimway-Contract", "6")
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != status || w.Header().Get("X-Glimway-Now") != strconv.FormatInt(want, 10) {
			t.Fatal(path, w.Code, w.Header(), w.Body.String())
		}
	}
	check("/api/calendar", 200, 1000)
	w := post(h, `{"advance_seconds":3600}`, "127.0.0.1:5000")
	var moved struct{ Unix int64 }
	if err := json.Unmarshal(w.Body.Bytes(), &moved); err != nil || w.Code != 200 || moved.Unix != 4600 || w.Header().Get("X-Glimway-Now") != strconv.FormatInt(moved.Unix, 10) {
		t.Fatal(w.Code, w.Header(), w.Body.String(), err)
	}
	check("/api/calendar", 200, 4600)
	check("/api/not-a-route", 404, 4600)
	check(api.DevGrantPath, 405, 4600)
	check(devClockPath, 405, 4600)
	for _, row := range []struct {
		body, remote string
		status       int
	}{{`{}`, "127.0.0.1:5000", 400}, {`{"unix":1}`, "127.0.0.1:5000", 409}, {`{"advance_seconds":1}`, "203.0.113.9:5000", 404}} {
		w := post(h, row.body, row.remote)
		if w.Code != row.status || w.Header().Get("X-Glimway-Now") != "4600" {
			t.Fatal(row, w.Code, w.Header())
		}
	}
}
