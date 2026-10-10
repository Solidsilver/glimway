package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"glimway/server/internal/habitica"
	"glimway/server/internal/rules"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The purse's own tests (docs/design/purse-and-wardrobe.md 10.2): every row
// of the 2.2 and 2.3 tables against the fake Habitica, the daily count with
// each state, a working row settled lazily, leftovers deleted first, a score
// that hangs while another player still gets their state, and a wrong token
// counting as a failed proof.

type purseTopUpWire struct {
	Id         string   `json:"id"`
	Amount     int      `json:"amount"`
	State      string   `json:"state"`
	GoldBefore *int     `json:"goldBefore"`
	GoldAfter  *int     `json:"goldAfter"`
	StartedAt  float64  `json:"startedAt"`
	SettledAt  *float64 `json:"settledAt"`
	Leftover   bool     `json:"leftover"`
	Note       string   `json:"note"`
}

// topUpAnswer is the envelope the client reads (lane D): the row under
// purseTopUp, or the refusal's code.
type topUpAnswer struct {
	PurseTopUp struct {
		TopUp purseTopUpWire `json:"topUp"`
	} `json:"purseTopUp"`
	Error *struct {
		Code string `json:"code"`
	} `json:"error"`
}

func (a topUpAnswer) row() purseTopUpWire { return a.PurseTopUp.TopUp }

type purseLineWire struct {
	At        float64 `json:"at"`
	Delta     int     `json:"delta"`
	Reason    string  `json:"reason"`
	ItemDef   string  `json:"itemDef"`
	Qty       int     `json:"qty"`
	OtherName string  `json:"otherName"`
	MailId    string  `json:"mailId"`
	MailState string  `json:"mailState"`
	Seller    string  `json:"seller"`
}

// purseReadWire is GET /api/purse's result (2.7): the purse, the last 50
// top-ups and the last 50 gold lines.
type purseReadWire struct {
	Purse struct {
		TopUpsLeft int             `json:"topUpsLeft"`
		Working    *purseTopUpWire `json:"working"`
	} `json:"purse"`
	TopUps []purseTopUpWire `json:"topUps"`
	Lines  []purseLineWire  `json:"lines"`
}

// wardrobeCheckAnswer is the envelope lane E reads: the list under
// wardrobeCheck, or the refusal's code.
type wardrobeCheckAnswer struct {
	State struct {
		Version  int64 `json:"version"`
		Wardrobe struct {
			Chosen map[string]string `json:"chosen"`
		} `json:"wardrobe"`
	} `json:"state"`
	WardrobeCheck struct {
		Owned     []string `json:"owned"`
		CheckedAt float64  `json:"checkedAt"`
		NewPieces int      `json:"newPieces"`
	} `json:"wardrobeCheck"`
	Error *struct {
		Code string `json:"code"`
	} `json:"error"`
}

// topUp posts one top-up and answers with the envelope: the row under
// purseTopUp, or the refusal's code.
func (x *rig) topUp(lease, key string, amount int, token string, c *http.Cookie) (int, topUpAnswer) {
	x.t.Helper()
	w := x.rawHTTP("POST", "/api/purse/top-up", map[string]any{
		"op":     map[string]any{"lease": lease, "key": key},
		"token":  token,
		"amount": amount,
	}, c)
	var out topUpAnswer
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		x.t.Fatalf("top-up: invalid JSON: %v\n%s", err, w.Body.String())
	}
	return w.Code, out
}

func (x *rig) topUpOK(s response, key string, amount int, c *http.Cookie) purseTopUpWire {
	x.t.Helper()
	status, out := x.topUp(s.Lease, key, amount, secret, c)
	if status != 200 {
		x.t.Fatalf("top-up: got %d %v", status, out.Error)
	}
	return out.row()
}

