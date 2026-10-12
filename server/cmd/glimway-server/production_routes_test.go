//go:build !dev

package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A production build has no dev routes: /api/dev/grant and /api/dev/fight-fall
// reach the API as any unknown path would (the API has no such route either).
func TestProductionBuildHasNoDevRoutes(t *testing.T) {
	inner := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusTeapot) })
	for path, body := range map[string]string{"/api/dev/grant": `{"grants":[{"id":"glims","qty":1}]}`, "/api/dev/fight-fall": `{"entity":"camp:0:0:0"}`} {
		r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
		r.RemoteAddr = "127.0.0.1:5000"
		w := httptest.NewRecorder()
		devRoutes(nil)(inner).ServeHTTP(w, r)
		if w.Code != http.StatusTeapot {
			t.Fatal("a dev route answered in a production build:", path, w.Code)
		}
	}
}
