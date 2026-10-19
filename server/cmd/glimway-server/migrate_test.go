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
	// Another name for a database (a hard link), and a symlink to one with a
	// sidecar beside it, are refused, so the command exits non-zero.
	linked, hard := filepath.Join(dir, "linked.sqlite"), filepath.Join(dir, "hard.sqlite")
	if err = run([]string{"-db", path, "backup", linked}); err != nil {
		t.Fatal(err)
	}
	if err = os.Link(linked, hard); err != nil {
		t.Fatal(err)
	}
	journaled, soft := filepath.Join(dir, "journaled.sqlite"), filepath.Join(dir, "soft.sqlite")
	if err = run([]string{"-db", path, "backup", journaled}); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(journaled+"-journal", []byte("hot"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.Symlink(journaled, soft); err != nil {
		t.Fatal(err)
	}
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
		{[]string{"migrate", "--dry-run", hard}, "hard links"},
		{[]string{"migrate", "--dry-run", soft}, "journaled.sqlite-journal exists"},
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

// The quantities and 038's refunds are printed, and each problem on its own line.
func TestPrintDryRunQuantitiesAndRefunds(t *testing.T) {
	var out bytes.Buffer
	run := store.DryRun{
		Before:  store.BackupSummary{Schema: "037_one_town.sql"},
		After:   store.BackupSummary{Schema: "038_lamps.sql"},
		Applied: []string{"038_lamps.sql"},
		Held: [2]store.Ledger{
			{"item stacks": {"timber": 40, "stone": 12}, "plants": {"wild-thyme": 1}},
			{"item stacks": {"timber": 40, "stone": 12}, "plants": {"wild-thyme": 1}, "crate entries": {"stone": 2, "timber": 1}},
		},
		Refunds: &store.Refunds038{
			GroundRows: 2, Malformed: 1, PaidTiles: map[string]int64{"stone": 2, "plank": 1}, Free: 1, Unauthored: 0, Gone: 1,
			Owed:     map[string]map[string]int64{"alice": {"stone": 2}, "bob": {"timber": 1}},
			Refunded: map[string]map[string]int64{"alice": {"stone": 2}, "bob": {"timber": 1}},
		},
		Problems: []string{"038: 1 of the wick's ground rows don't parse, so their paid tiles go unrefunded"},
	}
	printDryRun(&out, "copy.sqlite", run)
	for _, want := range []string{
		"quantities           before      after\nitem stacks              52         52\nplants                    1          1\ncrate entries             0          3\n",
		"038 path refunds: 2 ground rows, paid tiles plank 1, stone 2, 1 free changes\n",
		"  skipped: 1 malformed rows, 0 tiles with no author, 1 by an account that has gone\n",
		"  alice: owed stone 2, refunded stone 2\n  bob: owed timber 1, refunded timber 1\n  every refund matches its paid tiles\n",
		"PROBLEM 038: 1 of the wick's ground rows don't parse",
	} {
		if !strings.Contains(out.String(), want) {
			t.Fatalf("missing %q in:\n%s", want, out.String())
		}
	}
	if strings.Contains(out.String(), "quantities add up") {
		t.Fatal("a run with problems says it adds up")
	}
	run.Problems = nil
	out.Reset()
	printDryRun(&out, "copy.sqlite", run)
	if !strings.HasSuffix(out.String(), "quantities add up\n") {
		t.Fatal(out.String())
	}
}
