package store

import (
	"context"
	"database/sql"
	"errors"
	"glimway/server/internal/itemmove"
	"path/filepath"
	"strconv"
	"testing"
)

// glimsAccount seeds one account the way the upgrade fixture does: the rows
// store.Load joins over, and glims to spend (earned of them from XP).
func glimsAccount(t *testing.T, s *Store, id string, glims, earned int) {
	t.Helper()
	seed := `INSERT OR IGNORE INTO worlds(id,owner_id,seed,created_at) VALUES('w','','seed',1);
INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES('` + id + `','Hero','w',11,12,1);
INSERT INTO player_vitals(account_id,hp,mana,vitals_at,vitals_set_version) VALUES('` + id + `',32,12,1,0);
INSERT INTO player_place(account_id,area,x,y) VALUES('` + id + `','village',2,3);
INSERT INTO balances(account_id,glims,xp_glims) VALUES('` + id + `',` + strconv.Itoa(glims) + `,` + strconv.Itoa(earned) + `);
INSERT INTO sync_baselines(account_id,profile_json,verified_xp,checkpoint_json,checkpoint_at,updated_at) VALUES('` + id + `','{}',0,'{}',12,12);`
	if _, err := s.DB.Exec(seed); err != nil {
		t.Fatal(err)
	}
}

