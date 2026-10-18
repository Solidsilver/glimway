package main

import (
	"bytes"
	"glimway/server/internal/store"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestMigrateDryRunCommand(t *testing.T) {
	dir := t.TempDir()
	path, backup := filepath.Join(dir, "game.sqlite"), filepath.Join(dir, "backup.sqlite")
	if err := run([]string{"-db", path, "backup", backup}); err != nil {
		t.Fatal(err)
	}
	// The rehearsal never opens -db: a missing database stays missing.
	unopened := filepath.Join(dir, "never", "game.sqlite")
	if err := run([]string{"-db", unopened, "migrate", "--dry-run", backup}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Dir(unopened)); !os.IsNotExist(err) {
		t.Fatal("migrate --dry-run opened -db", err)
	}
	broken := filepath.Join(dir, "broken.sqlite")
	if err := os.WriteFile(broken, []byte("not a database"), 0600); err != nil {
		t.Fatal(err)
	}
	// A copy whose newest migration fails to apply: here, one marked unapplied
	// though its tables stand.
	failing := filepath.Join(dir, "failing.sqlite")
	if err := run([]string{"-db", path, "backup", failing}); err != nil {
		t.Fatal(err)
	}
	s, err := store.Open(failing)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = s.DB.Exec("DELETE FROM schema_migrations WHERE name=(SELECT MAX(name) FROM schema_migrations)"); err != nil {
		t.Fatal(err)
	}
	s.Close()
	for _, tt := range []struct {
		cmd  []string
		want string
	}{
		{[]string{"migrate"}, "usage"},
		{[]string{"migrate", backup}, "usage"},
		{[]string{"migrate", "--dry-run"}, "usage"},
		{[]string{"migrate", "--dry-run", backup, "extra"}, "usage"},
		{[]string{"migrate", "--dry-run", path}, "this server's -db"},
		{[]string{"migrate", "--dry-run", broken}, "before:"},
		{[]string{"migrate", "--dry-run", failing}, "migrate:"},
	} {
		if err := run(append([]string{"-db", path}, tt.cmd...)); err == nil || !strings.Contains(err.Error(), tt.want) {
			t.Fatalf("%v: %v, want %q", tt.cmd, err, tt.want)
		}
	}
}

func TestPrintDryRun(t *testing.T) {
	var out bytes.Buffer
	printDryRun(&out, "copy.sqlite", store.DryRun{
		Before:  store.BackupSummary{Schema: "037_one_town.sql", Counts: map[string]int64{"players": 3, "worlds": 2, "homesteads": 1}},
		After:   store.BackupSummary{Schema: "038_lamps.sql", Counts: map[string]int64{"players": 3, "worlds": 2, "homesteads": 1, "holds": 0}},
		Applied: []string{"038_lamps.sql"},
		Took:    1500 * time.Millisecond,
	})
	for _, want := range []string{
		"ok copy.sqlite\nschema 037_one_town.sql -> 038_lamps.sql\napplied 1 in 1.5s: 038_lamps.sql\n",
		"accounts                  3          3\n",
		"holds                     -          0\n",
	} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q in:\n%s", want, out.String())
		}
	}
}
