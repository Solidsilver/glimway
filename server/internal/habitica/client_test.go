package habitica

import (
	"context"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const valid = `{"success":true,"data":{"_id":"alice","profile":{"name":"Hero"},"flags":{"classSelected":false},"stats":{"lvl":1,"exp":0,"hp":5,"mp":10,"str":0,"int":0,"con":0,"per":0}}}`

// A real mage account: stats.class "wizard" and wizard-klass gear, with the
// stat block of the real catalog's weapon_wizard_1 (int 3, per 1).
const wizardUser = `{"success":true,"data":{"_id":"vesper","profile":{"name":"Vesper"},"flags":{"classSelected":true},"stats":{"lvl":1,"exp":0,"hp":50,"mp":30,"class":"%s","str":5,"int":5,"con":5,"per":5},"items":{"gear":{"equipped":{"weapon":"weapon_wizard_1"}}}}}`

func TestWizardUserImportsAsMageWithClassBonus(t *testing.T) {
	for _, class := range []string{"wizard", "mage"} {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			_, _ = w.Write([]byte(strings.Replace(wizardUser, "%s", class, 1)))
		}))
		p, _, err := New(s.URL, "tag").VerifyLimited(context.Background(), "vesper", "secret", nil)
		s.Close()
		if err != nil {
			t.Fatalf("class %q rejected: %v", class, err)
		}
		if p.Class == nil || *p.Class != "mage" {
			t.Fatalf("class %q imported as %v, want mage", class, p.Class)
		}
		// weapon_wizard_1 (int 3, per 1, klass wizard) counts twice for a mage:
		// int 5+3+3 = 11, per 5+1+1 = 7; maxMp = 2*11+30.
		if p.Stats.Int != 11 || p.Stats.Per != 7 || p.Stats.Str != 5 || p.Stats.Con != 5 || p.MaxMP != 52 {
			t.Fatalf("class bonus missing for wizard gear: %+v", p.Stats)
		}
	}
}

func TestRetryAfterOnce(t *testing.T) {
	for _, always := range []bool{false, true} {
		var n atomic.Int64
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			call := n.Add(1)
			if r.Header.Get("X-Api-Key") != "secret" || r.Header.Get("X-Client") != "creator-app" || r.URL.Query().Get("userFields") == "" {
				t.Error("missing upstream headers/projection")
			}
			if call == 1 || always {
				w.Header().Set("Retry-After", "0")
				w.WriteHeader(429)
				return
			}
			_, _ = w.Write([]byte(valid))
		}))
		c := New(s.URL, "creator-app")
		p, _, err := c.VerifyLimited(context.Background(), "alice", "secret", nil)
		s.Close()
		if n.Load() != 2 {
			t.Fatalf("retried %d times", n.Load())
		}
		if always {
			var e *Error
			if !errors.As(err, &e) || e.Code != "habitica-rate-limited" {
				t.Fatal(err)
			}
		} else if err != nil || p.ID != "alice" {
			t.Fatal(err)
		}
	}
}
func TestUpstreamErrorsAreScrubbedAndRedirectsBlocked(t *testing.T) {
	for _, status := range []int{401, 403, 500, 200, 302} {
		var calls atomic.Int64
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			calls.Add(1)
			w.Header().Set("Location", "/echo-secret")
			w.WriteHeader(status)
			_, _ = w.Write([]byte("secret"))
		}))
		_, _, err := New(s.URL, "creator-app").VerifyLimited(context.Background(), "alice", "secret", nil)
		s.Close()
		if err == nil || strings.Contains(err.Error(), "secret") || calls.Load() != 1 {
			t.Fatalf("unsafe error/retry: %v", err)
		}
	}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Replace(valid, `"alice"`, `"bob"`, 1)))
	}))
	defer s.Close()
	if _, _, err := New(s.URL, "tag").VerifyLimited(context.Background(), "alice", "secret", nil); err == nil {
		t.Fatal("identity mismatch accepted")
	}
}
func TestRetryAfterParser(t *testing.T) {
	if retryAfter("2") != 2*time.Second || retryAfter("-1") != time.Second || retryAfter("9999999") != 60*time.Second || retryAfter("garbage") != time.Second {
		t.Fatal("Retry-After seconds")
	}
	if retryAfter(time.Now().Add(10*time.Second).UTC().Format(http.TimeFormat)) < 8*time.Second {
		t.Fatal("Retry-After HTTP date")
	}
}
func TestRateLimitWaitCancellation(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Header().Set("Retry-After", "60"); w.WriteHeader(429) }))
	defer s.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Millisecond)
	defer cancel()
	if _, _, err := New(s.URL, "tag").VerifyLimited(ctx, "alice", "secret", nil); err == nil {
		t.Fatal("cancelled login succeeded")
	}
}

