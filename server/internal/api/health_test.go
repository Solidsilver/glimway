package api

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
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

// Health names the server build: "dev" until the linker sets it, and the
// build id only when known. CI greps the body for "status":"ok".
func TestHealthVersion(t *testing.T) {
	x := newRig(t)
	read := func() (string, map[string]string) {
		w := httptest.NewRecorder()
		x.api.ServeHTTP(w, httptest.NewRequest("GET", "/api/health", nil))
		var body map[string]string
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(w.Code, w.Body.String(), err)
		}
		return w.Body.String(), body
	}
	raw, body := read()
	if body["status"] != "ok" || body["version"] != "dev" || len(body) != 2 {
		t.Fatalf("default health %s", raw)
	}
	x.api.Config.Version, x.api.Config.Build = "0.2.0", "abc1234"
	raw, body = read()
	if body["status"] != "ok" || body["version"] != "0.2.0" || body["build"] != "abc1234" {
		t.Fatalf("versioned health %s", raw)
	}
	if !json.Valid([]byte(raw)) || !strings.Contains(raw, `"status":"ok"`) {
		t.Fatalf("CI's grep would miss %s", raw)
	}
}
