package store

import (
	"context"
	"errors"
	"glimway/server/internal/itemmove"
	"path/filepath"
	"strconv"
	"testing"
)

// goldAccount seeds one account the way the upgrade fixture does: the rows
// store.Load joins over, and a purse to spend.
func goldAccount(t *testing.T, s *Store, id string, gold int) {
	t.Helper()
	seed := `INSERT OR IGNORE INTO worlds(id,owner_id,seed,created_at) VALUES('w','','seed',1);
INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES('` + id + `','Hero','w',11,12,1);
INSERT INTO player_vitals(account_id,hp,mana,vitals_at,vitals_set_version) VALUES('` + id + `',32,12,1,0);
INSERT INTO player_place(account_id,area,x,y) VALUES('` + id + `','village',2,3);
INSERT INTO balances(account_id,embers,xp_embers,gold) VALUES('` + id + `',0,0,` + strconv.Itoa(gold) + `);
INSERT INTO sync_baselines(account_id,profile_json,verified_xp,checkpoint_json,checkpoint_at,updated_at) VALUES('` + id + `','{}',0,'{}',12,12);`
	if _, err := s.DB.Exec(seed); err != nil {
		t.Fatal(err)
	}
}

// TestGoldCreditAndDebit guards the purse's only two writes (design 3.5):
// the balance moves with gold = gold + ?, each change is one ledger row with
// currency 'gold' and earned_delta 0, the version moves so the next answer
// carries the new balance, and a debit the purse can't cover writes nothing.
func TestGoldCreditAndDebit(t *testing.T) {
	s, err := Open(filepath.Join(t.TempDir(), "gold.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	goldAccount(t, s, "alice", 0)
	goldAccount(t, s, "bob", 0)
	ctx := context.Background()
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if err = CreditGold(ctx, tx, "alice", 200, "habitica-topup", "top-1", 10); err != nil {
		t.Fatal(err)
	}
	if err = DebitGold(ctx, tx, "alice", 20, "give", "bob", 11); err != nil {
		t.Fatal(err)
	}
	if err = CreditGold(ctx, tx, "bob", 20, "gift", "alice", 11); err != nil {
		t.Fatal(err)
	}
	// A debit past the purse is refused before anything is written.
	if err = DebitGold(ctx, tx, "alice", 100000, "give", "bob", 12); !errors.Is(err, ErrShortOfGold) {
		t.Fatal("overspend:", err)
	}
	if err = tx.Commit(); err != nil {
		t.Fatal(err)
	}
	mustQuery(t, s.DB, "SELECT gold FROM balances WHERE account_id='alice'", 180)
	mustQuery(t, s.DB, "SELECT gold FROM balances WHERE account_id='bob'", 20)
	// Every gold row is earned_delta 0, and the rows sum to the balance.
	mustQuery(t, s.DB, "SELECT count(*) FROM ledger WHERE currency='gold' AND earned_delta!=0", 0)
	mustQuery(t, s.DB, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE account_id='alice' AND currency='gold'", 180)
	mustQuery(t, s.DB, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE account_id='bob' AND currency='gold'", 20)
	// The versions moved, one per write.
	mustQuery(t, s.DB, "SELECT version FROM players WHERE account_id='alice'", 3)
	mustQuery(t, s.DB, "SELECT version FROM players WHERE account_id='bob'", 2)
	// The purse is a balances column and one currency in the ledger: the
	// transfer's two rows name each other.
	mustQuery(t, s.DB, "SELECT count(*) FROM ledger WHERE account_id='alice' AND currency='"+itemmove.Gold()+"' AND reason='give' AND ref='bob'", 1)
	mustQuery(t, s.DB, "SELECT count(*) FROM ledger WHERE account_id='bob' AND reason='gift' AND ref='alice'", 1)
}
