//go:build dev

package api

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// A dev warp moves sight with the hero: the reads round the far spot
// answer at once, and the report from there that follows is taken whole.
// The saved place and version don't move.
func TestDevWarpMovesSight(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.putAt(s.AccountID, 20, 60)
	x.near(c, 20, 60, 200)
	px, py := 900*chunkPx()+200, -700*chunkPx()+200
	x.refusal("/api/wilds/near/900/-700", c, "beyond-sight")
	_, _, _, setAt, version := x.placeOf(s.AccountID)
	r := httptest.NewRequest(http.MethodPost, DevWarpPath, strings.NewReader(fmt.Sprintf(`{"x":%v,"y":%v}`, px, py)))
	r.AddCookie(c)
	w := httptest.NewRecorder()
	x.api.DevWarp(w, r)
	if w.Code != 200 {
		t.Fatalf("dev warp: %d %s", w.Code, w.Body.String())
	}
	if _, _, _, setAt2, version2 := x.placeOf(s.AccountID); setAt2 != setAt || version2 != version {
		t.Fatal("the dev warp moved the saved place")
	}
	x.near(c, 900, -700, 200)
	s = x.reportPx(c, s, px+100, py)
	x.near(c, 900, -700, 200)
	// Past the border it is refused.
	r = httptest.NewRequest(http.MethodPost, DevWarpPath, strings.NewReader(`{"x":1e9,"y":0}`))
	r.AddCookie(c)
	w = httptest.NewRecorder()
	x.api.DevWarp(w, r)
	if w.Code != 409 {
		t.Fatalf("past the border: %d", w.Code)
	}
}
