//go:build dev

package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// devClockPath moves a dev server's clock forward (e2e: the end of a wick).
// It exists only in dev builds started with -dev-clock or a settings file,
// and answers only callers the devCaller lets use the clock.
const devClockPath = "/api/dev/clock"

// devClock reads -dev-clock. A dev build with a settings file always has a
// movable clock (from now, unless -dev-clock says otherwise), so dev.clock
// can be turned on by a reload.
func devClock(f *flag.FlagSet) func(configured bool) (clockSetup, error) {
	stamp := f.String("dev-clock", "", "Start clock at Unix seconds (or \"now\": the real time, to the instant), advancing normally, and serve POST "+devClockPath+" to move it forward (dev builds only)")
	return func(configured bool) (clockSetup, error) {
		if *stamp == "" && !configured {
			return realClock(), nil
		}
		boot := time.Now()
		at := boot
		if *stamp != "now" && *stamp != "" {
			n, err := strconv.ParseInt(*stamp, 10, 64)
			if err != nil {
				return clockSetup{}, fmt.Errorf("invalid dev-clock: %w", err)
			}
			at = time.Unix(n, 0)
		}
		c := &movableClock{at: at, since: boot}
		return clockSetup{now: c.now, movable: true, mount: func(h http.Handler, caller devCaller) http.Handler { return devClockRoute(c, caller, h) }}, nil
	}
}

// movableClock advances normally from `at`, set at `since`.
type movableClock struct {
	mu    sync.Mutex
	at    time.Time
	since time.Time
}

func (c *movableClock) now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.at.Add(time.Since(c.since))
}

// move sets the clock to the time `to` picks from now, never back: the
// server's state assumes time only moves forward. One step under the lock,
// so "now plus d" is measured from the same now it is checked against.
func (c *movableClock) move(to func(now time.Time) time.Time) (time.Time, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.at.Add(time.Since(c.since))
	t := to(now)
	if t.Before(now) {
		return now, false
	}
	c.at, c.since = t, time.Now()
	return t, true
}

// devLocal: the caller is on this machine, and not through a proxy (with no
// settings file, the dev routes answer no one else). A proxy on this host,
// such as Caddy, connects from loopback for everyone, so a forwarded request
// is never local.
func devLocal(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	return err == nil && ip != nil && ip.IsLoopback() && r.Header.Get("X-Forwarded-For") == "" && r.Header.Get("Forwarded") == ""
}

// POST /api/dev/clock {"advance_seconds": n} or {"unix": t}: the clock moves
// forward and the answer is {"unix": now}.
func devClockRoute(c *movableClock, caller devCaller, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != devClockPath {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("X-Glimway-Now", strconv.FormatInt(c.now().Unix(), 10))
		if !caller(r).Clock {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", http.MethodPost)
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		var req struct {
			AdvanceSeconds *float64 `json:"advance_seconds"`
			Unix           *int64   `json:"unix"`
		}
		dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<10))
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil || (req.AdvanceSeconds == nil) == (req.Unix == nil) {
			http.Error(w, `give exactly one of "advance_seconds" or "unix"`, http.StatusBadRequest)
			return
		}
		was := c.now()
		now, ok := c.move(func(now time.Time) time.Time {
			if req.Unix != nil {
				return time.Unix(*req.Unix, 0)
			}
			return now.Add(time.Duration(*req.AdvanceSeconds * float64(time.Second)))
		})
		if ok && now.Sub(was) >= time.Second {
			devLog.Printf("dev clock moved from=%d to=%d", was.Unix(), now.Unix())
		}
		w.Header().Set("X-Glimway-Now", strconv.FormatInt(now.Unix(), 10))
		w.Header().Set("Content-Type", "application/json")
		if !ok {
			w.WriteHeader(http.StatusConflict)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"unix": now.Unix(), "moved": ok})
	})
}
