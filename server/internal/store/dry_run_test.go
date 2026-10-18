package store

import (
	"bytes"
	"context"
	"database/sql"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// The rehearsal on a copy of a last-release database: verify-backup's
// checks pass before and after, every pending migration applies, and the
// counts show the new tables appear and nothing is lost.
func TestDryRunMigrateUpgradesACopy(t *testing.T) {
	path := filepath.Join(t.TempDir(), "copy.sqlite")
	old := newUpgradeFixture(t, path, lastShippedMigration, nil)
	if _, err := old.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',1);
 INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at) VALUES('alice','Alice','w',1,1);
 INSERT INTO homesteads(id,world_id,gate,tier,claimed_at) VALUES('house','w',0,1,1);
 INSERT INTO homestead_items(id,item_def,location,account_id) VALUES('piece','wooden-stool','inventory','alice');
 INSERT INTO homestead_plants VALUES('thyme','house','wild-thyme',5,6,100,3);
 INSERT INTO item_stacks VALUES('pack','alice','timber','',40);`); err != nil {
		t.Fatal(err)
	}
	old.Close()
	original := fileBytes(t, path)
	run, err := DryRunMigrate(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	history, err := migrationHistory()
	if err != nil {
		t.Fatal(err)
	}
	var pending []string
	for _, m := range history[len(shippedMigrationHistory):] {
		pending = append(pending, m.Name)
	}
	if run.Before.Schema != lastShippedMigration || run.After.Schema != history[len(history)-1].Name || !reflect.DeepEqual(run.Applied, pending) {
		t.Fatalf("schema %s -> %s, applied %v", run.Before.Schema, run.After.Schema, run.Applied)
	}
	for table, want := range map[string]int64{"players": 1, "worlds": 1, "homesteads": 1, "homestead_items": 1, "homestead_plants": 1, "item_stacks": 1} {
		if run.Before.Counts[table] != want || run.After.Counts[table] != want {
			t.Fatalf("%s: %d -> %d, want %d", table, run.Before.Counts[table], run.After.Counts[table], want)
		}
	}
	if _, ok := run.Before.Counts["holds"]; ok {
		t.Fatal("holds counted before 0.12")
	}
	if n, ok := run.After.Counts["holds"]; !ok || n != 0 {
		t.Fatal("holds after", n, ok)
	}
	// The file given is only read: byte for byte the same, nothing beside it,
	// so a second run rehearses the same upgrade.
	if !bytes.Equal(fileBytes(t, path), original) {
		t.Fatal("the dry run wrote to the file it was given")
	}
	for _, suffix := range []string{"-wal", "-shm", "-journal"} {
		if _, err := os.Stat(path + suffix); err == nil {
			t.Fatalf("%s left behind", suffix)
		}
	}
	again, err := DryRunMigrate(context.Background(), path)
	if err != nil || !reflect.DeepEqual(again.Applied, run.Applied) || again.Before.Schema != lastShippedMigration {
		t.Fatal("second run", again, err)
	}
}

func TestDryRunMigrateRefusals(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	current := filepath.Join(dir, "current.sqlite")
	s, err := Open(current)
	if err != nil {
		t.Fatal(err)
	}
	// An open database has its -wal and -shm beside it.
	if _, err = DryRunMigrate(ctx, current); err == nil || !strings.Contains(err.Error(), "may have this database open") {
		t.Fatal("ran on an open database", err)
	}
	s.Close()

	// A database a dev server ran retired pending migrations on (glim-dev
	// after the 0.13 consolidation) is refused, not half-upgraded.
	retired := filepath.Join(dir, "retired.sqlite")
	old := newUpgradeFixture(t, retired, lastShippedMigration, nil)
	if _, err = old.Exec("INSERT INTO schema_migrations VALUES('048_carried_plants.sql',0)"); err != nil {
		t.Fatal(err)
	}
	old.Close()
	if _, err = DryRunMigrate(ctx, retired); err == nil || !strings.Contains(err.Error(), "048_carried_plants.sql is unknown") {
		t.Fatal("retired history", err)
	}

	for name, data := range map[string]string{"empty.sqlite": "", "junk.sqlite": "not a database"} {
		path := filepath.Join(dir, name)
		if err = os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err = DryRunMigrate(ctx, path); err == nil {
			t.Fatal("migrated", name)
		}
	}
	if _, err = DryRunMigrate(ctx, filepath.Join(dir, "missing.sqlite")); err == nil {
		t.Fatal("migrated a missing file")
	}
	if _, err = os.Stat(filepath.Join(dir, "missing.sqlite")); err == nil {
		t.Fatal("created the missing file")
	}

	// On Linux, any process this user can see holding the file.
	if _, err = os.Stat("/proc/self/fd"); err != nil {
		return
	}
	held, err := os.Open(current)
	if err != nil {
		t.Fatal(err)
	}
	defer held.Close()
	if _, err = DryRunMigrate(ctx, current); err == nil || !strings.Contains(err.Error(), "open: rehearse on a copy") {
		t.Fatal("ran on a held file", err)
	}
}

// newestMigration reads a database's newest applied migration without
// migrating it.
func newestMigration(t *testing.T, path string) string {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var name string
	if err = db.QueryRow("SELECT MAX(name) FROM schema_migrations").Scan(&name); err != nil {
		t.Fatal(err)
	}
	return name
}

// A hard link is another name for the same file: one to a database a server
// has open (in WAL mode, sidecars beside the live name only) is refused, and
// the live database stays at its schema.
func TestDryRunMigrateRefusesAHardLinkToALiveDatabase(t *testing.T) {
	dir := t.TempDir()
	live := filepath.Join(dir, "live.sqlite")
	newUpgradeFixture(t, live, lastShippedMigration, nil).Close()
	server, err := sql.Open("sqlite", live)
	if err != nil {
		t.Fatal(err)
	}
	server.SetMaxOpenConns(1)
	if _, err = server.Exec("PRAGMA journal_mode=WAL; INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',1)"); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "copy.sqlite")
	if err = os.Link(live, link); err != nil {
		t.Skip("no hard links here:", err)
	}
	if _, err = DryRunMigrate(context.Background(), link); err == nil || !strings.Contains(err.Error(), "hard links") {
		t.Fatal("ran on a hard link to a live database", err)
	}
	server.Close()
	if got := newestMigration(t, live); got != lastShippedMigration {
		t.Fatalf("the live database moved to %s", got)
	}
	// Even with the link gone and the live file closed, the original is
	// only read: the rehearsal migrates its own snapshot.
	if err = os.Remove(link); err != nil {
		t.Fatal(err)
	}
	before := fileBytes(t, live)
	if _, err = DryRunMigrate(context.Background(), live); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(fileBytes(t, live), before) || newestMigration(t, live) != lastShippedMigration {
		t.Fatal("the dry run wrote to the database it was given")
	}
}

// A symlink is resolved before the sidecars are looked for: a -journal
// beside its target refuses it, and the target is not migrated.
func TestDryRunMigrateResolvesSymlinksFirst(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "data", "game.sqlite")
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	newUpgradeFixture(t, target, lastShippedMigration, nil).Close()
	link := filepath.Join(dir, "copy.sqlite")
	if err := os.Symlink(target, link); err != nil {
		t.Skip("no symlinks here:", err)
	}
	before := fileBytes(t, target)
	// With nothing beside the target, the link is followed, read, and left alone.
	if _, err := DryRunMigrate(context.Background(), link); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target+"-journal", []byte("hot"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := DryRunMigrate(context.Background(), link); err == nil || !strings.Contains(err.Error(), "game.sqlite-journal exists") {
		t.Fatal("ran past a sidecar beside the target", err)
	}
	if !bytes.Equal(fileBytes(t, target), before) {
		t.Fatal("the target was written")
	}
	if err := os.Remove(target + "-journal"); err != nil {
		t.Fatal(err)
	}
	if got := newestMigration(t, target); got != lastShippedMigration {
		t.Fatalf("the target moved to %s", got)
	}
}
