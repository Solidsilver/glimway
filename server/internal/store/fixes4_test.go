package store

import (
	"path/filepath"
	"testing"
)

func TestRound4UpgradeBackfillsLanternCreationCounts(t *testing.T) {
	path := filepath.Join(t.TempDir(), "round3.sqlite")
	old := newUpgradeFixture(t, path, "005_checkpoint_sessions_contract.sql", nil)
	var err error
	if _, err = old.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','s',0);
 INSERT INTO players(habitica_id,display_name,world_id,created_at,last_seen_at,rev) VALUES('alice','Keeper','w',1,100,7);
 INSERT INTO ledger(habitica_id,currency,delta,earned_delta,reason,ref,created_at) VALUES
 ('alice','embers',0,0,'wilds-defeat','one',1791072000),
 ('alice','embers',0,0,'wilds-defeat','two',1791072060),
 ('alice','embers',0,0,'wilds-defeat','tomorrow',1791158400),
 ('alice','material:amber',1,0,'wilds-relight','light',1791072000);`); err != nil {
		t.Fatal(err)
	}
	markFixtureOrigins(t, old)
	if err = old.Close(); err != nil {
		t.Fatal(err)
	}
	upgraded, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.Close()
	rows, err := upgraded.DB.Query("SELECT qty FROM lantern_creations WHERE account_id='alice' ORDER BY utc_day")
	if err != nil {
		t.Fatal(err)
	}
	totals := []int{}
	for rows.Next() {
		var n int
		if err = rows.Scan(&n); err != nil {
			t.Fatal(err)
		}
		totals = append(totals, n)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	if len(totals) != 2 || totals[0] != 2 || totals[1] != 1 {
		t.Fatal("incorrect UTC/day backfill", totals)
	}
	var rev, ledger int
	if err = upgraded.DB.QueryRow("SELECT version FROM players WHERE account_id='alice'").Scan(&rev); err != nil || rev != 7 {
		t.Fatal("upgrade changed revision", err, rev)
	}
	if err = upgraded.DB.QueryRow("SELECT count(*) FROM ledger").Scan(&ledger); err != nil || ledger != 4 {
		t.Fatal("upgrade changed ledger", err, ledger)
	}
}
