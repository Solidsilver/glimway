//go:build dev

package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A deployed dev server's gate: the signed-in Habitica account behind a
// request, and never a write from another site or without JSON.
func TestDevCallerIsTheSignedInAccount(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("dev-caller")
	var subject string
	if err := x.db.DB.QueryRow("SELECT subject FROM sign_ins WHERE account_id=? AND method='habitica'", x.accounts["dev-caller"]).Scan(&subject); err != nil {
		t.Fatal(err)
	}
	ask := func(method string, cookie *http.Cookie, header map[string]string) (string, bool) {
		r := httptest.NewRequest(method, "/api/dev/clock", strings.NewReader(`{}`))
		if cookie != nil {
			r.AddCookie(cookie)
		}
		for k, v := range header {
			r.Header.Set(k, v)
		}
		return x.api.DevCaller(r)
	}
	if id, ok := ask(http.MethodGet, c, nil); !ok || id != subject {
		t.Fatal("signed-in caller not found:", id, ok)
	}
	json := map[string]string{"Content-Type": "application/json", "Origin": "http://example.com"}
	if id, ok := ask(http.MethodPost, c, json); !ok || id != subject {
		t.Fatal("a same-origin JSON write refused:", id, ok)
	}
	if _, ok := ask(http.MethodGet, nil, nil); ok {
		t.Fatal("a caller without a session passed")
	}
	if _, ok := ask(http.MethodGet, &http.Cookie{Name: CookieName, Value: strings.Repeat("a", 64)}, nil); ok {
		t.Fatal("an unknown session passed")
	}
	if _, ok := ask(http.MethodPost, c, map[string]string{"Content-Type": "application/json", "Origin": "https://elsewhere.example"}); ok {
		t.Fatal("a write from another site passed")
	}
	if _, ok := ask(http.MethodPost, c, map[string]string{"Content-Type": "text/plain"}); ok {
		t.Fatal("a write without JSON passed")
	}
	// Signing out ends it.
	if _, err := x.db.DB.Exec("DELETE FROM sessions"); err != nil {
		t.Fatal(err)
	}
	if _, ok := ask(http.MethodGet, c, nil); ok {
		t.Fatal("a revoked session passed")
	}
}
