//go:build !dev

package main

import (
	"glimway/server/internal/api"
	"net/http"
)

// devBuild: this build has dev tools (go build -tags dev). A release build
// refuses settings with dev.enable = true (settings.Check).
const devBuild = false

// Production builds have no dev routes and no dev callers: the handler as it is.
func devCallerFor(*api.Server, devAccess) devCaller { return nil }

func devRoutes(*api.Server, devCaller) func(http.Handler) http.Handler {
	return func(h http.Handler) http.Handler { return h }
}
