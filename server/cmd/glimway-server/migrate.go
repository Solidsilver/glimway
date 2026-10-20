package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"glimway/server/internal/store"
	"io"
	"maps"
	"os"
	"path/filepath"
	"slices"
	"strings"
)

const migrateUsage = "usage: migrate --dry-run COPY.sqlite"

// migrateDryRun rehearses an upgrade of a copy of a database (a backup):
// verify-backup's checks, this binary's pending migrations applied to a
// private snapshot of it, the checks again, the key counts and every item's
// quantity before and after, and 038's path refunds against the paid tiles
// they come from. It fails when a quantity or refund doesn't add up. Starting
// the server migrates -db for real; this never writes a file it is given
// (store.DryRunMigrate).
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
	if len(run.Problems) > 0 {
		return fmt.Errorf("migrate --dry-run %s: %d problems (listed above)", copyPath, len(run.Problems))
	}
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
	if run.Held[0] != nil {
		fmt.Fprintf(w, "%-16s %10s %10s\n", "quantities", "before", "after")
		for _, src := range store.LedgerSources() {
			fmt.Fprintf(w, "%-16s %10d %10d\n", src, run.Held[0].Total(src), run.Held[1].Total(src))
		}
	}
	if r := run.Refunds; r != nil {
		fmt.Fprintf(w, "038 path refunds: %d ground rows, paid tiles %s, %d free changes\n", r.GroundRows, amounts(r.PaidTiles), r.Free)
		fmt.Fprintf(w, "  skipped: %d malformed rows, %d tiles with no author, %d by an account that has gone\n", r.Malformed, r.Unauthored, r.Gone)
		accounts := map[string]bool{}
		for a := range r.Owed {
			accounts[a] = true
		}
		for a := range r.Refunded {
			accounts[a] = true
		}
		for _, a := range slices.Sorted(maps.Keys(accounts)) {
			fmt.Fprintf(w, "  %s: owed %s, refunded %s\n", a, amounts(r.Owed[a]), amounts(r.Refunded[a]))
		}
		if len(r.Mismatches) == 0 {
			fmt.Fprintln(w, "  every refund matches its paid tiles")
		}
	}
	if len(run.Problems) == 0 {
		fmt.Fprintln(w, "quantities add up")
	}
	for _, p := range run.Problems {
		fmt.Fprintf(w, "PROBLEM %s\n", p)
	}
}

// amounts renders quantities by name, sorted: "stone 2, timber 1" ("none").
func amounts(m map[string]int64) string {
	var parts []string
	for _, k := range slices.Sorted(maps.Keys(m)) {
		parts = append(parts, fmt.Sprintf("%s %d", k, m[k]))
	}
	if len(parts) == 0 {
		return "none"
	}
	return strings.Join(parts, ", ")
}