// A pet raised into a mount is stored as -1 and is no longer an owned pet;
// a pet is owned only as a number greater than 0, a mount only as true
// (docs/design/crafts.md 2.2). This asserted the bug once: -1 counted.
func TestMapNullablePetAndMountOwnership(t *testing.T) {
	raw := strings.Replace(valid, `"stats":`, `"items":{"pets":{"released":null,"zero":0,"raised":-1,"truthy":true,"one":1},"mounts":{"released":null,"zero":0,"raised":-1,"truthy":true,"one":1}},"stats":`, 1)
	p, err := Map([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	if len(p.Pets) != 1 || p.Pets[0] != "one" {
		t.Fatal("pet ownership mapping", p.Pets)
	}
	if len(p.Mounts) != 1 || p.Mounts[0] != "truthy" {
		t.Fatal("mount ownership mapping", p.Mounts)
	}
}

// TestPurseCallsHitTheirPaths: the purse's four calls and the wardrobe's
// read hit exactly the paths design 2.2 and 4.3 name, carry the token in
// one header, read only what they need out of the bodies, and never let a
// body into a returned value or an error.
func TestPurseCallsHitTheirPaths(t *testing.T) {
	var seen, bodies []string
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, _ := io.ReadAll(r.Body)
		seen = append(seen, r.Method+" "+r.URL.Path)
		bodies = append(bodies, string(raw))
		if r.Header.Get("X-Api-Key") != "secret" || r.Header.Get("X-Client") != "tag" {
			t.Error("missing upstream headers")
		}
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.Method == "GET" && r.URL.Path == "/api/v3/user":
			_, _ = w.Write([]byte(`{"success":true,"data":{"_id":"alice","stats":{"gp":12.7},"items":{"gear":{"owned":{"weapon_warrior_1":true,"head_lost_1":false,"head_futurePiece":true}}}}}`))
		case r.Method == "POST" && r.URL.Path == "/api/v3/tasks/user":
			w.WriteHeader(201)
			_, _ = w.Write([]byte(`{"success":true,"data":{"_id":"task"}}`))
		case r.Method == "POST" && strings.HasSuffix(r.URL.Path, "/score/down"):
			_, _ = w.Write([]byte(`{"success":true,"data":{"gp":1040.2}}`))
		case r.Method == "DELETE":
			_, _ = w.Write([]byte(`{"success":true,"data":{}}`))
		default:
			t.Error("unexpected upstream request", r.Method, r.URL.Path)
		}
	}))
	defer s.Close()
	c := New(s.URL, "tag")
	g, err := c.Gold(context.Background(), "alice", "secret", nil)
	if err != nil {
		t.Fatal(err)
	}
	// Gold is floored; the owned list is the catalogued `true` keys only
	// (a lost piece and an unknown key drop out, 4.3).
	if g.ID != "alice" || g.Gold != 12 || strings.Join(g.Owned, ",") != "weapon_warrior_1" {
		t.Fatalf("gold read: %+v", g)
	}
	id, owned, err := c.OwnedGear(context.Background(), "alice", "secret", nil)
	if err != nil || id != "alice" || strings.Join(owned, ",") != "weapon_warrior_1" {
		t.Fatalf("gear read: %q %v %v", id, owned, err)
	}
	if err = c.CreateReward(context.Background(), "alice", "secret", Reward{Type: "reward", Text: "Glimway purse: 200 gold", Notes: "note", Value: 200, Alias: "glimway-topup-x"}, nil); err != nil {
		t.Fatal(err)
	}
	after, err := c.ScoreDown(context.Background(), "alice", "secret", "glimway-topup-x", nil)
	if err != nil || after != 1040 {
		t.Fatal(after, err)
	}
	if err = c.DeleteTask(context.Background(), "alice", "secret", "glimway-topup-x", nil); err != nil {
		t.Fatal(err)
	}
	want := []string{
		"GET /api/v3/user",
		"GET /api/v3/user",
		"POST /api/v3/tasks/user",
		"POST /api/v3/tasks/glimway-topup-x/score/down",
		"DELETE /api/v3/tasks/glimway-topup-x",
	}
	if strings.Join(seen, "|") != strings.Join(want, "|") {
		t.Fatal("paths:", seen)
	}
	if !strings.Contains(bodies[2], `"alias":"glimway-topup-x"`) || !strings.Contains(bodies[2], `"value":200`) {
		t.Fatal("the reward's body:", bodies[2])
	}
}

// TestPurseCallRefusalsAreCodedAndScrubbed: the refusals the purse reads and
// writes map onto coded errors — a 401 that isn't a token is "insufficient-
// gold", a 429 carries the Retry-After it asked for, a 5xx is unknown, a 4xx
// is a definite refusal — and no error ever carries a body (finding 17's
// matchers, finding 5's wait).
func TestPurseCallRefusalsAreCodedAndScrubbed(t *testing.T) {
	cases := []struct {
		status int
		body   string
		header [2]string
		code   string
		retry  time.Duration
	}{
		{401, `{"success":false,"error":"NotAuthorized","message":"Pas assez d'or"}`, [2]string{}, "insufficient-gold", 0},
		{429, `{"success":false,"error":"RateLimitExceeded"}`, [2]string{"Retry-After", "3"}, "habitica-rate-limited", 3 * time.Second},
		{500, `secret body`, [2]string{}, "habitica-unavailable", 0},
		{404, `secret body`, [2]string{}, "invalid-request", 0},
	}
	for _, tc := range cases {
		s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set(tc.header[0], tc.header[1])
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		c := New(s.URL, "tag")
		_, err := c.ScoreDown(context.Background(), "alice", "secret", "glimway-topup-x", nil)
		s.Close()
		var e *Error
		if !errors.As(err, &e) || e.Code != tc.code {
			t.Fatalf("%d: %v", tc.status, err)
		}
		if tc.retry != 0 && e.RetryAfter != tc.retry {
			t.Fatalf("%d: Retry-After %v, want %v", tc.status, e.RetryAfter, tc.retry)
		}
		if err.Error() != tc.code || strings.Contains(err.Error(), "secret") {
			t.Fatal("body leaked into an error:", err)
		}
	}
}
