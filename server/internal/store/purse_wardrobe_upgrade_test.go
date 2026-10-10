package store

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"
)

// 0.6's migration 032 (docs/design/purse-and-wardrobe.md 6.4) is schema
// only: the purse's gold column and tables, the wardrobe and the owned-gear
// list, shelf prices, and the mail rebuild that lets a letter carry gold.
// Both tests seed a database the way 0.5 wrote it, then open through
// production's upgrade path.

// queryStrings reads one column of rows, in order.
func queryStrings(t *testing.T, db *sql.DB, query string) []string {
	t.Helper()
	rows, err := db.Query(query)
	if err != nil {
		t.Fatal(query, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var v string
		if err := rows.Scan(&v); err != nil {
			t.Fatal(query, err)
		}
		out = append(out, v)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(query, err)
	}
	return out
}

// queryPairs reads a two-column (string, int) query into a map.
func queryPairs(t *testing.T, db *sql.DB, query string) map[string]int {
	t.Helper()
	rows, err := db.Query(query)
	if err != nil {
		t.Fatal(query, err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var k string
		var v int
		if err := rows.Scan(&k, &v); err != nil {
			t.Fatal(query, err)
		}
		out[k] = v
	}
	if err := rows.Err(); err != nil {
		t.Fatal(query, err)
	}
	return out
}

// mustQuery asserts a scalar query's answer.
func mustQuery(t *testing.T, db *sql.DB, query string, want int) {
	t.Helper()
	var got int
	if err := db.QueryRow(query).Scan(&got); err != nil || got != want {
		t.Fatalf("%s: got %d, want %d (%v)", query, got, want, err)
	}
}

// The mail rebuild is the risky half: SQLite can't change a CHECK in place,
// so mail is rebuilt the way 013 and 020 did it — and a rebuild that drops
// the table can drop its letters or its indexes with it.
func TestMailRebuild032KeepsEveryLetterAndIndex(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upgrade.sqlite")
	old := newUpgradeFixture(t, path, "031_level_mark.sql", nil)
	// One letter of every kind 0.5 knew, in every state: waiting, claimed,
	// recalled, expired and recipient-removed.
	seed := `INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','owner-subject','seed',1);
INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES('owner-subject','Owner','w',11,12,7),('friend-subject','Friend','w',11,12,7);
INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES
 ('m-material','w','owner-subject','friend-subject','material','timber',5,'[]','[{"maker":"","qty":5}]',100),
 ('m-item','w','owner-subject','friend-subject','item','lamp-wick',2,'[]','[{"maker":"","qty":2}]',101),
 ('m-decoration','w','owner-subject','friend-subject','decoration','reading-chair',1,'["inst-1"]','[]',102),
 ('m-instance','w','friend-subject','owner-subject','instance','bench-axe',1,'["inst-2"]','[]',103),
 ('m-thanks','w','owner-subject','friend-subject','thanks','bench-axe',0,'[]','[]',104);
INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at,claimed_at) VALUES
 ('m-claimed','w','friend-subject','owner-subject','material','stone',3,'[]','[{"maker":"","qty":3}]',105,200);
INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at,returned_at,return_reason) VALUES
 ('m-recalled','w','owner-subject','friend-subject','material','fiber',4,'[]','[{"maker":"","qty":4}]',106,201,'recalled'),
 ('m-expired','w','owner-subject','friend-subject','item','tallow',1,'[]','[{"maker":"","qty":1}]',107,202,'expired'),
 ('m-removed','w','owner-subject','friend-subject','instance','tin-whistle',1,'["inst-3"]','[]',108,203,'recipient-removed');`
	if _, err := old.Exec(fixtureSchemaSQL("031_level_mark.sql", seed)); err != nil {
		t.Fatal(err)
	}
	letter := "SELECT id||':'||kind||':'||item_def||':'||qty||':'||instance_ids||':'||makers||':'||sent_at||':'||COALESCE(claimed_at,-1)||':'||COALESCE(returned_at,-1)||':'||COALESCE(return_reason,'') FROM mail ORDER BY id"
	indexesBefore := queryStrings(t, old, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mail' ORDER BY name")
	// The nine named indexes of 020_gifts.sql plus the primary key's
	// autoindex: the "ten mail indexes" a rebuild must not lose.
	if len(indexesBefore) != 10 {
		t.Fatal("mail indexes before the rebuild", indexesBefore)
	}
	lettersBefore := queryStrings(t, old, letter)
	if len(lettersBefore) != 9 {
		t.Fatal("letters before the rebuild", len(lettersBefore))
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.Close()

	lettersAfter := queryStrings(t, upgraded.DB, letter)
	if len(lettersAfter) != len(lettersBefore) {
		t.Fatal("letters lost or duplicated", len(lettersAfter))
	}
	for i, row := range lettersBefore {
		if lettersAfter[i] != row {
			t.Fatalf("letter %s became %s", row, lettersAfter[i])
		}
	}
	indexesAfter := queryStrings(t, upgraded.DB, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='mail' ORDER BY name")
	if len(indexesAfter) != len(indexesBefore) {
		t.Fatal("mail indexes lost or duplicated", indexesAfter)
	}
	for i, name := range indexesBefore {
		if indexesAfter[i] != name {
			t.Fatalf("mail index %s became %s", name, indexesAfter[i])
		}
	}

	// The rebuilt table is the one 0.6 writes to: a gold letter is allowed
	// (kind 'gold', item_def 'gold', qty the amount, instance_ids and makers
	// '[]'), and still needs a positive qty.
	if _, err := upgraded.DB.Exec(`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES('m-gold','w','owner-subject','friend-subject','gold','gold',20,'[]','[]',109)`); err != nil {
		t.Fatal("gold letter refused", err)
	}
	if _, err := upgraded.DB.Exec(`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES('m-gold-zero','w','owner-subject','friend-subject','gold','gold',0,'[]','[]',110)`); err == nil {
		t.Fatal("a gold letter with no gold was accepted")
	}
	rows, err := upgraded.DB.Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("invalid upgraded foreign keys")
	}
}

// 0.5's fixture style: the account loads after the upgrade, its purse is 0,
// and the ledger sums are unchanged (6.4 — no backfill: no rows means an
// empty purse, Habitica's look, no owned gear checked yet, free shelf slots
// and no gold letters).
func TestPurseWardrobe032FixtureUpgrade(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upgrade.sqlite")
	old := newUpgradeFixture(t, path, "031_level_mark.sql", nil)
	seed := `INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','owner-subject','seed',1);
INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES('owner-subject','Owner','w',11,12,7);
INSERT INTO player_vitals(account_id,hp,mana,vitals_at,vitals_set_version) VALUES('owner-subject',32,12,1,0);
INSERT INTO player_place(account_id,area,x,y) VALUES('owner-subject','village',2,3);
INSERT INTO balances(account_id,embers,xp_embers) VALUES('owner-subject',9,3);
INSERT INTO sync_baselines(account_id,profile_json,verified_xp,checkpoint_json,checkpoint_at,updated_at) VALUES('owner-subject','{"id":"owner-subject","name":"Owner","level":2,"hp":32,"maxHp":50,"mp":12,"maxMp":32,"stats":{}}',0,'{}',12,12);
INSERT INTO homesteads(id,world_id,gate,tier,posts_bought,claimed_at) VALUES('home','w',2,1,3,15);
INSERT INTO gate_shelf_slots(homestead_id,slot,kind,item_def,qty,stocked_by,stocked_at) VALUES('home',0,'material','timber',2,'owner-subject',10);
INSERT INTO ledger(account_id,currency,delta,earned_delta,reason,ref,created_at) VALUES
 ('owner-subject','embers',9,3,'test','',1),
 ('owner-subject','material:timber',5,0,'test','',2),
 ('owner-subject','item:lamp-wick',2,0,'test','',3),
 ('owner-subject','mail:material:timber',4,0,'test','',4);`
	if _, err := old.Exec(seed); err != nil {
		t.Fatal(err)
	}
	sumsBefore := queryPairs(t, old, "SELECT currency, COALESCE(SUM(delta),0) FROM ledger GROUP BY currency")
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.Close()

	// The account loads (its own transaction: the store keeps one
	// connection, so nothing else runs beside it).
	func() {
		tx, err := upgraded.DB.Begin()
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		snap, err := Load(context.Background(), tx, "owner-subject")
		if err != nil {
			t.Fatal(err)
		}
		if snap.AccountID != "owner-subject" || snap.State.Embers != 9 {
			t.Fatal(snap.AccountID, snap.State.Embers)
		}
	}()

	// The purse is 0, the wardrobe is Habitica's look, no gear has been
	// checked, no top-up has run, and the shelf slot is still a free gift.
	mustQuery(t, upgraded.DB, "SELECT count(*) FROM balances WHERE account_id='owner-subject' AND gold=0", 1)
	mustQuery(t, upgraded.DB, "SELECT count(*) FROM player_wardrobe WHERE account_id='owner-subject'", 0)
	mustQuery(t, upgraded.DB, "SELECT count(*) FROM player_gear WHERE account_id='owner-subject'", 0)
	mustQuery(t, upgraded.DB, "SELECT count(*) FROM purse_topups WHERE account_id='owner-subject'", 0)
	mustQuery(t, upgraded.DB, "SELECT count(*) FROM gate_shelf_slots WHERE homestead_id='home' AND slot=0 AND price=0", 1)

	// The ledger sums are unchanged: schema only, no backfill.
	sumsAfter := queryPairs(t, upgraded.DB, "SELECT currency, COALESCE(SUM(delta),0) FROM ledger GROUP BY currency")
	if len(sumsAfter) != len(sumsBefore) {
		t.Fatal("ledger rows appeared", sumsAfter)
	}
	for currency, want := range sumsBefore {
		if sumsAfter[currency] != want {
			t.Fatalf("%s moved: %d -> %d", currency, want, sumsAfter[currency])
		}
	}

	// The new tables and columns take their rows against the retained
	// account — and hold their checks.
	if _, err := upgraded.DB.Exec(`INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at) VALUES('top','owner-subject','k',5,'reserved',10)`); err != nil {
		t.Fatal(err)
	}
	if _, err := upgraded.DB.Exec(`INSERT INTO player_wardrobe(account_id,slot,gear_key) VALUES('owner-subject','weapon','weapon_warrior_1')`); err != nil {
		t.Fatal(err)
	}
	if _, err := upgraded.DB.Exec(`INSERT INTO player_gear(account_id,owned_json,checked_at) VALUES('owner-subject','["weapon_warrior_1"]',10)`); err != nil {
		t.Fatal(err)
	}
	if _, err := upgraded.DB.Exec(`INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at) VALUES('top2','owner-subject','k2',5,'checking',10)`); err == nil {
		t.Fatal("two working top-ups for one account")
	}
	if _, err := upgraded.DB.Exec(`INSERT INTO player_wardrobe(account_id,slot,gear_key) VALUES('owner-subject','weaponSpecial','weapon_warrior_1')`); err == nil {
		t.Fatal("a weaponSpecial row was accepted")
	}
	if _, err := upgraded.DB.Exec(`INSERT INTO player_wardrobe(account_id,slot,gear_key) VALUES('owner-subject','head','')`); err == nil {
		t.Fatal("an empty gear key was accepted")
	}
	if _, err := upgraded.DB.Exec(`UPDATE balances SET gold=-1 WHERE account_id='owner-subject'`); err == nil {
		t.Fatal("a negative purse was accepted")
	}
}
