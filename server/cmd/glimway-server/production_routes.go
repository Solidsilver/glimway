//go:build !dev

package main

import (
	"glimway/server/internal/api"
	"net/http"
)

// Production builds have no dev routes: the handler as it is.
func devRoutes(*api.Server) func(http.Handler) http.Handler {
	return func(h http.Handler) http.Handler { return h }
}
