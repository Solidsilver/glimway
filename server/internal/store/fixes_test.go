package store

import (
	"database/sql"
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

func TestImmediateTransactionsWaitAcrossConnections(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db.sqlite")
	a, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer a.Close()
	b, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	first, err := a.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer first.Rollback()
	var n int
	if err = first.QueryRow("SELECT count(*) FROM allowlist").Scan(&n); err != nil {
		t.Fatal(err)
	}
	began := make(chan *sql.Tx, 1)
	failed := make(chan error, 1)
	go func() {
		tx, err := b.DB.Begin()
		if err != nil {
			failed <- err
			return
		}
		began <- tx
	}()
	early := false
	var second *sql.Tx
	select {
	case second = <-began:
		early = true
	case err := <-failed:
		t.Fatal(err)
	case <-time.After(100 * time.Millisecond):
	}
	if _, err = first.Exec("INSERT INTO allowlist VALUES('one','test',0)"); err != nil {
		t.Fatal(err)
	}
	if err = first.Commit(); err != nil {
		t.Fatal(err)
	}
	if second == nil {
		select {
		case second = <-began:
		case err := <-failed:
			t.Fatal(err)
		case <-time.After(2 * time.Second):
			t.Fatal("writer did not resume")
		}
	}
	defer second.Rollback()
	if _, err = second.Exec("INSERT INTO allowlist VALUES('two','test',0)"); err != nil {
		t.Fatal(err)
	}
	if err = second.Commit(); err != nil {
		t.Fatal(err)
	}
	if early {
		t.Fatal("second transaction acquired before the first writer released its lock")
	}
}
func TestConcurrentFreshOpenMigrations(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db.sqlite")
	start := make(chan struct{})
	errs := make(chan error, 6)
	var wg sync.WaitGroup
	for i := 0; i < 6; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			<-start
			s, err := Open(path)
			if err == nil {
				var n int
				err = s.DB.QueryRow("SELECT count(*) FROM schema_migrations").Scan(&n)
				if err == nil && n != 2 {
					err = sql.ErrNoRows
				}
				s.Close()
			}
			errs <- err
		}()
	}
	close(start)
	wg.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
}
func TestUpgradePreservesOldPendingAndInviteExpiry(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db.sqlite")
	old, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	schema, err := migrations.ReadFile("migrations/001_core.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = old.Exec(string(schema)); err != nil {
		t.Fatal(err)
	}
	for _, q := range []string{
		"CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)",
		"INSERT INTO schema_migrations VALUES('001_core.sql',0)",
		"INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','s',0)",
		"INSERT INTO players(habitica_id,display_name,world_id,created_at,last_seen_at) VALUES('alice','Hero','w',0,0)",
		"INSERT INTO sync_baselines(habitica_id,xp_mark,pending,verified_xp,checkpoint_json,checkpoint_at,updated_at) VALUES('alice',10080,337,4000,'{}',0,42)",
		"INSERT INTO invites(code_hash,created_by,world_id,created_at) VALUES('hash','cli','w',42)",
	} {
		if _, err = old.Exec(q); err != nil {
			t.Fatal(err)
		}
	}
	old.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var xp float64
	var embers int
	if err = s.DB.QueryRow("SELECT reported_xp,embers FROM pending_credits WHERE habitica_id='alice'").Scan(&xp, &embers); err != nil || xp != 10080 || embers != 337 {
		t.Fatal("old pending lost on upgrade")
	}
	var expires int64
	if err = s.DB.QueryRow("SELECT expires_at FROM invites WHERE code_hash='hash'").Scan(&expires); err != nil || expires != 42+30*86400 {
		t.Fatal("old invite expiry not backfilled")
	}
	if _, err = os.Stat(path); err != nil {
		t.Fatal(err)
	}
}
