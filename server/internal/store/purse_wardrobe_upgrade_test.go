package store

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"strings"
	"testing"
)

// 0.6's migration 032 (docs/design/purse-and-wardrobe.md 6.4) is schema
// only: the purse's gold column and tables, the wardrobe and the owned-gear
// list, shelf prices, and the mail rebuild that lets a letter carry gold.
// Both tests seed a database the way 0.5 wrote it, then open through
// production's upgrade path — which goes on through 033 (glims), so what
// they check of gold is read as 033 left it: the gold kind and column are
// glims now (033's own test, glims_upgrade_test.go, checks the conversion).

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

// tableSQL is a table's recorded CREATE statement (sqlite_master keeps the
// text a rebuild produced, rename included).
func tableSQL(t *testing.T, db *sql.DB, table string) string {
	t.Helper()
	var text sql.NullString
	if err := db.QueryRow("SELECT sql FROM sqlite_master WHERE type='table' AND name=?", table).Scan(&text); err != nil {
		t.Fatal(err)
	}
	return text.String
}

// indexSQLs are every index on a table as "name|CREATE statement": names and
// SQL both, so a rebuild that dropped a partial index's WHERE clause or
// re-pointed its columns is caught, not just one that lost the index.
func indexSQLs(t *testing.T, db *sql.DB, table string) []string {
	t.Helper()
	return queryStrings(t, db, fmt.Sprintf(`SELECT name||'|'||COALESCE(sql,'') FROM sqlite_master WHERE type='index' AND tbl_name='%s' ORDER BY name`, table))
}

// foreignKeys is every foreign key of a table, projected whole.
func foreignKeys(t *testing.T, db *sql.DB, table string) []string {
	t.Helper()
	return queryStrings(t, db, fmt.Sprintf(`SELECT quote(id)||','||quote(seq)||','||quote("table")||','||quote("from")||','||quote("to")||','||quote(on_update)||','||quote(on_delete)||','||quote(match) FROM pragma_foreign_key_list('%s') ORDER BY id,seq`, table))
}

// subOne applies exactly one substitution, refusing silence: the rebuilt
// table's SQL must differ from the old one only where this says it does.
func subOne(t *testing.T, s, old, new string) string {
	t.Helper()
	if strings.Count(s, old) != 1 {
		t.Fatalf("the recorded SQL holds %d of %q, want exactly 1", strings.Count(s, old), old)
	}
	return strings.Replace(s, old, new, 1)
}

// A letter, projected over every column — a rebuild that swapped two columns
// in its INSERT…SELECT (the classic rebuild bug) changes this line.
const letterRow = `COALESCE(quote(id),'NULL')||','||COALESCE(quote(world_id),'NULL')||','||COALESCE(quote(from_id),'NULL')||','||COALESCE(quote(to_id),'NULL')||','||COALESCE(quote(kind),'NULL')||','||COALESCE(quote(item_def),'NULL')||','||quote(qty)||','||COALESCE(quote(instance_ids),'NULL')||','||COALESCE(quote(makers),'NULL')||','||quote(sent_at)||','||COALESCE(quote(claimed_at),'NULL')||','||COALESCE(quote(returned_at),'NULL')||','||COALESCE(quote(return_reason),'NULL')`

