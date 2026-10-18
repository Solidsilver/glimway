package main

import (
	"glimway/server/internal/settings"
	"net/http"
)

// devCaller says which dev tools a request's caller may use. A dev build
// makes one (devCallerFor, dev_routes.go); a release build has none.
type devCaller func(r *http.Request) settings.Tools

// devAccess is what a dev build gates its dev routes on.
type devAccess struct {
	// configured: the server started with a settings file or
	// GLIMWAY_DEV_ENABLE. Without either, a dev build's tools answer callers
	// on this machine (local dev and e2e); with one, the settings decide, per
	// signed-in account.
	configured bool
	settings   func() settings.Settings
}
