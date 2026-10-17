package api

// Pell's recovery crates (roadmap rule 3; lamps.md 2.7): what a lapsed camp
// packed waits at the deeds office for good, each entry its owner's. In
// Pell's office the owner takes everything into their pack, free: pieces back
// among their carried home pieces, stacks (oil, path stone, a plant's seed)
// into the pack. Collecting marks each entry once, so a retried or repeated
// collect never gives twice.
//
// A lot's backland is the exception: its lapse sends pieces to the lot's own
// home storage (lot_lanterns.go), which is that land's recovery place.

import (
	"context"
	"database/sql"
	"net/http"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

// recoveryEntry is an entry as the wire shows it, and the piece it holds.
type recoveryEntry struct {
	*contract.RecoveryEntry
	instance *string
}

// waiting are the caller's uncollected entries in this world, oldest first.
func waiting(ctx context.Context, tx *sql.Tx, world, account string) ([]recoveryEntry, error) {
	rows, err := tx.QueryContext(ctx, `SELECT e.id,e.kind,e.item_def,e.qty,c.cx,c.cy,c.lapsed_at,e.instance_id FROM recovery_entries e JOIN recovery_crates c ON c.id=e.crate_id
 WHERE c.world_id=? AND e.account_id=? AND e.collected_at IS NULL ORDER BY c.lapsed_at,e.id`, world, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []recoveryEntry{}
	for rows.Next() {
		e := recoveryEntry{RecoveryEntry: &contract.RecoveryEntry{}}
		var at int64
		if err = rows.Scan(&e.Id, &e.Kind, &e.ItemDef, &e.Qty, &e.Cx, &e.Cy, &at, &e.instance); err != nil {
			return nil, err
		}
		e.LapsedAt = float64(at)
		out = append(out, e)
	}
	return out, rows.Err()
}

func recoveryProto(entries []recoveryEntry) []*contract.RecoveryEntry {
	out := make([]*contract.RecoveryEntry, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.RecoveryEntry)
	}
	return out
}

// recoveryRead is GET /api/recovery: what waits for the caller at Pell's.
func (a *Server) recoveryRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	// A turning since the last read may have packed a camp.
	if err = a.turnWick(ctx, tx, s.WorldID, a.requestTime(ctx).Unix()); err != nil {
		return err
	}
	entries, err := waiting(ctx, tx, s.WorldID, s.AccountID)
	if err != nil {
		return err
	}
	return a.finishRead(w, r, tx, s, &contract.RecoveryRead{Entries: recoveryProto(entries)})
}

// inPellsOffice: the player stands in Pell's office (the deed table's room).
func inPellsOffice(s *store.Snapshot) bool {
	return s.State.Area == content.HomeRules.GetCommons().GetDeedTable().GetArea()
}

// recoveryCollect is POST /api/recovery/collect: everything waiting for the
// caller, into their pack, in Pell's office.
func (a *Server) recoveryCollect(w http.ResponseWriter, r *http.Request) error {
	req := &contract.RecoveryCollectRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if !inPellsOffice(s) {
			return nil, fail(409, "too-far-away")
		}
		if err := a.turnWick(ctx, tx, s.WorldID, now); err != nil {
			return nil, err
		}
		entries, err := waiting(ctx, tx, s.WorldID, s.AccountID)
		if err != nil {
			return nil, err
		}
		got := []recoveryEntry{}
		for _, e := range entries {
			if ok, err := collectEntry(ctx, tx, s.AccountID, e, now); err != nil {
				return nil, err
			} else if ok {
				got = append(got, e)
			}
		}
		if err = refreshItems(ctx, tx, s); err != nil {
			return nil, err
		}
		m, err := materialsProto(ctx, tx, s.AccountID)
		return &contract.RecoveryCollectResult{Collected: recoveryProto(got), Materials: m}, err
	})
}

// collectEntry marks one entry collected and gives it, once: false when it
// was collected already.
func collectEntry(ctx context.Context, tx *sql.Tx, account string, e recoveryEntry, now int64) (bool, error) {
	res, err := tx.ExecContext(ctx, "UPDATE recovery_entries SET collected_at=? WHERE id=? AND account_id=? AND collected_at IS NULL", now, e.Id, account)
	if err != nil {
		return false, err
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		return false, err
	}
	ref := "recovery:" + e.ItemDef
	if e.Kind == "piece" {
		if e.instance == nil {
			return false, fail(409, "item-not-available")
		}
		res, err := tx.ExecContext(ctx, "UPDATE homestead_items SET location='inventory' WHERE id=? AND account_id=? AND location='crate'", *e.instance, account)
		if err != nil {
			return false, err
		}
		if n, err := res.RowsAffected(); err != nil || n != 1 {
			if err == nil {
				err = fail(409, "item-not-available")
			}
			return false, err
		}
		return true, currency(ctx, tx, account, "decoration:"+e.ItemDef, 1, "recovery-collect", *e.instance, now)
	}
	return true, packPut(ctx, tx, account, e.ItemDef, []makerQty{{Qty: int(e.Qty)}}, "recovery-collect", ref, now)
}
