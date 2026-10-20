package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// GET /api/web-settings: the server command's answer for this request, or
// no settings and no dev tools without one; no sign-in needed.
func TestWebSettingsRoute(t *testing.T) {
	x := newRig(t)
	get := func() *httptest.ResponseRecorder {
		r := httptest.NewRequest(http.MethodGet, webSettingsPath, nil)
		r.Header.Set("X-Glimway-Contract", testContract())
		w := httptest.NewRecorder()
		x.api.ServeHTTP(w, r)
		return w
	}
	if w := get(); w.Code != 200 || strings.TrimSpace(w.Body.String()) != `{"dev":null}` {
		t.Fatal(w.Code, w.Body.String())
	}
	x.api.Config.WebSettings = func(r *http.Request) any { return map[string]any{"dev": map[string]bool{"hooks": true}} }
	if w := get(); w.Code != 200 || !strings.Contains(w.Body.String(), `"hooks":true`) || w.Header().Get("Cache-Control") != "no-store" {
		t.Fatal(w.Code, w.Header(), w.Body.String())
	}
}