func (x *rig) purseRead(c *http.Cookie) purseReadWire {
	x.t.Helper()
	w := x.rawHTTP("GET", "/api/purse", nil, c)
	if w.Code != 200 {
		x.t.Fatalf("GET /api/purse: %d %s", w.Code, w.Body.String())
	}
	var envelope struct {
		State  json.RawMessage `json:"state"`
		Result purseReadWire   `json:"result"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
		x.t.Fatalf("purse read: invalid JSON: %v\n%s", err, w.Body.String())
	}
	if len(envelope.State) == 0 {
		x.t.Fatal("a domain read carries the current state as well")
	}
	return envelope.Result
}

func (x *rig) goldBalance(account string) int {
	x.t.Helper()
	// The glims top-ups brought (the balance also holds the welcome).
	return count(x.t, x.db, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE account_id=? AND currency='glims' AND reason IN ('habitica-topup','purse-settle')", account)
}

func (x *rig) topUpRow(id string) purseTopUpWire {
	x.t.Helper()
	var out purseTopUpWire
	var state, note string
	var leftover int
	var goldBefore, goldAfter, settledAt int64
	var started float64
	var before, after, settled sqlNull
	err := x.db.DB.QueryRow("SELECT amount,state,gold_before,gold_after,note,leftover,created_at,settled_at FROM purse_topups WHERE id=?", id).Scan(&out.Amount, &state, &before, &after, &note, &leftover, &started, &settled)
	if err != nil {
		x.t.Fatal(err)
	}
	goldBefore, goldAfter, settledAt = before.v, after.v, settled.v
	out.Id, out.State, out.Note, out.Leftover, out.StartedAt = id, state, note, leftover == 1, started
	if before.set {
		v := int(goldBefore)
		out.GoldBefore = &v
	}
	if after.set {
		v := int(goldAfter)
		out.GoldAfter = &v
	}
	if settled.set {
		v := float64(settledAt)
		out.SettledAt = &v
	}
	return out
}

// sqlNull is one nullable integer column.
type sqlNull struct {
	v   int64
	set bool
}

func (n *sqlNull) Scan(src any) error {
	if src == nil {
		n.v, n.set = 0, false
		return nil
	}
	switch t := src.(type) {
	case int64:
		n.v, n.set = t, true
	case float64:
		n.v, n.set = int64(t), true
	default:
		return fmt.Errorf("unexpected column type %T", src)
	}
	return nil
}

// TestPurseTopUpMovesGold walks 2.2's happy row: the read, the create, the
// score down, the delete, and the settle — the purse credited, one ledger
// row, the version moved, the owned gear stored (4.3), one top-up left
// today (2.5).
func TestPurseTopUpMovesGold(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.setGold(1240)
	// Owned gear (4.3): `true` is owned, `false` is gear had and lost, and
	// an unknown key can't be drawn and is dropped.
	x.setOwned(map[string]bool{"weapon_warrior_1": true, "armor_warrior_1": true, "head_armoire_0": false, "head_futurePiece": true})
	row := x.topUpOK(s, "k1", 200, c)
	if row.State != "moved" || row.Amount != 200 {
		t.Fatalf("row %+v", row)
	}
	if row.GoldBefore == nil || *row.GoldBefore != 1240 || row.GoldAfter == nil || *row.GoldAfter != 1040 {
		t.Fatalf("Habitica's gold: %+v", row)
	}
	if row.Leftover || row.Note != "" || row.SettledAt == nil {
		t.Fatalf("settling: %+v", row)
	}
	account := x.account("alice")
	if x.goldBalance(account) != 200 {
		t.Fatal("purse not credited")
	}
	if count(x.t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND currency='glims' AND earned_delta=0 AND reason='habitica-topup' AND ref=?", account, row.Id) != 1 {
		t.Fatal("top-up's ledger row")
	}
	var version int
	if err := x.db.DB.QueryRow("SELECT version FROM players WHERE account_id=?", account).Scan(&version); err != nil || version < 2 {
		t.Fatal("version did not move", version, err)
	}
	owned := queryGear(t, x, account)
	if strings.Join(owned, ",") != "armor_warrior_1,weapon_warrior_1" {
		t.Fatal("player_gear", owned)
	}
	if x.rewardLeft("glimway-topup-" + row.Id) {
		t.Fatal("the reward was not removed")
	}
	if x.scoreCalls() != 1 {
		t.Fatal("scored more than once")
	}
	// The purse on the next answer (PlayerState.purse), and the log.
	read := x.purseRead(c)
	if x.goldBalance(account) != 200 || read.Purse.TopUpsLeft != 1 || read.Purse.Working != nil {
		t.Fatalf("purse %+v", read.Purse)
	}
	if len(read.TopUps) != 1 || read.TopUps[0].Id != row.Id {
		t.Fatalf("log top-ups %+v", read.TopUps)
	}
	found := false
	for _, line := range read.Lines {
		if line.Reason == "habitica-topup" && line.Delta == 200 {
			found = true
		}
	}
	if !found {
		t.Fatalf("log lines %+v", read.Lines)
	}
}

func queryGear(t *testing.T, x *rig, account string) []string {
	t.Helper()
	var raw string
	if err := x.db.DB.QueryRow("SELECT owned_json FROM player_gear WHERE account_id=?", account).Scan(&raw); err != nil {
		t.Fatal(err)
	}
	out := []string{}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatal(err)
	}
	return out
}

// TestPurseTopUpRepeatedKey: a repeated key returns the same top-up and
// makes no new calls; the same key with another amount is a mismatch (2.2).
func TestPurseTopUpRepeatedKey(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.setGold(500)
	first := x.topUpOK(s, "same-key", 100, c)
	callsAfter := len(x.habiticaCalls())
	again := x.topUpOK(s, "same-key", 100, c)
	if again.Id != first.Id || again.State != "moved" {
		t.Fatalf("repeat answered %+v", again)
	}
	if len(x.habiticaCalls()) != callsAfter {
		t.Fatal("a repeated key called Habitica again:", x.habiticaCalls())
	}
	status, out := x.topUp(s.Lease, "same-key", 200, secret, c)
	if status != 409 || out.Error == nil || out.Error.Code != "idempotency-mismatch" {
		t.Fatalf("mismatch: %d %+v", status, out.Error)
	}
	if x.scoreCalls() != 1 {
		t.Fatal("the mismatch scored again")
	}
}

// TestPurseTopUpRefusals covers 2.2's refusal rows and 2.5's daily count
// with each state: a top-up that moved nothing never uses up the day, and
// only one top-up works at a time.
func TestPurseTopUpRefusals(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.setGold(1000)
	for _, amount := range []int{0, -5, 100000000} {
		status, out := x.topUp(s.Lease, "bad", amount, secret, c)
		if status != 400 || out.Error == nil || out.Error.Code != "invalid-quantity" {
			t.Fatalf("amount %d: %d %+v", amount, status, out.Error)
		}
	}
	// A guest has no top-up (section 5).
	if _, err := x.db.DB.Exec("UPDATE players SET profile_source='none' WHERE account_id=?", x.account("alice")); err != nil {
		t.Fatal(err)
	}
	status, out := x.topUp(s.Lease, "guest", 10, secret, c)
	if status != 409 || out.Error == nil || out.Error.Code != "needs-habitica" {
		t.Fatalf("guest: %d %+v", status, out.Error)
	}
	if _, err := x.db.DB.Exec("UPDATE players SET profile_source='habitica' WHERE account_id=?", x.account("alice")); err != nil {
		t.Fatal(err)
	}
	// not-enough and not-moved don't use up the day; moved and unconfirmed
	// do (2.5).
	x.setScore("not-enough-gold")
	if row := x.topUpOK(s, "n1", 10, c); row.State != "not-enough" {
		t.Fatal(row.State)
	}
	x.setScore("error")
	x.setPurseChecks([]time.Duration{time.Millisecond})
	if row := x.topUpOK(s, "n2", 10, c); row.State != "not-moved" {
		t.Fatal(row.State)
	}
	read := x.purseRead(c)
	if read.Purse.TopUpsLeft != 2 {
		t.Fatal("a top-up that moved nothing used up the day", read.Purse.TopUpsLeft)
	}
	x.setScore("timeout-partial")
	if row := x.topUpOK(s, "n3", 10, c); row.State != "unconfirmed" {
		t.Fatal(row.State)
	}
	if read = x.purseRead(c); read.Purse.TopUpsLeft != 1 {
		t.Fatal("unconfirmed did not count", read.Purse.TopUpsLeft)
	}
	x.setScore("ok")
	if row := x.topUpOK(s, "n4", 10, c); row.State != "moved" {
		t.Fatal(row.State)
	}
	status, out = x.topUp(s.Lease, "n5", 10, secret, c)
	if status != 409 || out.Error == nil || out.Error.Code != "top-up-limit" {
		t.Fatalf("third top-up: %d %+v", status, out.Error)
	}
	// A new UTC day starts the count again.
	x.now.Store(x.now.Load() + 2*86400)
	x.expect("GET", "/api/state", nil, c, 200)
	if read = x.purseRead(c); read.Purse.TopUpsLeft != 2 {
		t.Fatal("the day did not start again", read.Purse.TopUpsLeft)
	}
	if row := x.topUpOK(s, "n6", 10, c); row.State != "moved" {
		t.Fatal(row.State)
	}
}

// setPurseChecks is the balance-check schedule for a test (design 2.3 is
// tuned for tests).
func (x *rig) setPurseChecks(checks []time.Duration) {
	x.api.Config.PurseChecks = checks
}

// TestPurseTopUpUnknownOutcomes is 2.3's table, and the rule under it: the
// score is never sent again after an unknown outcome.
func TestPurseTopUpUnknownOutcomes(t *testing.T) {
	cases := []struct {
		name, score string
		downAfter   int
		want        string
		note        string
		credited    int
	}{
		{"a check confirms the move", "timeout-moved", 0, "moved", "checked", 300},
		{"the last check says not moved", "error", 0, "not-moved", "timeout", 0},
		{"a check reads between", "timeout-partial", 0, "unconfirmed", "timeout", 0},
		{"every check fails", "error", 4, "unconfirmed", "timeout", 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			x := newRig(t)
			c, s := x.ready("alice")
			x.setGold(1000)
			x.setScore(tc.score)
			x.setDownAfter(tc.downAfter)
			x.setPurseChecks([]time.Duration{time.Millisecond, 2 * time.Millisecond})
			row := x.topUpOK(s, "k", 300, c)
			if row.State != tc.want || row.Note != tc.note {
				t.Fatalf("got %+v, want %s/%s", row, tc.want, tc.note)
			}
			if x.goldBalance(x.account("alice")) != tc.credited {
				t.Fatal("credited", x.goldBalance(x.account("alice")))
			}
			// The score is sent once, never twice after an unknown outcome.
			if x.scoreCalls() != 1 {
				t.Fatal("scored", x.scoreCalls(), "times")
			}
			// The row keeps the evidence (2.3: "both leave gold_before and
			// the readings in the log").
			if row.GoldBefore == nil || *row.GoldBefore != 1000 {
				t.Fatalf("gold_before %v", row.GoldBefore)
			}
			if tc.want == "moved" && (row.GoldAfter == nil || *row.GoldAfter != 700) {
				t.Fatalf("gold_after %v", row.GoldAfter)
			}
		})
	}
}

// TestPurseTopUpCreateFailureLeavesNoCharge: a refused create settles
// `not-moved` — nothing was scored, so nothing was charged — and leaves no
// mark behind (2.2 step c). An **unknown** create (a timeout, a network
// error, a 5xx) keeps its leftover mark whatever the delete finds (finding
// 9): the reward may still land on Habitica's side after the delete looked.
func TestPurseTopUpCreateFailure(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.setGold(500)
	x.setCreate("refused")
	row := x.topUpOK(s, "k", 100, c)
	if row.State != "not-moved" || row.Leftover {
		t.Fatalf("a refused create: %+v", row)
	}
	if x.goldBalance(x.account("alice")) != 0 || x.scoreCalls() != 0 {
		t.Fatal("a refused create charged something")
	}
	// The create timed out on our side and may still be running on
	// Habitica's: the mark stays even though the delete found nothing.
	x.setCreate("error")
	row = x.topUpOK(s, "k2", 100, c)
	if row.State != "not-moved" || !row.Leftover {
		t.Fatalf("an unknown create: %+v", row)
	}
	// The same create failing while the delete fails too.
	x.setDelete("error")
	row = x.topUpOK(s, "k3", 100, c)
	if row.State != "not-moved" || !row.Leftover {
		t.Fatalf("%+v", row)
	}
}

// TestPurseTopUpLeftoversDeletedFirst: a reward an earlier top-up left
// behind is removed before anything else (2.2 step a), and its mark clears.
func TestPurseTopUpLeftoversDeletedFirst(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.setGold(500)
	x.setDelete("error")
	first := x.topUpOK(s, "k1", 100, c)
	if !first.Leftover {
		t.Fatal("expected a leftover mark")
	}
	alias := "glimway-topup-" + first.Id
	if !x.rewardLeft(alias) {
		t.Fatal("the reward should still be in the hero's Rewards")
	}
	x.setDelete("ok")
	callsBefore := x.habiticaCalls()
	second := x.topUpOK(s, "k2", 100, c)
	if second.State != "moved" {
		t.Fatal(second.State)
	}
	calls := x.habiticaCalls()[len(callsBefore):]
	// The gold read comes first (finding 7: it proves the token), and the
	// leftover's delete runs before this top-up's own create.
	deleted, created := -1, -1
	for i, call := range calls {
		if call == "delete:"+alias && deleted < 0 {
			deleted = i
		}
		if call == "create" {
			created = i
		}
	}
	if deleted < 0 || created < 0 || deleted > created {
		t.Fatal("the leftover was not deleted before the create:", calls)
	}
	if x.rewardLeft(alias) {
		t.Fatal("the leftover reward was not removed")
	}
	if row := x.topUpRow(first.Id); row.Leftover {
		t.Fatal("the leftover mark was not cleared")
	}
}

// TestPurseSettlesWorkingRowsWhenSomeoneLooks is 2.4: a working row older
// than 90 seconds has no live worker behind it, and settles as unconfirmed
// if it got as far as scoring or checking, not-moved if it stopped at
// reserved or created — marked leftover from `created` on.
func TestPurseSettlesWorkingRowsWhenSomeoneLooks(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("alice")
	account := x.account("alice")
	now := x.now.Load()
	states := map[string]struct {
		want, note string
		leftover   bool
	}{
		"reserved": {"not-moved", "", false},
		"created":  {"not-moved", "", true},
		"scoring":  {"unconfirmed", "timeout", true},
		"checking": {"unconfirmed", "timeout", true},
	}
	for state, want := range states {
		id := "row-" + state
		if _, err := x.db.DB.Exec("INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at) VALUES(?,?,?,20,?,?)", id, account, "key-"+state, state, now-91); err != nil {
			t.Fatal(err)
		}
		read := x.purseRead(c)
		if read.Purse.Working != nil {
			t.Fatalf("%s: the stale row still reads as working", state)
		}
		row := x.topUpRow(id)
		if row.State != want.want || row.Note != want.note || row.Leftover != want.leftover {
			t.Fatalf("%s: settled %+v, want %+v", state, row, want)
		}
		if row.SettledAt == nil {
			t.Fatal(state, "not settled")
		}
		if settledBy(t, x, id) != "look" {
			t.Fatal(state, "settled by", settledBy(t, x, id))
		}
		// A younger working row is left alone (2.4 works out the time; it
		// never ticks a row over on its own).
		if _, err := x.db.DB.Exec("INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at) VALUES(?,?,?,20,'reserved',?)", "young-"+state, account, "young-"+state, now-10); err != nil {
			t.Fatal(err)
		}
		read = x.purseRead(c)
		if read.Purse.Working == nil || read.Purse.Working.Id != "young-"+state || read.Purse.Working.State != "working" {
			t.Fatalf("%s: the live row should still read as working: %+v", state, read.Purse.Working)
		}
		if _, err := x.db.DB.Exec("DELETE FROM purse_topups WHERE account_id=?", account); err != nil {
			t.Fatal(err)
		}
	}
	// Nothing was credited: a row nobody confirmed never adds gold.
	if x.goldBalance(account) != 0 {
		t.Fatal("a lazy settle credited gold")
	}
}

// TestPurseReadShowsEveryLineKind: GET /api/purse reads every kind of gold
// line out of the ledger (2.1's log) — a buy at a seller, a shelf trade, a
// letter waiting or collected or come back, a recall, and gold by hand —
// naming the seller and the other player and saying where each letter is
// now. Lane C writes the rows; this read maps them (see .agent/EARLY.md).
func TestPurseReadShowsEveryLineKind(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.ready("bob")
	alice, bobID := x.account("alice"), x.account("bob")
	now := x.now.Load()
	world := s.WorldID
	// The letters these lines name (3.3): one waiting, one collected, one
	// expired back, one recalled back.
	for _, letter := range []struct {
		id, from, to, claimed, returned, reason string
	}{
		{"m-waiting", alice, bobID, "", "", ""},
		{"m-collected", alice, bobID, "1", "", ""},
		{"m-expired", alice, bobID, "", "1", "expired"},
		{"m-recalled", alice, bobID, "", "1", "recalled"},
	} {
		claimed, returned, reason := "NULL", "NULL", "NULL"
		if letter.claimed != "" {
			claimed = "1"
		}
		if letter.returned != "" {
			returned, reason = "2", "'"+letter.reason+"'"
		}
		if _, err := x.db.DB.Exec("INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at,claimed_at,returned_at,return_reason) VALUES('" + letter.id + "','" + world + "','" + letter.from + "','" + letter.to + "','glims','glims',20,'[]','[]'," + strconv.FormatInt(now, 10) + "," + claimed + "," + returned + "," + reason + ")"); err != nil {
			t.Fatal(err)
		}
	}
	// The glims rows, exactly as lane C writes them.
	rows := []struct {
		delta       int
		reason, ref string
	}{
		{-6, "market-buy", "silas-yard:timber"},
		{-12, "shelf-buy", bobID + ":timber"},
		{12, "shelf-sale", bobID + ":timber"},
		{-20, "mail-send", "m-waiting"},
		{-20, "mail-send", "m-collected"},
		{20, "mail-return", "m-expired"},
		{20, "mail-recall", "m-recalled"},
		{-15, "give", bobID},
	}
	for i, row := range rows {
		if _, err := x.db.DB.Exec("INSERT INTO ledger(account_id,currency,delta,earned_delta,reason,ref,created_at) VALUES(?,'glims',?,0,?,?,?)", alice, row.delta, row.reason, row.ref, now-100+int64(i)); err != nil {
			t.Fatal(err)
		}
	}
	read := x.purseRead(c)
	byReason := map[string][]purseLineWire{}
	for _, line := range read.Lines {
		byReason[line.Reason] = append(byReason[line.Reason], line)
	}
	market := byReason["market-buy"][0]
	if market.Delta != -6 || market.ItemDef != "timber" || market.Qty != 4 || market.Seller != "Silas" {
		t.Fatalf("market line %+v", market)
	}
	shelf := byReason["shelf-buy"][0]
	if shelf.ItemDef != "timber" || shelf.OtherName != "Hero" {
		t.Fatalf("shelf line %+v", shelf)
	}
	if sale := byReason["shelf-sale"][0]; sale.Delta != 12 || sale.OtherName != "Hero" {
		t.Fatalf("shelf sale %+v", sale)
	}
	var waiting, collected purseLineWire
	for _, line := range byReason["mail-send"] {
		switch line.MailId {
		case "m-waiting":
			waiting = line
		case "m-collected":
			collected = line
		}
	}
	if waiting.MailState != "waiting" || waiting.OtherName != "Hero" || waiting.MailId != "m-waiting" {
		t.Fatalf("waiting letter %+v", waiting)
	}
	if collected.MailState != "collected" || collected.MailId != "m-collected" {
		t.Fatalf("collected letter %+v", collected)
	}
	if back := byReason["mail-return"][0]; back.MailState != "came-back" || back.Delta != 20 {
		t.Fatalf("returned letter %+v", back)
	}
	if recall := byReason["mail-recall"][0]; recall.MailState != "came-back" {
		t.Fatalf("recalled letter %+v", recall)
	}
	if give := byReason["give"][0]; give.Delta != -15 || give.OtherName != "Hero" {
		t.Fatalf("give %+v", give)
	}
}

// TestPurseTopUpSettlesADeadWorkersRow: the next top-up's reserve settles a
// stale working row first (2.4) instead of answering `purse-busy` — and a
// live one still does.
func TestPurseTopUpSettlesADeadWorkersRow(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	account := x.account("alice")
	now := x.now.Load()
	x.setGold(500)
	// A live working row: only one top-up works at a time.
	if _, err := x.db.DB.Exec("INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at) VALUES('live',?,'live',20,'checking',?)", account, now-10); err != nil {
		t.Fatal(err)
	}
	if status, out := x.topUp(s.Lease, "k1", 100, secret, c); status != 409 || out.Error == nil || out.Error.Code != "purse-busy" {
		t.Fatalf("a live worker's row: %d %v", status, out.Error)
	}
	// The same row, ninety seconds on: it has no live worker behind it and
	// settles when the next top-up looks.
	if _, err := x.db.DB.Exec("UPDATE purse_topups SET created_at=? WHERE id='live'", now-91); err != nil {
		t.Fatal(err)
	}
	row := x.topUpOK(s, "k2", 100, c)
	if row.State != "moved" {
		t.Fatal(row.State)
	}
	dead := x.topUpRow("live")
	if dead.State != "unconfirmed" || settledBy(t, x, "live") != "look" {
		t.Fatalf("the dead worker's row: %+v", dead)
	}
}

func settledBy(t *testing.T, x *rig, id string) string {
	t.Helper()
	var by string
	if err := x.db.DB.QueryRow("SELECT settled_by FROM purse_topups WHERE id=?", id).Scan(&by); err != nil {
		t.Fatal(err)
	}
	return by
}

// TestPurseHangsWhileAnotherPlayerReadsState: the top-up's calls run outside
// every transaction, so a Habitica that hangs on the score holds nobody
// else up (review finding 10).
func TestPurseHangsWhileAnotherPlayerReadsState(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bob, _ := x.ready("bob")
	x.setGold(500)
	x.setScore("hang")
	x.setHang(2 * time.Second)
	// Short checks and a short wait: the worker must not outlive the test
	// (finding 11 — Close drains it, but a test shouldn't need 35 s).
	x.setPurseChecks([]time.Duration{time.Millisecond, 2 * time.Millisecond})
	x.api.Config.PurseAnswerWait = 50 * time.Millisecond
	done := make(chan int, 1)
	go func() {
		status, _ := x.topUp(s.Lease, "slow", 100, secret, c)
		done <- status
	}()
	// While the score hangs, another player's state answers at once.
	start := time.Now()
	bobState := x.expect("GET", "/api/state", nil, bob, 200)
	if elapsed := time.Since(start); elapsed > time.Second {
		t.Fatal("another player's state waited on the score:", elapsed)
	}
	if bobState.AccountID == "" {
		t.Fatal("no state")
	}
	if status := <-done; status != 200 {
		t.Fatal("top-up answered", status)
	}
}

// TestWrongTokenCountsAsFailedProof: a wrong token on a top-up or a gear
// check settles nothing and counts as a rejected identity proof, as a wrong
// sign-in token does (2.2 step b, 4.3).
func TestWrongTokenCountsAsFailedProof(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.setGold(500)
	for i := 0; i < proofFailureLimit; i++ {
		status, out := x.topUp(s.Lease, fmt.Sprintf("bad-%d", i), 100, "WRONG-TOKEN", c)
		if status != 200 {
			t.Fatalf("attempt %d: %d %v", i, status, out.Error)
		}
		row := x.topUpRow(out.row().Id)
		if row.State != "not-moved" || row.Note != "habitica-auth" {
			t.Fatalf("attempt %d: %+v", i, row)
		}
	}
	if x.scoreCalls() != 0 {
		t.Fatal("a wrong token got as far as scoring")
	}
	status, out := x.topUp(s.Lease, "one-too-many", 100, secret, c)
	if status != 429 || out.Error == nil || out.Error.Code != "login-user-rate-limited" {
		t.Fatalf("proofs not counted: %d %+v", status, out.Error)
	}
	// The same for the wardrobe's gear check.
	x2 := newRig(t)
	c2, s2 := x2.ready("alice")
	for i := 0; i < proofFailureLimit; i++ {
		status, out := x2.checkGear(s2.Lease, "WRONG-TOKEN", c2)
		code := ""
		if out.Error != nil {
			code = out.Error.Code
		}
		if status != 401 || code != "habitica-auth" {
			t.Fatalf("check %d: %d %s", i, status, code)
		}
	}
	if status, out := x2.checkGear(s2.Lease, secret, c2); status != 429 || out.Error == nil || out.Error.Code != "login-user-rate-limited" {
		t.Fatalf("check proofs not counted: %d %v", status, out.Error)
	}
}

// checkGear posts the wardrobe's gear check and answers with its status and
// any refusal's code.
func (x *rig) checkGear(lease, token string, c *http.Cookie) (int, wardrobeCheckAnswer) {
	x.t.Helper()
	w := x.rawHTTP("POST", "/api/wardrobe/check", map[string]any{"lease": lease, "token": token}, c)
	var out wardrobeCheckAnswer
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w.Code, out
}

// TestWardrobeCheck: one token read of items.gear.owned, written to
// player_gear (4.3), counted as new pieces since the last stored list.
func TestWardrobeCheck(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	account := x.account("alice")
	// The sign-in read writes the list (4.3): what the hero owns turns up in
	// the picker without a check. Clear it and sign in again to see it land.
	if _, err := x.db.DB.Exec("DELETE FROM player_gear WHERE account_id=?", account); err != nil {
		t.Fatal(err)
	}
	x.setOwned(map[string]bool{"weapon_warrior_1": true})
	x.login("alice", "")
	if got := queryGear(t, x, account); strings.Join(got, ",") != "weapon_warrior_1" {
		t.Fatal("the sign-in read did not write player_gear:", got)
	}
	// The check finds a piece the fake just added.
	x.setOwned(map[string]bool{"weapon_warrior_1": true, "armor_warrior_1": true, "head_lost_1": false})
	status, out := x.checkGear(s.Lease, secret, c)
	if status != 200 {
		t.Fatalf("check: %d %v", status, out.Error)
	}
	if strings.Join(out.WardrobeCheck.Owned, ",") != "armor_warrior_1,weapon_warrior_1" {
		t.Fatal("owned", out.WardrobeCheck.Owned)
	}
	if out.WardrobeCheck.NewPieces != 1 {
		t.Fatal("new pieces", out.WardrobeCheck.NewPieces)
	}
	if out.WardrobeCheck.CheckedAt == 0 {
		t.Fatal("no checked_at")
	}
	if got := queryGear(t, x, account); strings.Join(got, ",") != "armor_warrior_1,weapon_warrior_1" {
		t.Fatal("player_gear", got)
	}
	// A check that changes nothing moves no version.
	x.chooseWardrobe(c, s, "wear", map[string]string{"armor": "armor_warrior_1"}, 200)
	version := count(t, x.db, "SELECT version FROM players WHERE account_id=?", account)
	if _, same := x.checkGear(s.Lease, secret, c); same.State.Version != int64(version) || same.State.Wardrobe.Chosen["armor"] != "armor_warrior_1" {
		t.Fatalf("an unchanged check: version %d (was %d), %v", same.State.Version, version, same.State.Wardrobe.Chosen)
	}
	// A lapsed piece reads as gone after a check without it (4.2's rule is
	// the wardrobe's; the stored list is the server's own read). The resolved
	// choice on the state changed, so the answer is a newer version: a
	// client holding the old one adopts it.
	x.setOwned(map[string]bool{"weapon_warrior_1": true})
	_, lapsed := x.checkGear(s.Lease, secret, c)
	if got := queryGear(t, x, account); strings.Join(got, ",") != "weapon_warrior_1" {
		t.Fatal("player_gear after a lapsed piece", got)
	}
	if lapsed.State.Version <= int64(version) || len(lapsed.State.Wardrobe.Chosen) != 0 {
		t.Fatalf("a lapsed piece: version %d (was %d), %v", lapsed.State.Version, version, lapsed.State.Wardrobe.Chosen)
	}
	// A guest has no wardrobe (section 5).
	if _, err := x.db.DB.Exec("UPDATE players SET profile_source='none' WHERE account_id=?", account); err != nil {
		t.Fatal(err)
	}
	status, refused := x.checkGear(s.Lease, secret, c)
	if status != 409 || refused.Error == nil || refused.Error.Code != "needs-habitica" {
		t.Fatalf("guest check: %d %v", status, refused.Error)
	}
}

// TestPurseTopUpViaStub: the four calls sit behind habitica.Upstream (2.7),
// so a test can inject "the score timed out after Habitica ran it" — the
// case the balance checks exist for, without a network at all.
func TestPurseTopUpViaStub(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	stub := &timedOutAfterScore{subject: "alice", gold: 1000}
	x.api.Habitica = stub
	x.setPurseChecks([]time.Duration{time.Millisecond, 2 * time.Millisecond})
	row := x.topUpOK(s, "k", 250, c)
	if row.State != "moved" || row.Note != "checked" {
		t.Fatalf("%+v", row)
	}
	if stub.scored != 1 {
		t.Fatal("scored", stub.scored)
	}
	if x.goldBalance(x.account("alice")) != 250 {
		t.Fatal("not credited")
	}
}

// timedOutAfterScore is the injected upstream: it charges the purse and
// answers nothing, so the worker must read the outcome off the balance.
type timedOutAfterScore struct {
	subject string
	gold    int
	scored  int
}

func (s *timedOutAfterScore) VerifyLimited(_ context.Context, id, _ string, _ func() bool) (rules.Profile, []string, error) {
	p := profile(id, 1, 0, 20)
	return p, []string{"weapon_warrior_1"}, nil
}

func (s *timedOutAfterScore) Gold(_ context.Context, _ string, _ string, _ func() bool) (habitica.Gold, error) {
	return habitica.Gold{ID: s.subject, Gold: s.gold, Owned: []string{"weapon_warrior_1"}}, nil
}

func (s *timedOutAfterScore) OwnedGear(_ context.Context, _ string, _ string, _ func() bool) (string, []string, error) {
	return s.subject, []string{"weapon_warrior_1"}, nil
}

func (s *timedOutAfterScore) CreateReward(_ context.Context, _ string, _ string, _ habitica.Reward, _ func() bool) error {
	return nil
}

func (s *timedOutAfterScore) ScoreDown(_ context.Context, _ string, _ string, _ string, _ func() bool) (int, error) {
	s.scored++
	// Habitica ran the charge; the answer never arrived.
	s.gold -= 250
	return 0, &habitica.Error{Code: "habitica-unavailable", Status: 502, Sent: true}
}

func (s *timedOutAfterScore) DeleteTask(_ context.Context, _ string, _ string, _ string, _ func() bool) error {
	return nil
}

var _ habitica.Upstream = (*timedOutAfterScore)(nil)

// TestPurseTopUpScoreRateLimited: one 429 is Habitica refusing before it
// ran the score — wait the Retry-After it sent and send it once more (2.2
// step d, finding 5). Two 429s mean nothing was charged, and the checks
// decide from the balance. The score is never sent a third time.
func TestPurseTopUpScoreRateLimited(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.setGold(1000)
	x.setScore("rate-limited-once")
	row := x.topUpOK(s, "k1", 300, c)
	if row.State != "moved" || x.scoreCalls() != 2 {
		t.Fatalf("one 429 then moved: %+v after %d scores", row, x.scoreCalls())
	}
	x.setScore("rate-limited")
	x.setPurseChecks([]time.Duration{time.Millisecond, 2 * time.Millisecond})
	row = x.topUpOK(s, "k2", 300, c)
	if x.scoreCalls() != 4 {
		t.Fatal("two 429s sent the score more than twice:", x.scoreCalls())
	}
	if row.State != "not-moved" {
		t.Fatalf("two 429s, and the checks say the balance never moved: %+v", row)
	}
}

// TestPurseTopUpScoreRefusedByOurBudget (finding 4): our own budget
// refusing the score means it was never sent — nothing left the server, so
// nothing was charged. It is never an unknown outcome and never runs the
// checks.
func TestPurseTopUpScoreRefusedByOurBudget(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.setGold(500)
	// Two upstream calls pass — the gold read and the create — and our own
	// budget refuses the third, the score, before it goes out.
	x.api.loginGlobal.rate = 2
	x.setPurseChecks([]time.Duration{time.Millisecond})
	row := x.topUpOK(s, "k", 100, c)
	if row.State != "not-moved" || row.Note != "habitica-rate-limited" {
		t.Fatalf("%+v", row)
	}
	if x.scoreCalls() != 0 {
		t.Fatal("a refused score reached Habitica")
	}
	if x.goldBalance(x.account("alice")) != 0 {
		t.Fatal("a refused score credited gold")
	}
}

// TestPurseTopUpGoldReadIdentityMismatch: a read that answered for someone
// else is a refused token (2.2 step b, finding 8's rule on the gold read).
func TestPurseTopUpGoldReadIdentityMismatch(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	stub := &timedOutAfterScore{subject: "someone-else", gold: 1000}
	x.api.Habitica = stub
	row := x.topUpOK(s, "k", 100, c)
	if row.State != "not-moved" || row.Note != "habitica-auth" {
		t.Fatalf("%+v", row)
	}
	if stub.scored != 0 {
		t.Fatal("a mismatched read still got as far as scoring")
	}
}

// TestPurseTopUpLastCheckDecides (finding 2): `not-moved` comes only from
// the final scheduled check's reading. A last check that fails — or never
// runs — after an earlier reading of gold_before decides nothing: the
// timed-out score may still have been running on Habitica's side.
func TestPurseTopUpLastCheckDecides(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.setGold(1000)
	x.setScore("error") // unknown, nothing charged
	// Calls: the gold read, the create, the score, the first check — then
	// Habitica goes down and the last check fails.
	x.setDownAfter(5)
	x.setPurseChecks([]time.Duration{time.Millisecond, 2 * time.Millisecond})
	row := x.topUpOK(s, "k", 300, c)
	if row.State != "unconfirmed" {
		t.Fatalf("%+v: the last check failed, so nothing is decided", row)
	}
}

// TestPurseTopUpCheckingMarkFailure (finding 1): an unknown score is
// `unconfirmed` from the start of that branch, and a failed `checking` mark
// is not fatal — the checks run anyway, and settling is what makes the row
// final.
func TestPurseTopUpCheckingMarkFailure(t *testing.T) {
	failMark := func(x *rig) {
		x.api.topUpMark = func(id, state string) error {
			if state == "checking" {
				return errors.New("the checking mark could not be written")
			}
			return nil
		}
	}
	x := newRig(t)
	c, s := x.ready("alice")
	x.setGold(1000)
	failMark(x)
	x.setScore("timeout-moved") // the charge happened; the answer didn't
	x.setPurseChecks([]time.Duration{time.Millisecond, 2 * time.Millisecond})
	row := x.topUpOK(s, "k", 300, c)
	if row.State != "moved" || row.Note != "checked" {
		t.Fatalf("%+v: the checks ran despite the failed mark", row)
	}
	// And an undecided one is never `not-moved`, whatever the marks do.
	x2 := newRig(t)
	c2, s2 := x2.ready("alice")
	x2.setGold(1000)
	failMark(x2)
	x2.setScore("error")
	x2.setDownAfter(4) // every check fails
	x2.setPurseChecks([]time.Duration{time.Millisecond, 2 * time.Millisecond})
	if row := x2.topUpOK(s2, "k", 300, c2); row.State != "unconfirmed" {
		t.Fatalf("%+v", row)
	}
}

// TestPurseTopUpScoreRefusedInAnotherLanguage (finding 17): Habitica's
// "Not Enough Gold" is written in the user's language; after a read and a
// create with the same token, a 401 on the score is that refusal.
func TestPurseTopUpScoreRefusedInAnotherLanguage(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.setGold(500)
	x.setScore("not-enough-gold-fr")
	x.setPurseChecks([]time.Duration{time.Millisecond})
	row := x.topUpOK(s, "k", 100, c)
	if row.State != "not-enough" {
		t.Fatalf("%+v", row)
	}
}

// TestPurseTopUpDeletesAtMostTwoLeftovers (finding 10): two, oldest first,
// so a backlog of failed runs can't eat the worker's time and the user's
// calls before the reward this top-up is here for.
func TestPurseTopUpDeletesAtMostTwoLeftovers(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	account := x.account("alice")
	now := x.now.Load()
	x.setGold(500)
	for i, id := range []string{"old-1", "old-2", "old-3"} {
		if _, err := x.db.DB.Exec("INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at,leftover,settled_at,settled_by) VALUES(?,?,?,20,'not-moved',?,1,?,'worker')", id, account, "k-"+id, now-1000+int64(i), now-900); err != nil {
			t.Fatal(err)
		}
	}
	x.topUpOK(s, "k", 100, c)
	seen := []string{}
	for _, call := range x.habiticaCalls() {
		if strings.HasPrefix(call, "delete:glimway-topup-old-") {
			seen = append(seen, call)
		}
	}
	if strings.Join(seen, ",") != "delete:glimway-topup-old-1,delete:glimway-topup-old-2" {
		t.Fatal("leftover deletes (want the two oldest):", seen)
	}
}

// TestPurseChangesMoveTheVersion (finding 6): the reserve and every settle
// outcome move the account's version, so a client adopts the answer instead
// of dropping it as a same-version conflict.
func TestPurseChangesMoveTheVersion(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	account := x.account("alice")
	before := x.version(t, account)
	x.setGold(500)
	x.setScore("error") // unknown → `unconfirmed`, a settle with no credit
	x.setPurseChecks([]time.Duration{time.Millisecond, 2 * time.Millisecond})
	x.topUpOK(s, "k", 100, c)
	after := x.version(t, account)
	if after < before+2 {
		t.Fatalf("version %d → %d: the reserve and the settle should each move it", before, after)
	}
	// The lazy settle moves it too, and the answer that triggered it
	// carries the new one.
	if _, err := x.db.DB.Exec("INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at) VALUES('dead',?,'dead',20,'scoring',?)", account, x.now.Load()-91); err != nil {
		t.Fatal(err)
	}
	before = x.version(t, account)
	read := x.purseRead(c)
	if read.Purse.Working != nil {
		t.Fatal("the dead worker's row still reads as working")
	}
	if x.version(t, account) <= before {
		t.Fatal("the lazy settle did not move the version")
	}
}

func (x *rig) version(t *testing.T, account string) int64 {
	t.Helper()
	var v int64
	if err := x.db.DB.QueryRow("SELECT version FROM players WHERE account_id=?", account).Scan(&v); err != nil {
		t.Fatal(err)
	}
	return v
}

// TestWardrobeCheckIdentityMismatch (finding 8): the gear check compares
// `_id` with the account's subject, like the gold read and sign-in do.
func TestWardrobeCheckIdentityMismatch(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	stub := &timedOutAfterScore{subject: "someone-else", gold: 1000}
	x.api.Habitica = stub
	status, out := x.checkGear(s.Lease, secret, c)
	if status != 401 || out.Error == nil || out.Error.Code != "habitica-auth" {
		t.Fatalf("check answered for someone else: %d %v", status, out.Error)
	}
}
