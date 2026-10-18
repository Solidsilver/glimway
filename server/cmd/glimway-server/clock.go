package main

import (
	"net/http"
	"time"
)

// clockSetup is the server's clock and what it adds to the HTTP handler: in
// dev builds with a movable clock, a route that moves it, for callers the
// devCaller lets use the clock; otherwise nothing (dev_clock.go,
// production_clock.go).
type clockSetup struct {
	now func() time.Time
	// movable: the clock route exists (a dev build with -dev-clock or a
	// settings file).
	movable bool
	mount   func(http.Handler, devCaller) http.Handler
}

func realClock() clockSetup {
	return clockSetup{now: time.Now, mount: func(h http.Handler, _ devCaller) http.Handler { return h }}
}
