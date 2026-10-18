package store

import (
	"context"
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
	// The copy is left closed and current: a second run applies nothing.
	for _, suffix := range []string{"-wal", "-shm"} {
		if _, err := os.Stat(path + suffix); err == nil {
			t.Fatalf("%s left behind", suffix)
		}
	}
	again, err := DryRunMigrate(context.Background(), path)
	if err != nil || len(again.Applied) != 0 || again.Before.Schema != run.After.Schema {
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
