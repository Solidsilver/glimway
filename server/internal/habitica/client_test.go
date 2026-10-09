package habitica

import (
	"context"
	"errors"
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
		p, err := New(s.URL, "tag").Verify(context.Background(), "vesper", "secret")
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
		p, err := c.Verify(context.Background(), "alice", "secret")
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
		_, err := New(s.URL, "creator-app").Verify(context.Background(), "alice", "secret")
		s.Close()
		if err == nil || strings.Contains(err.Error(), "secret") || calls.Load() != 1 {
			t.Fatalf("unsafe error/retry: %v", err)
		}
	}
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(strings.Replace(valid, `"alice"`, `"bob"`, 1)))
	}))
	defer s.Close()
	if _, err := New(s.URL, "tag").Verify(context.Background(), "alice", "secret"); err == nil {
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
	if _, err := New(s.URL, "tag").Verify(ctx, "alice", "secret"); err == nil {
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
