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
// It exists only in dev builds started with -dev-clock, and answers only
// callers on this machine.
const devClockPath = "/api/dev/clock"

func devClock(f *flag.FlagSet) func() (clockSetup, error) {
	stamp := f.String("dev-clock", "", "Start clock at Unix seconds (or \"now\": the real time, to the instant), advancing normally, and serve POST "+devClockPath+" to move it forward (dev builds only)")
	return func() (clockSetup, error) {
		if *stamp == "" {
			return realClock(), nil
		}
		boot := time.Now()
		at := boot
		if *stamp != "now" {
			n, err := strconv.ParseInt(*stamp, 10, 64)
			if err != nil {
				return clockSetup{}, fmt.Errorf("invalid dev-clock: %w", err)
			}
			at = time.Unix(n, 0)
		}
		c := &movableClock{at: at, since: boot}
		return clockSetup{now: c.now, mount: func(h http.Handler) http.Handler { return devClockRoute(c, h) }}, nil
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

// devLocal: the caller is on this machine (the dev routes answer no one else).
func devLocal(r *http.Request) bool {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(host)
	return err == nil && ip != nil && ip.IsLoopback()
}

// POST /api/dev/clock {"advance_seconds": n} or {"unix": t}: the clock moves
// forward and the answer is {"unix": now}.
func devClockRoute(c *movableClock, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != devClockPath {
			next.ServeHTTP(w, r)
			return
		}
		if !devLocal(r) {
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
		now, ok := c.move(func(now time.Time) time.Time {
			if req.Unix != nil {
				return time.Unix(*req.Unix, 0)
			}
			return now.Add(time.Duration(*req.AdvanceSeconds * float64(time.Second)))
		})
		w.Header().Set("Content-Type", "application/json")
		if !ok {
			w.WriteHeader(http.StatusConflict)
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"unix": now.Unix(), "moved": ok})
	})
}
