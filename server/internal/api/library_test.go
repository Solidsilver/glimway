package api

import (
	"bytes"
	"encoding/json"
	"glimway/server/internal/store"
	"net/http"
	"net/http/httptest"
	"slices"
	"sync"
	"testing"
	"time"
)

// A shelf entry as the wire names it (protojson); the generated messages
// answer through protojson, so the JSON keys stay camelCase.
type shelfRow struct {
	PaperID   string `json:"paperId"`
	DonatedBy string `json:"donatedBy"`
	DonatedAt string `json:"donatedAt"`
}

type libraryResponse struct {
	Shelves []shelfRow `json:"shelves"`
	// The donate answer's result (the test helper lifts the Envelope's oneof
	// case there); a refusal leaves it unset.
	Result *struct {
		Entry *shelfRow `json:"entry"`
	} `json:"result"`
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

func (r libraryResponse) Entry() *shelfRow {
	if r.Result == nil {
		return nil
	}
	return r.Result.Entry
}

func (x *rig) lib(method, path string, body any, c *http.Cookie, status int) libraryResponse {
	x.t.Helper()
	v, _ := httpResponse[libraryResponse](x, method, path, body, c, status)
	return v
}

// donateBody donates from the reading room.
func donateBody(s response, paperID, key string) map[string]any {
	return body(s, key, map[string]any{"paperId": paperID, "where": map[string]any{"area": "in:village:library", "x": 80, "y": 80}})
}

// hold seeds a server-granted find for the donation fixtures.
func (x *rig) hold(c *http.Cookie, s response, id string) response {
	x.t.Helper()
	if _, err := x.db.DB.Exec("INSERT OR IGNORE INTO story_marks VALUES(?,?,'server',?)", s.AccountID, "paper:"+id, x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
	out := x.expect("GET", "/api/state", nil, c, 200)
	out.Lease = s.Lease
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
	x.now.Store(x.now.Load()/3600*3600 + 20*60)
	x.named("alice", "Alice")
	c, s := x.ready("alice")
	if shelves := x.lib("GET", "/api/library", nil, c, 200).Shelves; len(shelves) != 0 {
		t.Fatalf("fresh world has %d shelves", len(shelves))
	}
	s = x.hold(c, s, "will-of-elias-fenn")
	before := x.expect("GET", "/api/state", nil, c, 200)

	donated := x.lib("POST", "/api/library/donate", donateBody(s, "will-of-elias-fenn", "d1"), c, 200)
	if donated.Entry() == nil || donated.Entry().PaperID != "will-of-elias-fenn" || donated.Entry().DonatedBy != "Alice" {
		t.Fatalf("donation: %s", store.JSON(donated))
	}
	if _, err := time.Parse(time.RFC3339, donated.Entry().DonatedAt); err != nil {
		t.Fatalf("donatedAt %q is not ISO-8601", donated.Entry().DonatedAt)
	}
	// Donation advances the player version and adds its mark without a ledger payment.
	after := x.expect("GET", "/api/state", nil, c, 200)
	if after.Version != before.Version+1 || !slices.Contains(after.State.Flags, "donated:will-of-elias-fenn@"+time.Unix(x.now.Load(), 0).UTC().Format("2006-01-02")) {
		t.Fatal("donation was not recorded")
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='library-donate'") != 0 || count(t, x.db, "SELECT count(*) FROM library_shelves") != 1 {
		t.Fatal("donation mutated play state")
	}

	// The same key replays the first answer; a new key loses to the first donor.
	replay := x.lib("POST", "/api/library/donate", donateBody(s, "will-of-elias-fenn", "d1"), c, 200)
	if replay.Entry() == nil || store.JSON(replay.Entry()) != store.JSON(donated.Entry()) || count(t, x.db, "SELECT count(*) FROM idempotency WHERE op='/api/library/donate'") != 1 {
		t.Fatal("replay was not idempotent")
	}
	lost := x.lib("POST", "/api/library/donate", donateBody(s, "will-of-elias-fenn", "d2"), c, 409)
	if lost.Error.Code != "already-shelved" || lost.Entry() != nil {
		t.Fatalf("second donor: %s", store.JSON(lost))
	}
	if count(t, x.db, "SELECT count(*) FROM library_shelves") != 1 {
		t.Fatal("second donation stored")
	}

	// A second paper joins the shelf, oldest first.
	x.now.Add(10)
	s = x.hold(c, s, "pip-copybook-warden-corrections")
	x.lib("POST", "/api/library/donate", donateBody(s, "pip-copybook-warden-corrections", "d3"), c, 200)
	shelves := x.lib("GET", "/api/library", nil, c, 200).Shelves
	if len(shelves) != 2 || shelves[0].PaperID != "will-of-elias-fenn" || shelves[1].PaperID != "pip-copybook-warden-corrections" {
		t.Fatalf("shelf order: %s", store.JSON(shelves))
	}
}

func TestLibraryRaceFirstDonorWins(t *testing.T) {
	x := newRig(t)
	x.now.Store(x.now.Load()/3600*3600 + 20*60)
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
		s   response
		key string
	}{{c, s, "alice-key"}, {bc, b, "bob-key"}}
	var wg sync.WaitGroup
	for i, d := range racers {
		wg.Add(1)
		go func(i int, c *http.Cookie, s response, key string) {
			defer wg.Done()
			r := httptest.NewRequest("POST", "/api/library/donate", bytes.NewBufferString(store.JSON(donateBody(s, "will-of-elias-fenn", key))))
			r.Header.Set("X-Glimway-Contract", "4")
			r.Header.Set("Content-Type", "application/json")
			r.AddCookie(c)
			w := httptest.NewRecorder()
			x.api.ServeHTTP(w, r)
			var v libraryResponse
			if err := json.Unmarshal(testSnapshotJSON(w.Body.Bytes()), &v); err != nil {
				t.Error(err)
				return
			}
			answers[i] = answer{w.Code, v}
		}(i, d.c, d.s, d.key)
	}
	wg.Wait()
	if answers[0].status+answers[1].status != 200+409 {
		t.Fatalf("race: %d and %d", answers[0].status, answers[1].status)
	}
	winner, loser := answers[0], answers[1]
	if winner.status != 200 {
		winner, loser = loser, winner
	}
	if winner.v.Entry() == nil || loser.v.Error.Code != "already-shelved" {
		t.Fatal("race did not identify winner and refusal")
	}
	if winner.v.Entry().DonatedBy != "Alice" && winner.v.Entry().DonatedBy != "Bob" {
		t.Fatalf("winner credit: %s", store.JSON(winner.v))
	}
	if count(t, x.db, "SELECT count(*) FROM library_shelves") != 1 {
		t.Fatal("race stored two donations")
	}
}

func TestLibraryGuardsLeaveNoTrace(t *testing.T) {
	x := newRig(t)
	x.now.Store(x.now.Load()/3600*3600 + 20*60)
	x.named("alice", "Alice")
	c, s := x.ready("alice")
	s = x.hold(c, s, "will-of-elias-fenn")
	// A paper the Keepers shelved is already on the shelves, flag or no flag.
	s = x.hold(c, s, "oak-hall-edict-on-the-stealing-of-shade")
	before := x.expect("GET", "/api/state", nil, c, 200)

	if code := x.lib("POST", "/api/library/donate", donateBody(s, "not-a-paper", "k1"), c, 422).Error.Code; code != "unknown-paper" {
		t.Fatalf("unknown paper: %s", code)
	}
	if code := x.lib("POST", "/api/library/donate", donateBody(s, "pip-copybook-warden-corrections", "k2"), c, 403).Error.Code; code != "not-held" {
		t.Fatalf("not held: %s", code)
	}
	if code := x.lib("POST", "/api/library/donate", donateBody(s, "oak-hall-edict-on-the-stealing-of-shade", "k3"), c, 409).Error.Code; code != "already-shelved" {
		t.Fatalf("library-start: %s", code)
	}
	if code := x.lib("POST", "/api/library/donate", donateBody(s, "will-of-elias-fenn", ""), c, 400).Error.Code; code != "key-required" {
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
	x.now.Store(x.now.Load()/3600*3600 + 20*60)
	x.named("alice", "Alice")
	x.named("bob", "Bob")
	ac, a := x.ready("alice")
	bc, b := x.ready("bob")
	a = x.hold(ac, a, "will-of-elias-fenn")
	b = x.hold(bc, b, "will-of-elias-fenn")
	x.lib("POST", "/api/library/donate", donateBody(a, "will-of-elias-fenn", "a"), ac, 200)
	// The same paper is free in another world.
	x.lib("POST", "/api/library/donate", donateBody(b, "will-of-elias-fenn", "b"), bc, 200)
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
	x.lib("POST", "/api/library/donate", donateBody(response{}, "will-of-elias-fenn", "k"), nil, 401)
	if count(t, x.db, "SELECT count(*) FROM library_shelves") != 0 {
		t.Fatal("unauthenticated donation stored")
	}
}

func TestLibraryDonationNeedsElaraWithinGrace(t *testing.T) {
	for _, tc := range []struct {
		name    string
		seconds int64
		area    string
		status  int
	}{
		{"before-arrival-grace", 509, "in:village:library", 409},
		{"arrival-grace-inclusive", 510, "in:village:library", 200},
		{"arrives-at-desk", 600, "in:village:library", 200},
		{"during-desk-phase", 1200, "in:village:library", 200},
		{"departure-grace-inclusive", 2490, "in:village:library", 200},
		{"after-departure-grace", 2491, "in:village:library", 409},
		{"at-camp", 3000, "in:village:library", 409},
		{"hour-wrap", 3600, "in:village:library", 409},
		{"next-arrival-grace", 4110, "in:village:library", 200},
		{"outside-with-elara", 3000, "commons", 409},
		{"outside-library", 1200, "village", 409},
		{"other-room", 1200, "in:village:bakery", 409},
	} {
		t.Run(tc.name, func(t *testing.T) {
			x := newRig(t)
			x.now.Store(x.now.Load()/3600*3600 + tc.seconds)
			c, s := x.ready("alice")
			s = x.hold(c, s, "will-of-elias-fenn")
			before := x.expect("GET", "/api/state", nil, c, 200)
			request := donateBody(s, "will-of-elias-fenn", "donate")
			request["where"] = map[string]any{"area": tc.area, "x": 80, "y": 80}
			answer := x.lib("POST", "/api/library/donate", request, c, tc.status)
			if tc.status == 409 {
				if answer.Error.Code != "not-here" {
					t.Fatal(answer.Error.Code)
				}
				after := x.expect("GET", "/api/state", nil, c, 200)
				unchanged(t, before.Snapshot, after.Snapshot)
				if count(t, x.db, "SELECT count(*) FROM library_shelves") != 0 {
					t.Fatal("refused donation stored")
				}
			} else if answer.Entry() == nil {
				t.Fatal("missing donated shelf entry")
			}
			// Browsing is available even outside the room and without Elara.
			x.lib("GET", "/api/library", nil, c, 200)
		})
	}
}

func TestLibraryDonationClockMovesKeepStatefulReplays(t *testing.T) {
	x := newRig(t)
	base := x.now.Load() / 3600 * 3600
	x.now.Store(base + 3000) // Elara is at camp.
	c, s := x.ready("alice")
	s = x.hold(c, s, "will-of-elias-fenn")
	request := donateBody(s, "will-of-elias-fenn", "outside-hours")
	if got := x.lib("POST", "/api/library/donate", request, c, 409).Error.Code; got != "not-here" {
		t.Fatal(got)
	}
	x.now.Store(base + 4800) // Next hour, :20, at her desk.
	if got := x.lib("POST", "/api/library/donate", request, c, 409).Error.Code; got != "not-here" {
		t.Fatal("refusal replay changed:", got)
	}
	request = donateBody(s, "will-of-elias-fenn", "during-hours")
	donated := x.lib("POST", "/api/library/donate", request, c, 200)
	x.now.Store(base + 6600) // Back at camp.
	replay := x.lib("POST", "/api/library/donate", request, c, 200)
	if donated.Entry() == nil || replay.Entry() == nil || store.JSON(donated.Entry()) != store.JSON(replay.Entry()) {
		t.Fatal("successful donation did not replay after departure")
	}
	if count(t, x.db, "SELECT count(*) FROM library_shelves") != 1 {
		t.Fatal("replay stored another donation")
	}
	if shelves := x.lib("GET", "/api/library", nil, c, 200).Shelves; len(shelves) != 1 || shelves[0].PaperID != "will-of-elias-fenn" {
		t.Fatal("donated paper unavailable without Elara")
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
