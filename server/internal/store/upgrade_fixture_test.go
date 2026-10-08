package store

import (
	"database/sql"
	"testing"
)

// newUpgradeFixture builds the real historical schema through an inclusive
// migration name. before seeds old rows immediately before a chosen migration.
// SQL, Go backfills and history rows use the same runner as production upgrades.
func newUpgradeFixture(t *testing.T, path, through string, before func(string, *sql.Tx)) *sql.DB {
	t.Helper()
	history, err := migrationHistory()
	if err != nil {
		t.Fatal(err)
	}
	stop := -1
	for i, m := range history {
		if m.Name == through {
			stop = i
			break
		}
	}
	if stop < 0 {
		t.Fatalf("unknown fixture migration %s", through)
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	t.Cleanup(func() { db.Close() })
	if _, err = db.Exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	for _, m := range history[:stop+1] {
		tx, err := db.Begin()
		if err != nil {
			t.Fatal(err)
		}
		func() {
			defer tx.Rollback()
			if before != nil {
				before(m.Name, tx)
			}
			if err = applyMigration(tx, m, 0); err != nil {
				t.Fatal(err)
			}
			if err = tx.Commit(); err != nil {
				t.Fatal(err)
			}
		}()
	}
	return db
}
