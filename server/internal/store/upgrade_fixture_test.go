package store

import (
	"database/sql"
	"strings"
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

// Only assertions against today's schema use this projection; historical seed
// SQL and the deployed migrations remain the actual old schema.
func currentSchemaSQL(q string) string {
	if !strings.Contains(q, "pending_sessions") && !strings.Contains(q, "allowlist") && !strings.Contains(q, "access_removals") {
		q = strings.ReplaceAll(q, "habitica_id", "account_id")
	}
	q = strings.ReplaceAll(q, "rev=7", "version=7")
	return q
}

// Earlier upgrade tests seed partial account rows to isolate their migration.
// They represent players who had already chosen an origin, not unfinished 026
// sign-ins (whose complete checkpoint fixtures have their own tests).
func markFixtureOrigins(t *testing.T, db *sql.DB) {
	t.Helper()
	if _, err := db.Exec("UPDATE players SET save_origin='fresh' WHERE save_origin IS NULL"); err != nil {
		t.Fatal(err)
	}
}
