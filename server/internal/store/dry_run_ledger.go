package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"maps"
	"net/url"
	"slices"
	"strings"
)

// What migrate --dry-run checks beyond row counts (step-back round 2, the
// release rehearsal in docs/releasing.md): every item's quantity before and
// after, and 038's path refunds reconciled against the 037 data they come
// from. Both read the databases read-only, as VerifyBackup does.

// Ledger is what a database holds by item: each source's quantity of each
// item_def (stacks and crate entries by their qty, plants one each).
type Ledger map[string]map[string]int64

// The sources a Ledger sums, in print order. Each query reads item_def and a
// quantity from the tables named; a table the schema lacks is left out.
var ledgerSources = []struct {
	name   string
	tables []string
	query  string // %s: the table
}{
	{"item stacks", []string{"item_stacks"}, "SELECT item_def, SUM(qty) FROM %s GROUP BY item_def"},
	{"plants", []string{"homestead_plants", "camp_plants", "carried_plants"}, "SELECT item_def, count(*) FROM %s GROUP BY item_def"},
	{"crate entries", []string{"recovery_entries"}, "SELECT item_def, SUM(qty) FROM %s GROUP BY item_def"},
}

// LedgerSources names the sources a Ledger sums, in print order.
func LedgerSources() []string {
	out := make([]string, len(ledgerSources))
	for i, s := range ledgerSources {
		out[i] = s.name
	}
	return out
}

// Total is a source's quantity over every item.
func (l Ledger) Total(source string) int64 {
	var n int64
	for _, q := range l[source] {
		n += q
	}
	return n
}

// Refunds038 reconciles 038's path refunds: what the 037 data owes (each
// paid tile of the wick's ground, to whoever laid it, at 0.11.2's cost) and
// the land-changed crate entries the upgrade wrote. Owed and Refunded are by
// account, then material.
type Refunds038 struct {
	GroundRows int              // the wick's ground rows 038 sets aside
	Malformed  int              // rows whose ground doesn't parse: the backfill skips them
	PaidTiles  map[string]int64 // laid tiles by kind (stone, plank)
	Free       int              // changes that cost nothing (clearing): no refund
	Unauthored int              // paid tiles with no author: skipped
	Gone       int              // paid tiles whose author has no account: skipped
	Owed       map[string]map[string]int64
	Refunded   map[string]map[string]int64
	// Where owed and refunded differ, by world, chunk, account and material.
	Mismatches []string
}

