//go:build dev

package api

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The world lab starts at the caller's own world: its seed, and the wick
// season now. No session, no world.
func TestDevWorldLabHereIsTheCallersWorld(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("lab-hero")
	var seed string
	if err := x.db.DB.QueryRow("SELECT w.seed FROM players p JOIN worlds w ON w.id=p.world_id WHERE p.account_id=?", x.accounts["lab-hero"]).Scan(&seed); err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodGet, "/api/dev/worldlab/state", nil)
	r.AddCookie(c)
	here, ok := x.api.DevWorldLabHere(r)
	if !ok || here.Seed != seed || here.World == "" || !strings.HasPrefix(here.Epoch, "t:") {
		t.Fatal(here, ok)
	}
	if _, ok := x.api.DevWorldLabHere(httptest.NewRequest(http.MethodGet, "/api/dev/worldlab/state", nil)); ok {
		t.Fatal("a caller without a session has a world")
	}
}