// The mail rebuild is the risky half: SQLite can't change a CHECK in place,
// so mail is rebuilt the way 013 and 020 did it — and a rebuild that drops
// the table can drop its letters, its indexes or its constraints with it.
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
	if _, err := old.Exec(seed); err != nil {
		t.Fatal(err)
	}
	lettersBefore := queryStrings(t, old, "SELECT "+letterRow+" FROM mail ORDER BY id")
	if len(lettersBefore) != 9 {
		t.Fatal("letters before the rebuild", len(lettersBefore))
	}
	indexesBefore := indexSQLs(t, old, "mail")
	// The nine named indexes of 020_gifts.sql plus the primary key's
	// autoindex: the "ten mail indexes" a rebuild must not lose.
	if len(indexesBefore) != 10 {
		t.Fatal("mail indexes before the rebuild", indexesBefore)
	}
	sqlBefore := tableSQL(t, old, "mail")
	fksBefore := foreignKeys(t, old, "mail")
	// worlds(id) once, players(account_id) twice.
	if len(fksBefore) != 3 {
		t.Fatal("mail foreign keys before the rebuild", fksBefore)
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.Close()

	// Every letter, every column.
	lettersAfter := queryStrings(t, upgraded.DB, "SELECT "+letterRow+" FROM mail ORDER BY id")
	if len(lettersAfter) != len(lettersBefore) {
		t.Fatal("letters lost or duplicated", len(lettersAfter))
	}
	for i, row := range lettersBefore {
		if lettersAfter[i] != row {
			t.Fatalf("letter %s became %s", row, lettersAfter[i])
		}
	}

	// Every index, name and CREATE statement alike.
	indexesAfter := indexSQLs(t, upgraded.DB, "mail")
	if len(indexesAfter) != len(indexesBefore) {
		t.Fatal("mail indexes lost or duplicated", indexesAfter)
	}
	for i, row := range indexesBefore {
		if indexesAfter[i] != row {
			t.Fatalf("mail index %s became %s", row, indexesAfter[i])
		}
	}

	// The table itself is the 031 definition with exactly the kind rule, the
	// qty rule and the gold-letter shape changed — nothing else moved.
	wantSQL := subOne(t, sqlBefore,
		`CHECK(kind IN ('material','item','decoration','instance','thanks'))`,
		`CHECK(kind IN ('material','item','decoration','instance','thanks','gold'))`)
	wantSQL = subOne(t, wantSQL,
		`CHECK((kind != 'thanks' AND qty > 0) OR (kind = 'thanks' AND qty = 0))`,
		`CHECK((kind IN ('material','item','decoration','instance','gold') AND qty > 0) OR (kind = 'thanks' AND qty = 0))`)
	wantSQL = subOne(t, wantSQL,
		`CHECK(from_id!=to_id)`,
		"CHECK(from_id!=to_id),\n CHECK(kind <> 'gold' OR (item_def = 'gold' AND instance_ids = '[]' AND makers = '[]'))")
	// 033 rebuilt the table again with 'glims' where 032 wrote 'gold'.
	wantSQL = strings.ReplaceAll(wantSQL, "'gold'", "'glims'")
	if wantSQL != tableSQL(t, upgraded.DB, "mail") {
		t.Fatalf("the rebuilt mail table is not the 031 one plus the gold rules:\n got %s\nwant %s", tableSQL(t, upgraded.DB, "mail"), wantSQL)
	}

	// And its foreign keys are the same two.
	fksAfter := foreignKeys(t, upgraded.DB, "mail")
	if len(fksAfter) != len(fksBefore) {
		t.Fatal("mail foreign keys lost or duplicated", fksAfter)
	}
	for i, row := range fksBefore {
		if fksAfter[i] != row {
			t.Fatalf("mail foreign key %s became %s", row, fksAfter[i])
		}
	}

	// The rebuilt table is the one 0.6 writes to: a gold letter is allowed
	// (kind 'gold', item_def 'gold', qty the amount, instance_ids and makers
	// '[]'), and still needs a positive qty.
	gold := `INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES('m-gold','w','owner-subject','friend-subject','glims','glims',%d,'%s','%s',109)`
	if _, err := upgraded.DB.Exec(fmt.Sprintf(gold, 20, "[]", "[]")); err != nil {
		t.Fatal("gold letter refused", err)
	}
	// Nothing the CHECKs of the live definition say survived the rebuild is
	// gone: a sender mailing themselves, a thanks with a quantity, a letter
	// both claimed and returned, an unknown return reason — and the
	// gold-letter shape (6.4) holds on the new kind alone.
	for _, insert := range []string{
		fmt.Sprintf(gold, 0, "[]", "[]"),
		`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES('x','w','owner-subject','owner-subject','material','timber',1,'[]','[]',1)`,
		`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES('x','w','owner-subject','friend-subject','thanks','bench-axe',1,'[]','[]',1)`,
		`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at,claimed_at,returned_at) VALUES('x','w','owner-subject','friend-subject','material','timber',1,'[]','[]',1,2,3)`,
		`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at,returned_at,return_reason) VALUES('x','w','owner-subject','friend-subject','material','timber',1,'[]','[]',1,2,'pawned')`,
		`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES('x','w','owner-subject','friend-subject','glims','tallow',5,'[]','[]',1)`,
		`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES('x','w','owner-subject','friend-subject','glims','glims',5,'["inst-4"]','[]',1)`,
		`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES('x','w','owner-subject','friend-subject','glims','glims',5,'[]','[{"maker":"","qty":5}]',1)`,
		// 032's gold kind is gone.
		`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES('x','w','owner-subject','friend-subject','gold','gold',5,'[]','[]',1)`,
	} {
		if _, err := upgraded.DB.Exec(insert); err == nil {
			t.Fatal("a broken letter was accepted:", insert)
		}
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
		if snap.AccountID != "owner-subject" || snap.State.Glims != 9 {
			t.Fatal(snap.AccountID, snap.State.Glims)
		}
	}()

	// The purse was 0 (033 turned nothing in: the glims are the embers),
	// the wardrobe is Habitica's look, no gear has been checked, no top-up
	// has run, and the shelf slot is still a free gift.
	mustQuery(t, upgraded.DB, "SELECT count(*) FROM balances WHERE account_id='owner-subject' AND glims=9 AND xp_glims=3", 1)
	mustQuery(t, upgraded.DB, "SELECT count(*) FROM player_wardrobe WHERE account_id='owner-subject'", 0)
	mustQuery(t, upgraded.DB, "SELECT count(*) FROM player_gear WHERE account_id='owner-subject'", 0)
	mustQuery(t, upgraded.DB, "SELECT count(*) FROM purse_topups WHERE account_id='owner-subject'", 0)
	mustQuery(t, upgraded.DB, "SELECT count(*) FROM gate_shelf_slots WHERE homestead_id='home' AND slot=0 AND price=0", 1)

	// The ledger sums are unchanged: schema only, no backfill (033 renamed
	// the 'embers' currency to 'glims' and, with no gold, wrote no merge row).
	sumsBefore["glims"] = sumsBefore["embers"]
	delete(sumsBefore, "embers")
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
	if _, err := upgraded.DB.Exec(`INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at,settled_at,settled_by,gold_before,gold_after,leftover) VALUES('top-done','owner-subject','kd',5,'moved',10,20,'worker',120,115,1)`); err != nil {
		t.Fatal(err)
	}
	if _, err := upgraded.DB.Exec(`INSERT INTO player_wardrobe(account_id,slot,gear_key) VALUES('owner-subject','weapon','weapon_warrior_1')`); err != nil {
		t.Fatal(err)
	}
	if _, err := upgraded.DB.Exec(`INSERT INTO player_gear(account_id,owned_json,checked_at) VALUES('owner-subject','["weapon_warrior_1"]',10)`); err != nil {
		t.Fatal(err)
	}
	for _, insert := range []string{
		// One working top-up per account.
		`INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at) VALUES('top2','owner-subject','k2',5,'checking',10)`,
		// drawn slots only, a named gear key only.
		`INSERT INTO player_wardrobe(account_id,slot,gear_key) VALUES('owner-subject','weaponSpecial','weapon_warrior_1')`,
		`INSERT INTO player_wardrobe(account_id,slot,gear_key) VALUES('owner-subject','head','')`,
		// a top-up is one positive amount of gold.
		`INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at) VALUES('top3','owner-subject','k3',0,'reserved',10)`,
		// leftover is a flag, Habitica's gold is never negative.
		`INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at,leftover) VALUES('top4','owner-subject','k4',5,'reserved',10,2)`,
		`INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at,gold_before) VALUES('top5','owner-subject','k5',5,'reserved',10,-1)`,
		`INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at,gold_after) VALUES('top6','owner-subject','k6',5,'reserved',10,-1)`,
		// a row settles once: working means unsettled, settled means it says
		// when and by whom.
		`INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at,settled_at,settled_by) VALUES('top7','owner-subject','k7',5,'moved',10,NULL,'worker')`,
		`INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at,settled_at,settled_by) VALUES('top8','owner-subject','k8',5,'reserved',10,20,'worker')`,
		`INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at,settled_at,settled_by) VALUES('top9','owner-subject','k9',5,'moved',10,20,NULL)`,
		`INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at,settled_at,settled_by) VALUES('top10','owner-subject','k10',5,'moved',10,20,'a-friend')`,
		// the purse stays non-negative, the owned list stays JSON.
		`UPDATE balances SET glims=-1 WHERE account_id='owner-subject'`,
		`UPDATE player_gear SET owned_json='not json' WHERE account_id='owner-subject'`,
	} {
		if _, err := upgraded.DB.Exec(insert); err == nil {
			t.Fatal("a broken row was accepted:", insert)
		}
	}
}