func openGlims(t *testing.T) *Store {
	t.Helper()
	s, err := Open(filepath.Join(t.TempDir(), "glims.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

// TestMoveGlimsToOtherAccounts guards MoveGlims for an account that isn't
// the snapshot's (silas-yard.md 1.4, purse-and-wardrobe.md 3.5): the balance
// moves by a delta, each change is one ledger row with currency 'glims', a
// credit is never XP-earned, the version moves so the next answer carries the
// new balance, a debit spends XP-earned glims last, and one the balance can't
// cover writes nothing.
func TestMoveGlimsToOtherAccounts(t *testing.T) {
	s := openGlims(t)
	glimsAccount(t, s, "alice", 0, 0)
	glimsAccount(t, s, "bob", 0, 0)
	glimsAccount(t, s, "carol", 10, 8)
	ctx := context.Background()
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err = MoveGlims(ctx, tx, nil, "alice", 200, "habitica-topup", "top-1", 10); err != nil {
		t.Fatal(err)
	}
	if err = MoveGlims(ctx, tx, nil, "alice", -20, "give", "bob", 11); err != nil {
		t.Fatal(err)
	}
	if err = MoveGlims(ctx, tx, nil, "bob", 20, "gift", "alice", 11); err != nil {
		t.Fatal(err)
	}
	// A debit past the balance is refused before anything is written.
	if err = MoveGlims(ctx, tx, nil, "alice", -100000, "give", "bob", 12); !errors.Is(err, ErrShortOfGlims) {
		t.Fatal("overspend:", err)
	}
	// A zero change to another account is free and writes nothing: no row,
	// no version (the versions below count only the two real moves).
	if err = MoveGlims(ctx, tx, nil, "alice", 0, "zero-price", "bob", 12); err != nil {
		t.Fatal("a move of nothing:", err)
	}
	// Glims from XP go last (1.4 rule 4): of carol's 10, 8 are earned;
	// spending 5 takes the other 2 first, then 3 earned.
	if err = MoveGlims(ctx, tx, nil, "carol", -5, "give", "bob", 12); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	mustQuery(t, s.DB, "SELECT glims FROM balances WHERE account_id='alice'", 180)
	mustQuery(t, s.DB, "SELECT glims FROM balances WHERE account_id='bob'", 20)
	mustQuery(t, s.DB, "SELECT glims FROM balances WHERE account_id='carol'", 5)
	mustQuery(t, s.DB, "SELECT xp_glims FROM balances WHERE account_id='carol'", 5)
	mustQuery(t, s.DB, "SELECT earned_delta FROM ledger WHERE account_id='carol'", -3)
	// Credits are never XP-earned: alice's and bob's rows are earned_delta 0
	// and sum to the balance.
	mustQuery(t, s.DB, "SELECT xp_glims FROM balances WHERE account_id IN ('alice','bob')", 0)
	mustQuery(t, s.DB, "SELECT count(*) FROM ledger WHERE currency='glims' AND earned_delta!=0 AND account_id!='carol'", 0)
	mustQuery(t, s.DB, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE account_id='alice' AND currency='glims'", 180)
	mustQuery(t, s.DB, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE account_id='bob' AND currency='glims'", 20)
	// The versions moved, one per write.
	mustQuery(t, s.DB, "SELECT version FROM players WHERE account_id='alice'", 3)
	mustQuery(t, s.DB, "SELECT count(*) FROM ledger WHERE reason='zero-price'", 0)
	mustQuery(t, s.DB, "SELECT version FROM players WHERE account_id='bob'", 2)
	// The transfer's two rows name each other.
	mustQuery(t, s.DB, "SELECT count(*) FROM ledger WHERE account_id='alice' AND currency='"+itemmove.Glims()+"' AND reason='give' AND ref='bob'", 1)
	mustQuery(t, s.DB, "SELECT count(*) FROM ledger WHERE account_id='bob' AND reason='gift' AND ref='alice'", 1)
}

// TestMoveGlimsOnTheOwnSnapshot: the caller's own glims move on its
// snapshot, so the answer carries them, and Persist writes them; a credit is
// never XP-earned and a debit spends earned glims last, counting what the
// snapshot already holds but hasn't persisted.
func TestMoveGlimsOnTheOwnSnapshot(t *testing.T) {
	s := openGlims(t)
	glimsAccount(t, s, "alice", 10, 8)
	ctx := context.Background()
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	snap, err := Load(ctx, tx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	// An XP credit, held on the snapshot only so far.
	if err = Credit(ctx, tx, &snap, 4, 4, "sync", "xp", nil, 20); err != nil {
		t.Fatal(err)
	}
	// A letter collected: 3 glims in, none earned.
	if err = MoveGlims(ctx, tx, &snap, "alice", 3, "mail-claim", "m1", 21); err != nil {
		t.Fatal(err)
	}
	// A free price on one's own account is the zero-delta mark Credit
	// writes, and moves nothing.
	if err = MoveGlims(ctx, tx, &snap, "alice", 0, "homestead-clear", "free", 21); err != nil {
		t.Fatal("a free price:", err)
	}
	mustQueryTx(t, tx, "SELECT count(*) FROM ledger WHERE reason='homestead-clear' AND delta=0 AND earned_delta=0", 1)
	if snap.State.Glims != 17 || snap.State.XPGlims != 12 {
		t.Fatal("the snapshot", snap.State.Glims, snap.State.XPGlims)
	}
	// A spend of 16: the 5 that aren't earned first, then 11 earned. The
	// balance it checks is the snapshot's 17, not the column's 10.
	if err = MoveGlims(ctx, tx, &snap, "alice", -16, "market-buy", "silas-yard:timber", 22); err != nil {
		t.Fatal(err)
	}
	if err = MoveGlims(ctx, tx, &snap, "alice", -2, "market-buy", "silas-yard:timber", 22); !errors.Is(err, ErrShortOfGlims) {
		t.Fatal("overspend:", err)
	}
	if snap.State.Glims != 1 || snap.State.XPGlims != 1 {
		t.Fatal("after the spend", snap.State.Glims, snap.State.XPGlims)
	}
	// Nothing reaches the column until Persist.
	mustQueryTx(t, tx, "SELECT glims FROM balances WHERE account_id='alice'", 10)
	if err = Persist(ctx, tx, &snap, 23); err != nil {
		t.Fatal(err)
	}
	mustQueryTx(t, tx, "SELECT glims FROM balances WHERE account_id='alice'", 1)
	mustQueryTx(t, tx, "SELECT xp_glims FROM balances WHERE account_id='alice'", 1)
	mustQueryTx(t, tx, "SELECT earned_delta FROM ledger WHERE reason='mail-claim'", 0)
	mustQueryTx(t, tx, "SELECT earned_delta FROM ledger WHERE reason='market-buy'", -11)
}

// TestPersistNeverOverwritesAColumnWrite is the one path's point (A's
// deviation 5): Persist writes the snapshot's change as a delta, so a glim
// write that reached the same account earlier in the transaction — by any
// path — is kept, and a second Persist writes nothing twice.
func TestPersistNeverOverwritesAColumnWrite(t *testing.T) {
	s := openGlims(t)
	glimsAccount(t, s, "alice", 10, 2)
	ctx := context.Background()
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	snap, err := Load(ctx, tx, "alice")
	if err != nil {
		t.Fatal(err)
	}
	// Something credits alice without her snapshot (the sweep returning a
	// letter, say) while her own operation spends on it.
	if err = MoveGlims(ctx, tx, nil, "alice", 7, "mail-return", "m1", 20); err != nil {
		t.Fatal(err)
	}
	if err = MoveGlims(ctx, tx, &snap, "alice", -4, "market-buy", "hazels-kitchen:tallow", 21); err != nil {
		t.Fatal(err)
	}
	if err = Persist(ctx, tx, &snap, 22); err != nil {
		t.Fatal(err)
	}
	mustQueryTx(t, tx, "SELECT glims FROM balances WHERE account_id='alice'", 13)
	mustQueryTx(t, tx, "SELECT xp_glims FROM balances WHERE account_id='alice'", 2)
	mustQueryTx(t, tx, "SELECT SUM(delta) FROM ledger WHERE account_id='alice' AND currency='glims'", 3)
	if err = Persist(ctx, tx, &snap, 23); err != nil {
		t.Fatal(err)
	}
	mustQueryTx(t, tx, "SELECT glims FROM balances WHERE account_id='alice'", 13)
}

// mustQueryTx asserts a scalar query's answer inside a transaction.
func mustQueryTx(t *testing.T, tx *sql.Tx, query string, want int) {
	t.Helper()
	var got int
	if err := tx.QueryRow(query).Scan(&got); err != nil || got != want {
		t.Fatalf("%s: got %d, want %d (%v)", query, got, want, err)
	}
}

// TestTopUpSettlesCreditHalfTheGold (silas-yard.md 1.5): a top-up's amount
// is Habitica gold, two to a glim. The row stores its glims at the reserve,
// and a move credits them — the worker's settle and the owner's alike —
// never XP-earned.
func TestTopUpSettlesCreditHalfTheGold(t *testing.T) {
	s := openGlims(t)
	glimsAccount(t, s, "alice", 3, 3)
	ctx := context.Background()
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err = InsertTopUp(ctx, tx, "worker", "alice", "key-worker", 40, 10); err != nil {
		t.Fatal(err)
	}
	mustQueryTx(t, tx, "SELECT glims FROM purse_topups WHERE id='worker'", 20)
	row, err := TopUpFor(ctx, tx, "worker")
	if err != nil || row.Amount != 40 || row.Glims != 20 {
		t.Fatal("the row", row, err)
	}
	if err = SettleTopUp(ctx, tx, row, TopUpOutcome{State: "moved", SettledBy: "worker"}, 11); err != nil {
		t.Fatal(err)
	}
	mustQueryTx(t, tx, "SELECT glims FROM balances WHERE account_id='alice'", 23)
	mustQueryTx(t, tx, "SELECT delta FROM ledger WHERE reason='habitica-topup' AND ref='worker'", 20)
	// The owner's: an unconfirmed row they settle as moved.
	if err = InsertTopUp(ctx, tx, "owner", "alice", "key-owner", 40, 12); err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec("UPDATE purse_topups SET state='unconfirmed',settled_at=12,settled_by='worker',note='timeout' WHERE id='owner'"); err != nil {
		t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	if err = s.SettleTopUpByOwner(ctx, "owner", "moved", 13); err != nil {
		t.Fatal(err)
	}
	mustQuery(t, s.DB, "SELECT glims FROM balances WHERE account_id='alice'", 43)
	mustQuery(t, s.DB, "SELECT xp_glims FROM balances WHERE account_id='alice'", 3)
	mustQuery(t, s.DB, "SELECT delta FROM ledger WHERE reason='purse-settle' AND ref='owner'", 20)
	list, err := s.PurseTopUpList(ctx, false)
	if err != nil || len(list) != 2 || list[0].Glims != 20 || list[0].Amount != 40 {
		t.Fatal("purse list", list, err)
	}
}
