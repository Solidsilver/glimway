//go:build dev

package main

import (
	"glimway/server/internal/api"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The grant route answers only this machine; other paths are the API's.
// (The grant itself: server/internal/api/dev_grant_test.go.)
func TestDevRoutesAnswerOnlyThisMachine(t *testing.T) {
	h := devRoutes(nil)(inner)
	r := httptest.NewRequest(http.MethodPost, api.DevGrantPath, strings.NewReader(`{"grants":[{"id":"embers","qty":1}]}`))
	r.RemoteAddr = "203.0.113.9:5000"
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusNotFound {
		t.Fatal("a caller elsewhere reached the grant route:", w.Code)
	}
	r = httptest.NewRequest(http.MethodPost, "/api/state", nil)
	r.RemoteAddr = "127.0.0.1:5000"
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusTeapot {
		t.Fatal("another path didn't reach the API:", w.Code)
	}
}
