package api

import (
	"net/http/httptest"
	"testing"
)

func TestHealthReadiness(t *testing.T) {
	x := newRig(t)
	for _, method := range []string{"GET", "HEAD"} {
		w := httptest.NewRecorder()
		x.api.ServeHTTP(w, httptest.NewRequest(method, "/api/health", nil))
		if w.Code != 200 || w.Header().Get("Cache-Control") != "no-store" {
			t.Fatal(w.Code, w.Header())
		}
		if method == "HEAD" && w.Body.Len() != 0 {
			t.Fatal("HEAD body")
		}
	}
	if x.calls.Load() != 0 {
		t.Fatal("health called upstream")
	}
	x.db.Close()
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, httptest.NewRequest("GET", "/api/health", nil))
	if w.Code != 503 {
		t.Fatalf("closed DB health: %d", w.Code)
	}
}
