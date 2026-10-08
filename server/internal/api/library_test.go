package api

import (
	"bytes"
	"encoding/json"
	"glimway/server/internal/store"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"
)

type libraryResponse struct {
	Shelves []shelfEntry `json:"shelves"`
	Entry   *shelfEntry  `json:"entry"`
	Error   struct {
		Code string `json:"code"`
	} `json:"error"`
}

func (x *rig) lib(method, path string, body any, c *http.Cookie, status int) libraryResponse {
	x.t.Helper()
	v, _ := httpResponse[libraryResponse](x, method, path, body, c, status)
	return v
}

func donateBody(paperID, key string) map[string]any {
	return map[string]any{"paperId": paperID, "key": key}
}

// hold gives the player's stored progress a find, the way a connected
// client uploads it before asking to donate.
func (x *rig) hold(c *http.Cookie, s response, id string) response {
	x.t.Helper()
	doc := s.State
	doc.Flags = append(doc.Flags, "paper:"+id)
	out := x.expect("PUT", "/api/progress", mutation(s, doc), c, 200)
	out.Lease = s.Lease // a progress answer has no lease of its own
	return out
}

// named is a login-ready profile with its own display name, so shelf
// credits can tell players apart.
func (x *rig) named(id, name string) {
	x.t.Helper()
	p := profile(id, 1, 0, 20)
	p.Name = name
	x.set(p)
}

func TestLibraryDonateShelfAndIdempotency(t *testing.T) {
	x := newRig(t)
	x.named("alice", "Alice")
	c, s := x.ready("alice")
	if shelves := x.lib("GET", "/api/library", nil, c, 200).Shelves; len(shelves) != 0 {
		t.Fatalf("fresh world has %d shelves", len(shelves))
	}
	s = x.hold(c, s, "will-of-elias-fenn")
	before := x.expect("GET", "/api/state", nil, c, 200)

	donated := x.lib("POST", "/api/library/donate", donateBody("will-of-elias-fenn", "d1"), c, 200)
	if donated.Entry == nil || donated.Entry.PaperID != "will-of-elias-fenn" || donated.Entry.DonatedBy != "Alice" {
		t.Fatalf("donation: %s", store.JSON(donated))
	}
	if _, err := time.Parse(time.RFC3339, donated.Entry.DonatedAt); err != nil {
		t.Fatalf("donatedAt %q is not ISO-8601", donated.Entry.DonatedAt)
	}
	// Donating is not a play mutation: no revision, no ledger row.
	after := x.expect("GET", "/api/state", nil, c, 200)
	unchanged(t, before.Snapshot, after.Snapshot)
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='library-donate'") != 0 || count(t, x.db, "SELECT count(*) FROM library_shelves") != 1 {
		t.Fatal("donation mutated play state")
	}

	// The same key replays the first answer; a new key loses to the first donor.
	replay := x.lib("POST", "/api/library/donate", donateBody("will-of-elias-fenn", "d1"), c, 200)
	if replay.Entry == nil || *replay.Entry != *donated.Entry || count(t, x.db, "SELECT count(*) FROM idempotency WHERE op='/api/library/donate'") != 1 {
		t.Fatal("replay was not idempotent")
	}
	lost := x.lib("POST", "/api/library/donate", donateBody("will-of-elias-fenn", "d2"), c, 409)
	if lost.Error.Code != "already-shelved" || lost.Entry == nil || *lost.Entry != *donated.Entry {
		t.Fatalf("second donor: %s", store.JSON(lost))
	}
	if count(t, x.db, "SELECT count(*) FROM library_shelves") != 1 {
		t.Fatal("second donation stored")
	}

	// A second paper joins the shelf, oldest first.
	x.now.Add(10)
	s = x.hold(c, s, "pip-copybook-warden-corrections")
	x.lib("POST", "/api/library/donate", donateBody("pip-copybook-warden-corrections", "d3"), c, 200)
	shelves := x.lib("GET", "/api/library", nil, c, 200).Shelves
	if len(shelves) != 2 || shelves[0].PaperID != "will-of-elias-fenn" || shelves[1].PaperID != "pip-copybook-warden-corrections" {
		t.Fatalf("shelf order: %s", store.JSON(shelves))
	}
}

