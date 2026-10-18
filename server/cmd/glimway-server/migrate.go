package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"glimway/server/internal/store"
	"io"
	"os"
	"path/filepath"
)

const migrateUsage = "usage: migrate --dry-run COPY.sqlite"

// migrateDryRun rehearses an upgrade of a copy of a database (a backup):
// verify-backup's checks, this binary's pending migrations applied to a
// private snapshot of it, the checks again, and the key counts before and
// after. Starting the server migrates -db for real; this never writes a file
// it is given (store.DryRunMigrate).
func migrateDryRun(ctx context.Context, args []string, db string) error {
	f := flag.NewFlagSet("migrate", flag.ContinueOnError)
	f.SetOutput(io.Discard)
	dryRun := f.Bool("dry-run", false, "Migrate a copy and report it")
	if err := f.Parse(args); err != nil || !*dryRun || f.NArg() != 1 {
		return errors.New(migrateUsage)
	}
	copyPath := f.Arg(0)
	if same(copyPath, db) {
		return fmt.Errorf("migrate --dry-run: %s is this server's -db; rehearse on a copy", copyPath)
	}
	run, err := store.DryRunMigrate(ctx, copyPath)
	if err != nil {
		return fmt.Errorf("migrate --dry-run %s: %w", copyPath, err)
	}
	printDryRun(os.Stdout, copyPath, run)
	return nil
}

// same reports whether two paths name one file (or would, once created).
func same(a, b string) bool {
	if ai, err := os.Stat(a); err == nil {
		if bi, err := os.Stat(b); err == nil {
			return os.SameFile(ai, bi)
		}
	}
	aa, err1 := filepath.Abs(a)
	ba, err2 := filepath.Abs(b)
	return err1 == nil && err2 == nil && aa == ba
}

// The labels of the counted tables, in store's print order.
var dryRunLabels = map[string]string{
	"players": "accounts", "worlds": "worlds", "homesteads": "homes",
	"item_stacks": "item stacks", "item_instances": "tools and gear", "homestead_items": "home pieces",
	"homestead_plants": "home plants", "camp_plants": "camp plants", "carried_plants": "carried plants",
	"holds": "holds", "lot_lanterns": "lot lanterns", "camps": "camps", "communal_lamps": "communal lamps",
	"recovery_crates": "Pell's crates", "recovery_entries": "crate entries",
}

func printDryRun(w io.Writer, path string, run store.DryRun) {
	fmt.Fprintf(w, "ok %s\nschema %s -> %s\n", path, run.Before.Schema, run.After.Schema)
	if len(run.Applied) == 0 {
		fmt.Fprintln(w, "applied nothing: already current")
	} else {
		fmt.Fprintf(w, "applied %d in %s:", len(run.Applied), run.Took.Round(1e6))
		for _, name := range run.Applied {
			fmt.Fprintf(w, " %s", name)
		}
		fmt.Fprintln(w)
	}
	fmt.Fprintf(w, "%-16s %10s %10s\n", "", "before", "after")
	count := func(counts map[string]int64, table string) string {
		if n, ok := counts[table]; ok {
			return fmt.Sprint(n)
		}
		return "-"
	}
	for _, table := range store.BackupCountTables() {
		fmt.Fprintf(w, "%-16s %10s %10s\n", dryRunLabels[table], count(run.Before.Counts, table), count(run.After.Counts, table))
	}
}
