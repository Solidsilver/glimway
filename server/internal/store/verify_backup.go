package store

import (
	"context"
	"database/sql"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

// BackupSummary is what verify-backup reports about a snapshot.
type BackupSummary struct {
	Schema       string   // newest applied migration
	Pending      int      // migrations this binary would still apply on restore
	PendingNames []string // their names, oldest first
	Counts       map[string]int64
}

// The tables verify-backup counts, in print order: accounts, worlds, homes,
// then what migrate --dry-run also prints: items, plants and the land kept
// by lamps. A table the snapshot's schema lacks has no count.
var backupCountTables = []string{"players", "worlds", "homesteads",
	"item_stacks", "item_instances", "homestead_items",
	"homestead_plants", "camp_plants", "carried_plants",
	"holds", "lot_lanterns", "camps", "communal_lamps", "recovery_crates", "recovery_entries"}

// VerifyBackup checks that a snapshot is a sound database this binary can
// open, without writing to it: immutable read-only mode creates no -wal or
// -shm beside the file. A snapshot from a newer binary fails, as does one
// whose history this binary could not migrate forward.
func VerifyBackup(ctx context.Context, path string) (BackupSummary, error) {
	var sum BackupSummary
	abs, err := filepath.Abs(path)
	if err != nil {
		return sum, err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return sum, err
	}
	if !info.Mode().IsRegular() || info.Size() == 0 {
		return sum, fmt.Errorf("not a database file")
	}
	dsn := (&url.URL{Scheme: "file", Path: abs, RawQuery: "mode=ro&immutable=1"}).String()
	db, err := sql.Open("sqlite", dsn+"&_pragma=query_only(1)")
	if err != nil {
		return sum, err
	}
	defer db.Close()
	db.SetMaxOpenConns(1)
	rows, err := db.QueryContext(ctx, "PRAGMA integrity_check")
	if err != nil {
		return sum, fmt.Errorf("integrity check: %w", err)
	}
	var problems []string
	for rows.Next() {
		var line string
		if err = rows.Scan(&line); err != nil {
			rows.Close()
			return sum, fmt.Errorf("integrity check: %w", err)
		}
		if line != "ok" {
			problems = append(problems, line)
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return sum, fmt.Errorf("integrity check: %w", err)
	}
	if len(problems) > 0 {
		return sum, fmt.Errorf("integrity check: %s", strings.Join(problems, "; "))
	}
	history, err := migrationHistory()
	if err != nil {
		return sum, err
	}
	known := make([]string, len(history))
	for i, m := range history {
		known[i] = m.Name
	}
	rows, err = db.QueryContext(ctx, "SELECT name FROM schema_migrations ORDER BY name")
	if err != nil {
		return sum, fmt.Errorf("schema: %w", err)
	}
	applied := map[string]bool{}
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			rows.Close()
			return sum, err
		}
		if !slices.Contains(known, name) {
			rows.Close()
			return sum, fmt.Errorf("schema: migration %s is unknown to this server version (backup from a newer one?)", name)
		}
		applied[name] = true
		sum.Schema = name
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return sum, err
	}
	if sum.Schema == "" {
		return sum, fmt.Errorf("schema: no migrations applied")
	}
	// The same rule migrate enforces: pending migrations only above the newest applied.
	for _, name := range known {
		if applied[name] {
			continue
		}
		if name < sum.Schema {
			return sum, fmt.Errorf("schema: migration %s missing below %s", name, sum.Schema)
		}
		sum.Pending++
		sum.PendingNames = append(sum.PendingNames, name)
	}
	sum.Counts = map[string]int64{}
	for _, table := range backupCountTables {
		var exists int
		if err = db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name=?", table).Scan(&exists); err != nil {
			return sum, err
		}
		if exists == 0 {
			continue
		}
		var n int64
		if err = db.QueryRowContext(ctx, "SELECT count(*) FROM "+table).Scan(&n); err != nil {
			return sum, fmt.Errorf("count %s: %w", table, err)
		}
		sum.Counts[table] = n
	}
	return sum, nil
}

// BackupCountTables is the tables a BackupSummary counts, in print order.
func BackupCountTables() []string { return slices.Clone(backupCountTables) }
