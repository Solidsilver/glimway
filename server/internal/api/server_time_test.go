package api

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
)

func TestServerClockHeaderOnEveryAnswer(t *testing.T) {
	x := newRig(t)
	cookie, s := x.ready("alice")
	quest, _ := json.Marshal(body(s, "clock-refusal", map[string]any{"quest": "lantern-road", "to": "accepted"}))
	cases := []struct {
		name, method, path, body, contract, contentType, origin string
		cookie                                                  bool
		status                                                  int
	}{
		{name: "health", method: "GET", path: "/api/health", status: 200},
		{name: "head", method: "HEAD", path: "/api/health", status: 200},
		{name: "calendar", method: "GET", path: "/api/calendar", status: 200},
		{name: "state", method: "GET", path: "/api/state", cookie: true, status: 200},
		{name: "unauthorized", method: "GET", path: "/api/state", status: 401},
		{name: "stateful refusal", method: "POST", path: "/api/quest/step", body: string(quest), cookie: true, status: 409},
		{name: "malformed", method: "POST", path: "/api/quest/step", body: "{", cookie: true, status: 400},
		{name: "wrong content type", method: "POST", path: "/api/quest/step", contentType: "text/plain", status: 415},
		{name: "cross origin", method: "POST", path: "/api/quest/step", origin: "https://elsewhere.example", status: 403},
		{name: "reload needed", method: "GET", path: "/api/state", contract: "3", cookie: true, status: 409},
		{name: "unknown route", method: "GET", path: "/api/not-a-route", status: 404},
	}
	for _, row := range cases {
		x.now.Add(60)
		req := httptest.NewRequest(row.method, row.path, strings.NewReader(row.body))
		contract := row.contract
		if contract == "" {
			contract = "6"
		}
		req.Header.Set("X-Glimway-Contract", contract)
		kind := row.contentType
		if kind == "" {
			kind = "application/json"
		}
		req.Header.Set("Content-Type", kind)
		if row.origin != "" {
			req.Header.Set("Origin", row.origin)
		}
		if row.cookie {
			req.AddCookie(cookie)
		}
		w := httptest.NewRecorder()
		x.api.ServeHTTP(w, req)
		if w.Code != row.status || w.Header().Get("X-Glimway-Now") != strconv.FormatInt(x.now.Load(), 10) {
			t.Fatal(row.name, w.Code, w.Header(), w.Body.String())
		}
		if row.name == "stateful refusal" && !strings.Contains(w.Body.String(), `"state"`) {
			t.Fatal("missing current state", w.Body.String())
		}
	}
	x.db.Close()
	x.now.Add(60)
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if w.Code != 503 || w.Header().Get("X-Glimway-Now") != strconv.FormatInt(x.now.Load(), 10) {
		t.Fatal("unhealthy", w.Code, w.Header())
	}
}