func TestLibraryRaceFirstDonorWins(t *testing.T) {
	x := newRig(t)
	x.named("alice", "Alice")
	x.named("bob", "Bob")
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	_ = x.hold(bc, b, "will-of-elias-fenn")
	_ = x.hold(c, s, "will-of-elias-fenn")

	type answer struct {
		status int
		v      libraryResponse
	}
	answers := make([]answer, 2)
	racers := []struct {
		c   *http.Cookie
		key string
	}{{c, "alice-key"}, {bc, "bob-key"}}
	var wg sync.WaitGroup
	for i, d := range racers {
		wg.Add(1)
		go func(i int, c *http.Cookie, key string) {
			defer wg.Done()
			r := httptest.NewRequest("POST", "/api/library/donate", bytes.NewBufferString(store.JSON(donateBody("will-of-elias-fenn", key))))
			r.Header.Set("Content-Type", "application/json")
			r.AddCookie(c)
			w := httptest.NewRecorder()
			x.api.ServeHTTP(w, r)
			var v libraryResponse
			if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
				t.Error(err)
				return
			}
			answers[i] = answer{w.Code, v}
		}(i, d.c, d.key)
	}
	wg.Wait()
	if answers[0].status+answers[1].status != 200+409 {
		t.Fatalf("race: %d and %d", answers[0].status, answers[1].status)
	}
	winner, loser := answers[0], answers[1]
	if winner.status != 200 {
		winner, loser = loser, winner
	}
	if winner.v.Entry == nil || loser.v.Entry == nil {
		t.Fatalf("race answers must carry the winning entry: %s %s", store.JSON(winner.v), store.JSON(loser.v))
	}
	if *winner.v.Entry != *loser.v.Entry {
		t.Fatalf("loser was not told who won: %s vs %s", store.JSON(winner.v), store.JSON(loser.v))
	}
	if winner.v.Entry.DonatedBy != "Alice" && winner.v.Entry.DonatedBy != "Bob" {
		t.Fatalf("winner credit: %s", store.JSON(winner.v))
	}
	if count(t, x.db, "SELECT count(*) FROM library_shelves") != 1 {
		t.Fatal("race stored two donations")
	}
}

func TestLibraryGuardsLeaveNoTrace(t *testing.T) {
	x := newRig(t)
	x.named("alice", "Alice")
	c, s := x.ready("alice")
	s = x.hold(c, s, "will-of-elias-fenn")
	// A paper the Keepers shelved is already on the shelves, flag or no flag.
	s = x.hold(c, s, "oak-hall-edict-on-the-stealing-of-shade")
	before := x.expect("GET", "/api/state", nil, c, 200)

	if code := x.lib("POST", "/api/library/donate", donateBody("not-a-paper", "k1"), c, 422).Error.Code; code != "unknown-paper" {
		t.Fatalf("unknown paper: %s", code)
	}
	if code := x.lib("POST", "/api/library/donate", donateBody("pip-copybook-warden-corrections", "k2"), c, 403).Error.Code; code != "not-held" {
		t.Fatalf("not held: %s", code)
	}
	if code := x.lib("POST", "/api/library/donate", donateBody("oak-hall-edict-on-the-stealing-of-shade", "k3"), c, 409).Error.Code; code != "already-shelved" {
		t.Fatalf("library-start: %s", code)
	}
	if code := x.lib("POST", "/api/library/donate", donateBody("will-of-elias-fenn", ""), c, 400).Error.Code; code != "key-required" {
		t.Fatalf("missing key: %s", code)
	}
	if count(t, x.db, "SELECT count(*) FROM library_shelves") != 0 {
		t.Fatal("a rejected donation was stored")
	}
	after := x.expect("GET", "/api/state", nil, c, 200)
	unchanged(t, before.Snapshot, after.Snapshot)
}

func TestLibraryWorldsAreIsolated(t *testing.T) {
	x := newRig(t)
	x.named("alice", "Alice")
	x.named("bob", "Bob")
	ac, a := x.ready("alice")
	bc, b := x.ready("bob")
	a = x.hold(ac, a, "will-of-elias-fenn")
	b = x.hold(bc, b, "will-of-elias-fenn")
	x.lib("POST", "/api/library/donate", donateBody("will-of-elias-fenn", "a"), ac, 200)
	// The same paper is free in another world.
	x.lib("POST", "/api/library/donate", donateBody("will-of-elias-fenn", "b"), bc, 200)
	asa := x.lib("GET", "/api/library", nil, ac, 200).Shelves
	bsa := x.lib("GET", "/api/library", nil, bc, 200).Shelves
	if len(asa) != 1 || asa[0].DonatedBy != "Alice" || len(bsa) != 1 || bsa[0].DonatedBy != "Bob" {
		t.Fatalf("world shelves leaked: %s %s", store.JSON(asa), store.JSON(bsa))
	}
	// A world-mate sees the world's shelf, not their own.
	cc, _ := x.member("carol", a.WorldID)
	cs := x.lib("GET", "/api/library", nil, cc, 200).Shelves
	if len(cs) != 1 || cs[0].PaperID != "will-of-elias-fenn" || cs[0].DonatedBy != "Alice" {
		t.Fatalf("world-mate shelf: %s", store.JSON(cs))
	}
	if count(t, x.db, "SELECT count(*) FROM library_shelves") != 2 {
		t.Fatal("expected one donation per world")
	}
}

func TestLibraryNeedsSession(t *testing.T) {
	x := newRig(t)
	x.lib("GET", "/api/library", nil, nil, 401)
	x.lib("POST", "/api/library/donate", donateBody("will-of-elias-fenn", "k"), nil, 401)
	if count(t, x.db, "SELECT count(*) FROM library_shelves") != 0 {
		t.Fatal("unauthenticated donation stored")
	}
}

func TestCapDonorFallsBackForBlankNames(t *testing.T) {
	if got := capDonor("   "); got != "A Keeper" {
		t.Fatalf("blank name: got %q", got)
	}
	if got := capDonor("  Wren "); got != "Wren" {
		t.Fatalf("trimmed name: got %q", got)
	}
}
