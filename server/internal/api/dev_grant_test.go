//go:build dev

package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func (x *rig) devGrant(cookie *http.Cookie, body string) *httptest.ResponseRecorder {
	x.t.Helper()
	r := httptest.NewRequest(http.MethodPost, DevGrantPath, strings.NewReader(body))
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	x.api.DevGrant(w, r)
	return w
}

func (x *rig) count(q string, args ...any) int {
	x.t.Helper()
	var n int
	if err := x.db.DB.QueryRow(q, args...).Scan(&n); err != nil {
		x.t.Fatal(err)
	}
	return n
}

func TestDevGrantGivesGlimwaysOwnThingsThroughTheStore(t *testing.T) {
	x := newRig(t)
	c, before := x.ready("dev-hero")
	account := x.accounts["dev-hero"]
	w := x.devGrant(c, `{"grants":[
		{"id":"embers","qty":100},
		{"id":"timber","qty":40},
		{"id":"recipe-page-tea","qty":2},
		{"id":"bench-axe","qty":2},
		{"id":"wooden-stool","qty":1}]}`)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	var out struct {
		State struct {
			Version float64 `json:"version"`
			Embers  struct {
				Balance float64 `json:"balance"`
			} `json:"embers"`
		} `json:"state"`
		Result struct {
			Granted []devGranted `json:"granted"`
		} `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err)
	}
	// The answer carries the new state, at a newer version, like any operation's.
	if out.State.Embers.Balance < 100 || out.State.Version <= float64(before.Version) {
		t.Fatal("state", out.State)
	}
	if len(out.Result.Granted) != 5 || out.Result.Granted[3].Kind != "instance" || out.Result.Granted[4].Kind != "decoration" {
		t.Fatal("granted", out.Result.Granted)
	}
	// Real rows, with their ledger.
	if n := x.count("SELECT COALESCE(SUM(qty),0) FROM item_stacks WHERE location='pack' AND owner=? AND item_def='timber'", account); n != 40 {
		t.Fatal("timber", n)
	}
	if n := x.count("SELECT COALESCE(SUM(qty),0) FROM item_stacks WHERE location='pack' AND owner=? AND item_def='recipe-page-tea'", account); n != 2 {
		t.Fatal("pages", n)
	}
	if n := x.count("SELECT count(*) FROM item_instances WHERE location='pack' AND owner=? AND item_def='bench-axe'", account); n != 2 {
		t.Fatal("axes", n)
	}
	if n := x.count("SELECT count(*) FROM homestead_items WHERE location='inventory' AND account_id=? AND item_def='wooden-stool'", account); n != 1 {
		t.Fatal("stool", n)
	}
	if n := x.count("SELECT count(*) FROM ledger WHERE account_id=? AND reason='dev-grant'", account); n < 6 {
		t.Fatal("ledger rows", n)
	}
	if !bytes.Contains(x.logs.Bytes(), []byte("dev grant account=")) {
		t.Fatal("not logged")
	}
}

func TestDevGrantRefusesAnythingElse(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("dev-hero")
	account := x.accounts["dev-hero"]
	for _, body := range []string{
		// Habitica's things are never Glimway's to give.
		`{"grants":[{"id":"weapon_warrior_1","qty":1}]}`,
		`{"grants":[{"id":"gold","qty":10}]}`,
		`{"grants":[{"id":"gems","qty":10}]}`,
		// Caps.
		`{"grants":[{"id":"timber","qty":0}]}`,
		`{"grants":[{"id":"timber","qty":10000}]}`,
		`{"grants":[{"id":"bench-axe","qty":21}]}`,
		`{"grants":[{"id":"embers","qty":100001}]}`,
		// Shape.
		`{"grants":[]}`,
		`{"grants":[{"id":"timber","qty":1}],"extra":1}`,
		// One bad grant refuses the lot: nothing is given.
		`{"grants":[{"id":"timber","qty":5},{"id":"habitica-gold","qty":1}]}`,
	} {
		if w := x.devGrant(c, body); w.Code != 400 {
			t.Fatal(body, w.Code, w.Body.String())
		}
	}
	if n := x.count("SELECT count(*) FROM ledger WHERE account_id=? AND reason='dev-grant'", account); n != 0 {
		t.Fatal("something was given:", n)
	}
	// Signed out: nothing.
	if w := x.devGrant(nil, `{"grants":[{"id":"embers","qty":1}]}`); w.Code != 401 {
		t.Fatal(w.Code)
	}
	r := httptest.NewRequest(http.MethodGet, DevGrantPath, nil)
	r.AddCookie(c)
	w := httptest.NewRecorder()
	x.api.DevGrant(w, r)
	if w.Code != 405 {
		t.Fatal("GET", w.Code)
	}
}
