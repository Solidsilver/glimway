//go:build dev

package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	wire "glimway/server/internal/gen/glimway/v2"
	"glimway/server/internal/store"
)

func (x *rig) devFightFall(cookie *http.Cookie, body string) *httptest.ResponseRecorder {
	x.t.Helper()
	r := httptest.NewRequest(http.MethodPost, DevFightFallPath, strings.NewReader(body))
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	x.api.DevFightFall(w, r)
	return w
}

// The dev fixture puts a camp down only through the room the caller's own
// socket covers: every live enemy dies on the normal path (DEATH events,
// dead rows), and the fall's witnesses are the accounts covering the room,
// not just the caller. A cold room is refused, a repeat is idempotent.
func TestDevFightFallClearsThroughTheCoveredRoom(t *testing.T) {
	x, p, cookie, _ := adapterFightFixture(t)
	for _, body := range []string{`{`, `{"entity":"camp:0:0:0","extra":1}`} {
		if w := x.devFightFall(cookie, body); w.Code != 400 {
			t.Fatal("bad body", body, w.Code)
		}
	}
	if w := x.devFightFall(cookie, `{"entity":"chest:0:0:2"}`); w.Code != 404 {
		t.Fatal("non-camp id", w.Code)
	}
	if w := x.devFightFall(nil, `{"entity":"camp:0:0:0"}`); w.Code != 401 {
		t.Fatal("no session", w.Code)
	}
	// No covered room yet: refused, never woken or written around.
	if w := x.devFightFall(cookie, `{"entity":"camp:0:0:0"}`); w.Code != 409 || !strings.Contains(w.Body.String(), "not-here") {
		t.Fatal("cold room", w.Code, w.Body.String())
	}
	x.api.syncFightPresence(p)
	join := queuedFightFrame(t, p).GetFightJoin()
	if join == nil || len(join.Enemies) == 0 {
		t.Fatal("no join")
	}
	// A friend covering the same room is a witness too.
	bc, bs := x.ready("bob")
	if _, err := x.db.DB.Exec("UPDATE players SET world_id=? WHERE account_id=?", p.identity.World, bs.AccountID); err != nil {
		t.Fatal(err)
	}
	identity, err := x.api.presenceIdentity(context.Background(), store.Hash(bc.Value), false)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	q := &presencePeer{identity: identity, account: &presenceAccount{}, ctx: ctx, cancel: cancel, queue: make(chan []byte, 256), area: p.area, pos: &presencePosition{X: 600, Y: 208}}
	h := x.api.presence
	h.mu.Lock()
	h.peers[q.identity.ID] = q
	h.mu.Unlock()
	x.api.syncFightPresence(q)
	queuedFightFrame(t, q)

	w := x.devFightFall(cookie, `{"entity":"camp:0:0:0"}`)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var out devFightFall
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	want := []string{p.identity.ID, q.identity.ID}
	slices.Sort(want)
	if out.Entity != "camp:0:0:0" || out.Room != join.Room || out.Epoch != join.RoomKey.Epoch || out.FellAt == 0 || !slices.Equal(out.Witnesses, want) {
		t.Fatal("fall", out, want)
	}
	deaths := 0
	for deaths < len(join.Enemies) {
		if e := queuedFightFrame(t, p).GetFightEvent(); e != nil && e.Kind == wire.FightEventKind_FIGHT_EVENT_KIND_DEATH {
			deaths++
		}
	}
	// Once down, the same cycle answers again with nothing new.
	again := x.devFightFall(cookie, `{"entity":"camp:0:0:0"}`)
	var repeat devFightFall
	if again.Code != 200 || json.Unmarshal(again.Body.Bytes(), &repeat) != nil || repeat.Cycle != out.Cycle || repeat.FellAt != 0 || len(repeat.Witnesses) != 0 {
		t.Fatal("repeat", again.Code, again.Body.String())
	}
	if w := x.devFightFall(cookie, `{"entity":"camp:0:0:9"}`); w.Code != 404 {
		t.Fatal("unknown camp in a covered room", w.Code)
	}
	// A chunk the caller covers but whose room never woke (no camp there).
	if w := x.devFightFall(cookie, `{"entity":"camp:1:0:0"}`); w.Code != 409 {
		t.Fatal("unwoken room", w.Code)
	}
}