// readOnly opens a database file immutable and read-only, as VerifyBackup does.
func readOnly(path string) (*sql.DB, error) {
	dsn := (&url.URL{Scheme: "file", Path: path, RawQuery: "mode=ro&immutable=1"}).String()
	db, err := sql.Open("sqlite", dsn+"&_pragma=query_only(1)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	return db, nil
}

func hasTable(ctx context.Context, db *sql.DB, name string) (bool, error) {
	var n int
	err := db.QueryRowContext(ctx, "SELECT count(*) FROM sqlite_schema WHERE type='table' AND name=?", name).Scan(&n)
	return n > 0, err
}

// readLedger sums a database's holdings by item.
func readLedger(ctx context.Context, db *sql.DB) (Ledger, error) {
	out := Ledger{}
	for _, src := range ledgerSources {
		items := map[string]int64{}
		for _, table := range src.tables {
			if ok, err := hasTable(ctx, db, table); err != nil {
				return nil, err
			} else if !ok {
				continue
			}
			rows, err := db.QueryContext(ctx, fmt.Sprintf(src.query, table))
			if err != nil {
				return nil, fmt.Errorf("%s: %w", table, err)
			}
			for rows.Next() {
				var def string
				var n int64
				if err = rows.Scan(&def, &n); err != nil {
					rows.Close()
					return nil, err
				}
				items[def] += n
			}
			err = rows.Err()
			rows.Close()
			if err != nil {
				return nil, err
			}
		}
		out[src.name] = items
	}
	return out, nil
}

// owed038 reads what 038's backfill should refund from a database before it:
// the wick's ground rows (the ones 038 sets aside), each paid tile owed to
// its author at lay038's cost, and what the backfill skips. Keyed by world,
// chunk, account and material.
func owed038(ctx context.Context, db *sql.DB, r *Refunds038) (map[[4]string]int64, error) {
	owed := map[[4]string]int64{}
	r.PaidTiles = map[string]int64{}
	if ok, err := hasTable(ctx, db, "wild_epochs"); err != nil || !ok {
		return owed, err
	}
	rows, err := db.QueryContext(ctx, `SELECT world_id, chunk, state FROM world_changes
 WHERE kind='ground' AND layer=0 AND epoch IN (SELECT id FROM wild_epochs WHERE kind='wick')`)
	if err != nil {
		return nil, err
	}
	type tile struct{ world, chunk, by, kind string }
	var paid []tile
	for rows.Next() {
		var world, chunk, state string
		if err = rows.Scan(&world, &chunk, &state); err != nil {
			rows.Close()
			return nil, err
		}
		r.GroundRows++
		var g struct {
			Changes []struct {
				Change string `json:"change"`
				By     string `json:"by"`
			} `json:"changes"`
		}
		if json.Unmarshal([]byte(state), &g) != nil {
			r.Malformed++
			continue
		}
		for _, c := range g.Changes {
			if _, ok := lay038[c.Change]; !ok {
				r.Free++
				continue
			}
			r.PaidTiles[c.Change]++
			if c.By == "" {
				r.Unauthored++
				continue
			}
			paid = append(paid, tile{world, chunk, c.By, c.Change})
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	known := map[string]bool{}
	for _, t := range paid {
		is, seen := known[t.by]
		if !seen {
			if err = db.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM players WHERE account_id=?)", t.by).Scan(&is); err != nil {
				return nil, err
			}
			known[t.by] = is
		}
		if !is {
			r.Gone++
			continue
		}
		lay := lay038[t.kind]
		owed[[4]string{t.world, t.chunk, t.by, lay.material}] += int64(lay.cost)
	}
	return owed, nil
}

// refunded038 reads the land-changed crate entries a database holds, keyed
// as owed038's, leaving out crates that were already there before (`old`).
func refunded038(ctx context.Context, db *sql.DB, old map[string]bool) (map[[4]string]int64, error) {
	got := map[[4]string]int64{}
	if ok, err := hasTable(ctx, db, "recovery_entries"); err != nil || !ok {
		return got, err
	}
	rows, err := db.QueryContext(ctx, `SELECT c.id, c.world_id, c.source, e.account_id, e.item_def, e.qty
 FROM recovery_entries e JOIN recovery_crates c ON c.id=e.crate_id
 WHERE e.reason='land-changed' AND e.kind='stack' AND c.source LIKE 'land-changed:%'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var crate, world, source, account, def string
		var qty int64
		if err = rows.Scan(&crate, &world, &source, &account, &def, &qty); err != nil {
			return nil, err
		}
		if !old[crate] {
			got[[4]string{world, strings.TrimPrefix(source, "land-changed:"), account, def}] += qty
		}
	}
	return got, rows.Err()
}

// crateIDs lists the crates a database holds (none before 038).
func crateIDs(ctx context.Context, db *sql.DB) (map[string]bool, error) {
	ids := map[string]bool{}
	if ok, err := hasTable(ctx, db, "recovery_crates"); err != nil || !ok {
		return ids, err
	}
	rows, err := db.QueryContext(ctx, "SELECT id FROM recovery_crates")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return nil, err
		}
		ids[id] = true
	}
	return ids, rows.Err()
}

// byAccount folds keyed quantities into account → material.
func byAccount(keyed map[[4]string]int64) map[string]map[string]int64 {
	out := map[string]map[string]int64{}
	for k, n := range keyed {
		if out[k[2]] == nil {
			out[k[2]] = map[string]int64{}
		}
		out[k[2]][k[3]] += n
	}
	return out
}

// reconcile038 compares what the 037 database owes with what the upgraded
// one refunded.
func reconcile038(ctx context.Context, before, after *sql.DB) (*Refunds038, error) {
	r := &Refunds038{}
	owed, err := owed038(ctx, before, r)
	if err != nil {
		return nil, fmt.Errorf("owed: %w", err)
	}
	old, err := crateIDs(ctx, before)
	if err != nil {
		return nil, err
	}
	got, err := refunded038(ctx, after, old)
	if err != nil {
		return nil, fmt.Errorf("refunded: %w", err)
	}
	r.Owed, r.Refunded = byAccount(owed), byAccount(got)
	keys := map[[4]string]bool{}
	for k := range owed {
		keys[k] = true
	}
	for k := range got {
		keys[k] = true
	}
	for k := range keys {
		if owed[k] != got[k] {
			r.Mismatches = append(r.Mismatches, fmt.Sprintf("world %s chunk %s: %s %s owed %d, refunded %d", k[0], k[1], k[2], k[3], owed[k], got[k]))
		}
	}
	slices.Sort(r.Mismatches)
	return r, nil
}

// quantityProblems says where the ledgers disagree in a way the upgrade
// doesn't explain: stacks and plants keep every quantity, and crate entries
// grow by exactly the refunds (none when 038 isn't applied).
func quantityProblems(before, after Ledger, refunds *Refunds038) []string {
	var out []string
	for _, src := range LedgerSources() {
		explained := map[string]int64{}
		if src == "crate entries" && refunds != nil {
			for _, materials := range refunds.Refunded {
				for def, n := range materials {
					explained[def] += n
				}
			}
		}
		defs := map[string]bool{}
		for def := range before[src] {
			defs[def] = true
		}
		for def := range after[src] {
			defs[def] = true
		}
		for _, def := range slices.Sorted(maps.Keys(defs)) {
			if b, a := before[src][def], after[src][def]; a != b+explained[def] {
				out = append(out, fmt.Sprintf("%s: %s %d -> %d", src, def, b, a))
			}
		}
	}
	return out
}
