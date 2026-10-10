package main

import (
	"context"
	"database/sql"
	"glimway/server/internal/store"
	"path/filepath"
	"testing"
)

// TestPurseCommands is the owner's command line (design 2.6): `purse list`
// says what each top-up did, and `purse settle <id> moved|not-moved` lands
// the one the checks could not decide — only an `unconfirmed` row, with
// `moved` crediting the purse and both marking the row settled by the owner.
func TestPurseCommands(t *testing.T) {
	path := filepath.Join(t.TempDir(), "game.sqlite")
	seed := func() {
		s, err := store.Open(path)
		if err != nil {
			t.Fatal(err)
		}
		defer s.Close()
		mustExec(t, s.DB, `INSERT OR IGNORE INTO worlds(id,owner_id,seed,created_at) VALUES('w','','seed',1)`)
		mustExec(t, s.DB, `INSERT OR IGNORE INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES('acct','Hero','w',11,12,1)`)
		mustExec(t, s.DB, `INSERT OR IGNORE INTO player_vitals(account_id,hp,mana,vitals_at,vitals_set_version) VALUES('acct',32,12,1,0)`)
		mustExec(t, s.DB, `INSERT OR IGNORE INTO player_place(account_id,area,x,y) VALUES('acct','village',2,3)`)
		mustExec(t, s.DB, `INSERT OR IGNORE INTO balances(account_id,embers,xp_embers) VALUES('acct',0,0)`)
		mustExec(t, s.DB, `INSERT OR IGNORE INTO sync_baselines(account_id,profile_json,verified_xp,checkpoint_json,checkpoint_at,updated_at) VALUES('acct','{}',0,'{}',12,12)`)
		mustExec(t, s.DB, `INSERT OR IGNORE INTO sign_ins(account_id,method,subject,created_at) VALUES('acct','habitica','hero-subject',12)`)
		mustExec(t, s.DB, `INSERT OR IGNORE INTO purse_topups(id,account_id,op_key,amount,state,created_at,gold_before,note,settled_at,settled_by) VALUES('unconfirmed','acct','k1',300,'unconfirmed',10,1240,'timeout',25,'worker')`)
		mustExec(t, s.DB, `INSERT OR IGNORE INTO purse_topups(id,account_id,op_key,amount,state,created_at,settled_at,settled_by) VALUES('moved','acct','k2',50,'moved',20,25,'worker')`)
	}
	seed()
	if err := run([]string{"-db", path, "purse", "list"}); err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"-db", path, "purse", "list", "--unconfirmed"}); err != nil {
		t.Fatal(err)
	}
	// Only an unconfirmed row may be settled by hand.
	if err := run([]string{"-db", path, "purse", "settle", "moved", "moved"}); err == nil {
		t.Fatal("settled a row the worker already settled")
	}
	if err := run([]string{"-db", path, "purse", "settle", "unconfirmed", "settled"}); err == nil {
		t.Fatal("accepted an outcome that is not moved or not-moved")
	}
	if err := run([]string{"-db", path, "purse", "settle", "no-such-row", "moved"}); err == nil {
		t.Fatal("settled a row that does not exist")
	}
	if err := run([]string{"-db", path, "purse"}); err == nil {
		t.Fatal("accepted a purse command with no subcommand")
	}
	if err := run([]string{"-db", path, "purse", "settle", "unconfirmed", "not-moved"}); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	// not-moved credits nothing, and the row is settled by the owner —
	// whose mark is `settled_by`, while the worker's note (why the owner is
	// here at all) stays in the row (finding 18).
	var state, settledBy, note string
	var gold int
	if err = s.DB.QueryRow("SELECT state,settled_by,note FROM purse_topups WHERE id='unconfirmed'").Scan(&state, &settledBy, &note); err != nil {
		t.Fatal(err)
	}
	if state != "not-moved" || settledBy != "owner" || note != "timeout" {
		t.Fatal(state, settledBy, note)
	}
	if err = s.DB.QueryRow("SELECT gold FROM balances WHERE account_id='acct'").Scan(&gold); err != nil || gold != 0 {
		t.Fatal("a hand settlement of not-moved credited gold", gold)
	}
	// The other way: `moved` credits the purse with the ledger's word for it.
	mustExec(t, s.DB, `UPDATE purse_topups SET state='unconfirmed',settled_at=25,settled_by='worker',note='timeout' WHERE id='unconfirmed'`)
	if err = run([]string{"-db", path, "purse", "settle", "unconfirmed", "moved"}); err != nil {
		t.Fatal(err)
	}
	if err = s.DB.QueryRow("SELECT gold FROM balances WHERE account_id='acct'").Scan(&gold); err != nil || gold != 300 {
		t.Fatal("a hand settlement of moved credited", gold)
	}
	var reason, ref string
	if err = s.DB.QueryRow("SELECT reason,ref FROM ledger WHERE account_id='acct' AND currency='gold'").Scan(&reason, &ref); err != nil {
		t.Fatal(err)
	}
	if reason != "purse-settle" || ref != "unconfirmed" {
		t.Fatal(reason, ref)
	}
	// A row the worker left without a note says so in the note's own word.
	mustExec(t, s.DB, `UPDATE purse_topups SET state='unconfirmed',note='',settled_at=25,settled_by='worker' WHERE id='unconfirmed'`)
	if err = run([]string{"-db", path, "purse", "settle", "unconfirmed", "not-moved"}); err != nil {
		t.Fatal(err)
	}
	if err = s.DB.QueryRow("SELECT note FROM purse_topups WHERE id='unconfirmed'").Scan(&note); err != nil || note != "settled-by-owner" {
		t.Fatal("empty note", note, err)
	}
}

func mustExec(t *testing.T, db *sql.DB, query string) {
	t.Helper()
	if _, err := db.ExecContext(context.Background(), query); err != nil {
		t.Fatal(query, err)
	}
}
