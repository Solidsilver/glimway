package store

import (
	"database/sql"
	"embed"
	"encoding/json"
	"fmt"
	"io/fs"
	"time"
)

// History describes the embedded code shipped today, not the SQL used by an
// older binary to create an existing database. Applied rows still retain names.
// Freeze recorded SQL/backfills; change behavior through a forward migration.
//
//go:embed migrations/*.sql migrations/history.json migration_003_backfill.go
var migrations embed.FS

type migrationRecord struct {
	Name           string `json:"name"`
	SHA256         string `json:"sha256"`
	Backfill       string `json:"backfill,omitempty"`
	BackfillSHA256 string `json:"backfillSha256,omitempty"`
}

var migrationBackfills = map[string]func(*sql.Tx) error{
	"migration_003_backfill.go": initializeLossReferences,
}

func migrationHistory() ([]migrationRecord, error) {
	return readMigrationHistory(migrations)
}
func readMigrationHistory(source fs.FS) ([]migrationRecord, error) {
	raw, err := fs.ReadFile(source, "migrations/history.json")
	if err != nil {
		return nil, err
	}
	var history []migrationRecord
	if err = json.Unmarshal(raw, &history); err != nil {
		return nil, err
	}
	files, err := fs.Glob(source, "migrations/*.sql")
	if err != nil {
		return nil, err
	}
	if len(history) != len(files) {
		return nil, fmt.Errorf("migration history does not match SQL files")
	}
	// Startup checks only the bundle's names and count. Tests freeze deployed
	// hashes and validate SQL/backfill contents and registration metadata.
	for i, m := range history {
		if m.Name != files[i][len("migrations/"):] {
			return nil, fmt.Errorf("migration history entry %d has unexpected name %s", i, m.Name)
		}
	}
	return history, nil
}

// Both upgrades and fixtures invoke SQL and its registered Go backfill together.
func applyMigration(tx *sql.Tx, m migrationRecord, now int64) error {
	raw, err := migrations.ReadFile("migrations/" + m.Name)
	if err != nil {
		return err
	}
	if _, err = tx.Exec(string(raw)); err != nil {
		return fmt.Errorf("migration %s: %w", m.Name, err)
	}
	if m.Backfill != "" {
		if err = migrationBackfills[m.Backfill](tx); err != nil {
			return fmt.Errorf("backfill %s: %w", m.Backfill, err)
		}
	}
	_, err = tx.Exec("INSERT INTO schema_migrations VALUES(?,?)", m.Name, now)
	return err
}

// Hold an immediate transaction before both the schema check and each change.
func migrate(db *sql.DB) error {
	history, err := migrationHistory()
	if err != nil {
		return err
	}
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"); err != nil {
		return err
	}
	var newest string
	if err = tx.QueryRow("SELECT COALESCE(MAX(name),'') FROM schema_migrations").Scan(&newest); err != nil {
		return err
	}
	// Refuse pending migrations inserted below already-applied history.
	for _, m := range history {
		var applied int
		if err = tx.QueryRow("SELECT count(*) FROM schema_migrations WHERE name=?", m.Name).Scan(&applied); err != nil {
			return err
		}
		if applied == 0 && m.Name < newest {
			return fmt.Errorf("out-of-order migration %s after %s: renumber it above the newest applied migration", m.Name, newest)
		}
	}
	for _, m := range history {
		var applied int
		if err = tx.QueryRow("SELECT count(*) FROM schema_migrations WHERE name=?", m.Name).Scan(&applied); err != nil {
			return err
		}
		if applied != 0 {
			continue
		}
		if err = applyMigration(tx, m, time.Now().Unix()); err != nil {
			return err
		}
	}
	return tx.Commit()
}
