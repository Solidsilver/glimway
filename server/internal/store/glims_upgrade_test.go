package store

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// 0.6.1's migration 033 (docs/design/silas-yard.md 1.7): embers and the
// purse's gold become glims. The fixture is a database as 0.6.0 left it
// (through 032) with embers, XP-earned embers, gold, gold ledger rows, gold
// letters in every state, an escrow, top-ups and held sync credit, opened
// through production's upgrade path.
//
// The numbers, worked by hand (every halved delta rounds half away from
// zero; a letter's qty rounds up):
//
//	alice: embers 10 (4 from XP), gold 6. Gold rows +21 −3 −5 −3 +3 −7 halve
//	       to +11 −2 −3 −2 +2 −4 = 2; the turn-in is 6/2 = 3, so the merge
//	       row is +1 and her glims rows sum to 10+2+1 = 13 = 10 + 3.
//	       Escrow +5 +3 −3 +7 −7 halves to 3 = the waiting 5-gold letter,
//	       now 3 glims.
//	bob:   embers 2 (2 from XP), gold 7 (one collected letter, +7 → +4);
//	       turn-in 3, merge −1, glims 5.
//	dave:  gold 0, but rows +3 +3 −6 halve to +2 +2 −3 = 1; merge −1,
//	       glims 0.
//	carol: nothing at all, so no merge row.
//
// Alice's gate shelf has slots priced 6, 1, 0 and 7 gold: they become 3, 1,
// 0 (still a free gift) and 4 glims.
func TestGlims033UpgradeConvertsBalancesLedgerAndLetters(t *testing.T) {
	path := filepath.Join(t.TempDir(), "upgrade.sqlite")
	old := newUpgradeFixture(t, path, "032_purse_wardrobe.sql", nil)
	seed := `INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',1);
INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES
 ('alice','Alice','w',11,12,7),('bob','Bob','w',11,12,7),('carol','Carol','w',11,12,7),('dave','Dave','w',11,12,7);
INSERT INTO player_vitals(account_id,hp,mana,vitals_at,vitals_set_version) VALUES('alice',32,12,1,0);
INSERT INTO player_place(account_id,area,x,y) VALUES('alice','village',2,3);
INSERT INTO sync_baselines(account_id,profile_json,verified_xp,checkpoint_json,checkpoint_at,updated_at) VALUES('alice','{"id":"alice","name":"Alice","level":2,"hp":32,"maxHp":50,"mp":12,"maxMp":32,"stats":{}}',0,'{}',12,12);
INSERT INTO balances(account_id,embers,xp_embers,gold) VALUES('alice',10,4,6),('bob',2,2,7),('carol',0,0,0),('dave',0,0,0);
INSERT INTO pending_credits(account_id,reported_xp,embers,created_at) VALUES('alice',120,4,20);
INSERT INTO ledger(account_id,currency,delta,earned_delta,reason,ref,created_at) VALUES
 ('alice','embers',10,4,'sync','',1),
 ('alice','gold',21,0,'habitica-topup','top-a',2),
 ('alice','gold',-3,0,'market-buy','silas-yard:timber',3),
 ('alice','gold',-5,0,'mail-send','m-wait',4),
 ('alice','mail:gold:gold',5,0,'mail-send','m-wait',4),
 ('alice','gold',-3,0,'mail-send','m-recalled',5),
 ('alice','mail:gold:gold',3,0,'mail-send','m-recalled',5),
 ('alice','gold',3,0,'mail-recall','m-recalled',6),
 ('alice','mail:gold:gold',-3,0,'mail-recall','m-recalled',6),
 ('alice','gold',-7,0,'mail-send','m-claimed',7),
 ('alice','mail:gold:gold',7,0,'mail-send','m-claimed',7),
 ('alice','mail:gold:gold',-7,0,'mail-claim','m-claimed',8),
 ('bob','embers',2,2,'sync','',1),
 ('bob','gold',7,0,'mail-claim','m-claimed',8),
 ('dave','gold',3,0,'habitica-topup','top-d1',2),
 ('dave','gold',3,0,'habitica-topup','top-d2',3),
 ('dave','gold',-6,0,'market-buy','silas-yard:stone',4),
 ('alice','material:timber',5,0,'test','',9);
INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES
 ('m-wait','w','alice','bob','gold','gold',5,'[]','[]',4),
 ('m-timber','w','alice','bob','material','timber',2,'[]','[{"maker":"","qty":2}]',4),
 ('m-thanks','w','bob','alice','thanks','bench-axe',0,'[]','[]',4);
INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at,returned_at,return_reason) VALUES
 ('m-recalled','w','alice','bob','gold','gold',3,'[]','[]',5,6,'recalled');
INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at,claimed_at) VALUES
 ('m-claimed','w','alice','bob','gold','gold',7,'[]','[]',7,8);
INSERT INTO purse_topups(id,account_id,op_key,amount,state,gold_before,gold_after,created_at,settled_at,settled_by) VALUES
 ('top-a','alice','ka',21,'moved',100,79,2,3,'worker'),
 ('top-x','alice','kx',40,'not-enough',10,10,5,6,'worker');
INSERT INTO homesteads(id,world_id,gate,tier,posts_bought,claimed_at) VALUES('home','w',2,1,3,15);
INSERT INTO gate_shelf_slots(homestead_id,slot,kind,item_def,qty,stocked_by,stocked_at,price) VALUES
 ('home',0,'material','timber',2,'alice',10,6),
 ('home',1,'material','timber',1,'alice',10,1),
 ('home',2,'material','stone',1,'alice',10,0),
 ('home',3,'item','lamp-wick',1,'alice',10,7);`
	if _, err := old.Exec(seed); err != nil {
		t.Fatal(err)
	}
	// Today's mail table and indexes, before: 033 must keep every one.
	indexesBefore := indexSQLs(t, old, "mail")
	if len(indexesBefore) != 10 {
		t.Fatal("mail indexes before the rebuild", indexesBefore)
	}
	sqlBefore := tableSQL(t, old, "mail")
	fksBefore := foreignKeys(t, old, "mail")
	lettersBefore := queryStrings(t, old, "SELECT "+letterRow+" FROM mail ORDER BY id")
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}

	upgraded, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.Close()
	db := upgraded.DB

	// Balances: embers + gold/2, floored; the XP-earned share as it was.
	glims := queryPairs(t, db, "SELECT account_id,glims FROM balances")
	earned := queryPairs(t, db, "SELECT account_id,xp_glims FROM balances")
	for id, want := range map[string][2]int{"alice": {13, 4}, "bob": {5, 2}, "carol": {0, 0}, "dave": {0, 0}} {
		if glims[id] != want[0] || earned[id] != want[1] {
			t.Fatalf("%s: glims %d (xp %d), want %d (xp %d)", id, glims[id], earned[id], want[0], want[1])
		}
	}

	// The ledger: no embers, gold or gold escrow left, and each account's
	// glims rows sum to its balance.
	mustQuery(t, db, "SELECT count(*) FROM ledger WHERE currency IN ('embers','gold','mail:gold:gold')", 0)
	rows := queryPairs(t, db, "SELECT account_id,COALESCE(SUM(delta),0) FROM ledger WHERE currency='glims' GROUP BY account_id")
	for id, n := range glims {
		if rows[id] != n {
			t.Fatalf("%s: glims rows sum to %d, the balance is %d", id, rows[id], n)
		}
	}
	// Earned deltas carried over with the embers rows; the merge and the
	// halved gold rows are never XP-earned.
	mustQuery(t, db, "SELECT COALESCE(SUM(earned_delta),0) FROM ledger WHERE account_id='alice' AND currency='glims'", 4)
	// One merge row per account that held gold or whose gold rows drifted.
	merges := queryPairs(t, db, "SELECT account_id||'|'||ref,delta FROM ledger WHERE reason='currency-merge'")
	if len(merges) != 3 || merges["alice|gold:6"] != 1 || merges["bob|gold:7"] != -1 || merges["dave|gold:0"] != -1 {
		t.Fatal("merge rows", merges)
	}
	mustQuery(t, db, "SELECT count(*) FROM ledger WHERE reason='currency-merge' AND (currency<>'glims' OR earned_delta<>0)", 0)
	// The halved gold rows, as the log will read them.
	if got := strings.Join(queryStrings(t, db, "SELECT reason||':'||delta FROM ledger WHERE account_id='alice' AND currency='glims' AND reason<>'currency-merge' ORDER BY id"), " "); got != "sync:10 habitica-topup:11 market-buy:-2 mail-send:-3 mail-send:-2 mail-recall:2 mail-send:-4" {
		t.Fatal("alice's glims rows", got)
	}
	// Other currencies are untouched.
	mustQuery(t, db, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE currency='material:timber'", 5)

	// The escrow holds exactly the letters still waiting, per sender.
	escrow := queryPairs(t, db, "SELECT account_id,COALESCE(SUM(delta),0) FROM ledger WHERE currency='mail:glims:glims' GROUP BY account_id")
	waiting := queryPairs(t, db, "SELECT from_id,COALESCE(SUM(qty),0) FROM mail WHERE kind='glims' AND claimed_at IS NULL AND returned_at IS NULL GROUP BY from_id")
	if len(escrow) != 1 || escrow["alice"] != 3 || len(waiting) != 1 || waiting["alice"] != 3 {
		t.Fatal("escrow", escrow, "waiting", waiting)
	}

	// Every letter survives: the gold ones are glim letters with their qty
	// halved (rounded up); every other column, and every other letter, as
	// it was.
	lettersAfter := queryStrings(t, db, "SELECT "+letterRow+" FROM mail ORDER BY id")
	if len(lettersAfter) != len(lettersBefore) {
		t.Fatal("letters lost or duplicated", lettersAfter)
	}
	halved := map[string]string{"'m-wait'": ",5,", "'m-recalled'": ",3,", "'m-claimed'": ",7,"}
	want := map[string]string{"'m-wait'": ",3,", "'m-recalled'": ",2,", "'m-claimed'": ",4,"}
	for i, row := range lettersBefore {
		id := row[:strings.Index(row, ",")]
		if from, ok := halved[id]; ok {
			row = strings.Replace(row, "'gold','gold'"+from, "'glims','glims'"+want[id], 1)
		}
		if lettersAfter[i] != row {
			t.Fatalf("letter %s became %s", row, lettersAfter[i])
		}
	}
	mustQuery(t, db, "SELECT count(*) FROM mail WHERE kind='gold' OR item_def='gold'", 0)

	// The table is 032's with 'glims' where 'gold' was; its indexes and
	// foreign keys are the same, name and statement alike.
	if want := strings.ReplaceAll(sqlBefore, "'gold'", "'glims'"); tableSQL(t, db, "mail") != want {
		t.Fatalf("the rebuilt mail table:\n got %s\nwant %s", tableSQL(t, db, "mail"), want)
	}
	if got := indexSQLs(t, db, "mail"); strings.Join(got, "\n") != strings.Join(indexesBefore, "\n") {
		t.Fatalf("mail indexes:\n got %v\nwant %v", got, indexesBefore)
	}
	if got := foreignKeys(t, db, "mail"); strings.Join(got, "\n") != strings.Join(fksBefore, "\n") {
		t.Fatalf("mail foreign keys:\n got %v\nwant %v", got, fksBefore)
	}

	// Top-ups record the glims they credit; held sync credit is in glims.
	mustQuery(t, db, "SELECT glims FROM purse_topups WHERE id='top-a'", 10)
	mustQuery(t, db, "SELECT glims FROM purse_topups WHERE id='top-x'", 20)
	mustQuery(t, db, "SELECT glims FROM pending_credits WHERE account_id='alice'", 4)

	// Shelf prices were gold; they are glims now, halved and rounded up.
	if got := strings.Join(queryStrings(t, db, "SELECT slot||':'||price FROM gate_shelf_slots WHERE homestead_id='home' ORDER BY slot"), " "); got != "0:3 1:1 2:0 3:4" {
		t.Fatal("shelf prices", got)
	}

	// No column, view or trigger is still named for embers, and the gold
	// column is gone.
	for _, table := range queryStrings(t, db, "SELECT name FROM sqlite_master WHERE type='table'") {
		for _, column := range queryStrings(t, db, "SELECT name FROM pragma_table_info('"+table+"')") {
			if c := strings.ToLower(column); strings.Contains(c, "ember") && !strings.Contains(c, "member") {
				t.Fatalf("%s.%s is still named for embers", table, column)
			}
		}
	}
	mustQuery(t, db, "SELECT count(*) FROM pragma_table_info('balances') WHERE name='gold'", 0)
	mustQuery(t, db, "SELECT count(*) FROM sqlite_master WHERE type IN ('view','trigger') AND (sql LIKE '%embers%' OR sql LIKE '%''gold''%')", 0)

	// The account loads, and its snapshot holds the glims.
	func() {
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback()
		snap, err := Load(context.Background(), tx, "alice")
		if err != nil {
			t.Fatal(err)
		}
		if snap.State.Embers != 13 || snap.State.XPEmbers != 4 {
			t.Fatal("alice loads with", snap.State.Embers, snap.State.XPEmbers)
		}
	}()

	// The renamed columns kept their checks, and the new letter shape holds.
	for _, broken := range []string{
		`UPDATE balances SET xp_glims=glims+1 WHERE account_id='alice'`,
		`UPDATE balances SET glims=-1 WHERE account_id='carol'`,
		`UPDATE purse_topups SET glims=-1 WHERE id='top-a'`,
		`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES('x','w','alice','bob','gold','gold',5,'[]','[]',1)`,
		`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES('x','w','alice','bob','glims','glims',0,'[]','[]',1)`,
		`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES('x','w','alice','bob','glims','tallow',5,'[]','[]',1)`,
	} {
		if _, err := db.Exec(broken); err == nil {
			t.Fatal("a broken write was accepted:", broken)
		}
	}
	if _, err := db.Exec(`INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES('m-new','w','alice','bob','glims','glims',5,'[]','[]',10)`); err != nil {
		t.Fatal("a glim letter was refused", err)
	}
	fk, err := db.Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	defer fk.Close()
	if fk.Next() {
		t.Fatal("invalid upgraded foreign keys")
	}
}
