package api

import "testing"

// The open map's routes exist and refuse with "not-implemented" until lane
// O-C builds them (open_map.go).
func TestOpenMapRouteStubs(t *testing.T) {
	x := newRig(t)
	c := x.login("alice", "")
	for _, route := range []struct{ method, path string }{
		{"GET", "/api/wilds/near/-2/-4"},
		{"POST", "/api/wilds/clear"},
		{"POST", "/api/wilds/lay"},
		{"POST", "/api/wilds/lift"},
		{"POST", "/api/wilds/discover"},
	} {
		status, _, e, _ := x.request(route.method, route.path, map[string]any{}, c)
		if status != 501 || e != "not-implemented" {
			t.Errorf("%s %s: %d %q", route.method, route.path, status, e)
		}
	}
}
