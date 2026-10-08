package main

import (
	"net/http"
	"time"
)

// clockSetup is the server's clock and what it adds to the HTTP handler: in
// dev builds started with -dev-clock, a route that moves the clock (tests);
// otherwise nothing (dev_clock.go, production_clock.go).
type clockSetup struct {
	now   func() time.Time
	mount func(http.Handler) http.Handler
}

func realClock() clockSetup {
	return clockSetup{now: time.Now, mount: func(h http.Handler) http.Handler { return h }}
}
