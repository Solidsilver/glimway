package api

// Pell's recovery crates (roadmap rule 3; lamps.md 2.7): what a lapsed camp
// packed waits at the deeds office for good, each entry its owner's. In
// Pell's office the owner takes what they pick, or everything, into their
// pack, free: pieces back among their carried home pieces, stacks (oil, path
// stone) into the pack, a plant as a carried plant, its planting kept (or as
// its seed, if they'd rather). What they leave waits on, with no end.
// Collecting marks each entry once, so a retried or repeated collect never
// gives twice.
//
// A lot's backland is the exception: its lapse sends pieces to the lot's own
// home storage (lot_lanterns.go), which is that land's recovery place.

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"slices"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

// recoveryCrate is the crate for what left a place at this moment: the
// one already made for it, or a new one.
func recoveryCrate(ctx context.Context, tx *sql.Tx, world, source string, cx, cy int, now int64) (string, error) {
	var id string
	err := tx.QueryRowContext(ctx, "SELECT id FROM recovery_crates WHERE world_id=? AND source=? AND lapsed_at=?", world, source, now).Scan(&id)
	if !errors.Is(err, sql.ErrNoRows) {
		return id, err
	}
	if id, err = store.Random(); err != nil {
		return "", err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO recovery_crates(id,world_id,source,cx,cy,lapsed_at) VALUES(?,?,?,?,?,?)", id, world, source, cx, cy, now)
	return id, err
}

// addRecoveryEntry puts one beneficiary's entry in a crate: a piece (its
// instance id), a stack or a plant (no instance), packed by a lapse.
func addRecoveryEntry(ctx context.Context, tx *sql.Tx, crate, account, kind, def string, qty int, instance any, state string) error {
	return addRecoveryEntryFor(ctx, tx, crate, account, kind, def, qty, instance, state, "")
}

// Recovery reasons (recovery_entries.reason, RecoveryEntry.reason): why an
// entry waits at Pell's. A lapse's is "".
const (
	reasonLandChanged = "land-changed"
	reasonDeedLost    = "deed-lost"
	reasonPackedUp    = "packed-up"
)

// addRecoveryEntryFor is addRecoveryEntry with its reason; a tool (an item
// instance) has its instance id too.
func addRecoveryEntryFor(ctx context.Context, tx *sql.Tx, crate, account, kind, def string, qty int, instance any, state, reason string) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO recovery_entries(crate_id,account_id,kind,item_def,qty,instance_id,state,reason) VALUES(?,?,?,?,?,?,?,?)", crate, account, kind, def, qty, instance, state, reason)
	return err
}

// recoveryEntry is an entry as the wire shows it, and the piece it holds.
type recoveryEntry struct {
	*contract.RecoveryEntry
	instance *string
	// maker: a stack's maker, kept with it (a lost deed's chest).
	maker string
	// plant, plantedAt: a plant's own id and when it was first planted,
	// kept in its state (packCamp, the lost deed's crate).
	plant     string
	plantedAt sql.NullInt64
}

// waiting are the caller's uncollected entries in this world, oldest first,
// each naming the keeper who moved it off their camp, if one did.
func waiting(ctx context.Context, tx *sql.Tx, world, account string) ([]recoveryEntry, error) {
	rows, err := tx.QueryContext(ctx, `SELECT e.id,e.kind,e.item_def,e.qty,c.cx,c.cy,c.lapsed_at,e.instance_id,e.reason,coalesce(json_extract(e.state,'$.maker'),''),json_extract(e.state,'$.movedBy'),COALESCE(k.display_name,''),
 coalesce(json_extract(e.state,'$.id'),''),json_extract(e.state,'$.plantedAt') FROM recovery_entries e JOIN recovery_crates c ON c.id=e.crate_id
 LEFT JOIN players k ON k.account_id=json_extract(e.state,'$.movedBy')
 WHERE c.world_id=? AND e.account_id=? AND e.collected_at IS NULL ORDER BY c.lapsed_at,e.id`, world, account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []recoveryEntry{}
	for rows.Next() {
		e := recoveryEntry{RecoveryEntry: &contract.RecoveryEntry{}}
		var at int64
		var mover sql.NullString
		var name string
		if err = rows.Scan(&e.Id, &e.Kind, &e.ItemDef, &e.Qty, &e.Cx, &e.Cy, &at, &e.instance, &e.Reason, &e.maker, &mover, &name, &e.plant, &e.plantedAt); err != nil {
			return nil, err
		}
		e.LapsedAt = float64(at)
		if mover.Valid {
			e.MovedBy = capDonor(name)
		}
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

// recoveryCollect is POST /api/recovery/collect: what the caller picked
// (req.Entries; none is everything waiting for them), into their pack, in
// Pell's office. A plant comes as a carried plant unless it's picked as its
// seed (req.AsSeed). The pack holds everything; what isn't picked waits on.
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
		// An entry asked for that isn't waiting (taken already, or not the
		// caller's) is skipped: a retry never gives twice.
		if len(req.Entries) > 0 {
			entries = slices.DeleteFunc(entries, func(e recoveryEntry) bool { return !slices.Contains(req.Entries, e.Id) })
		}
		got := []recoveryEntry{}
		for _, e := range entries {
			asPlant := e.Kind == "plant" && !slices.Contains(req.AsSeed, e.Id)
			if ok, err := collectEntry(ctx, tx, s.AccountID, e, asPlant, now); err != nil {
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

// carryPlant puts a plant into the pack as itself (carried_plants): from
// Pell's crate, or dug up with the trowel (digUpPlant). It keeps its own id
// (a new one if it has none, or the id is in use) and when it was first
// planted, its growth.
func carryPlant(ctx context.Context, tx *sql.Tx, account, id, def string, plantedAt, now int64) error {
	var used bool
	if id != "" {
		if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM carried_plants WHERE id=?) OR EXISTS(SELECT 1 FROM homestead_plants WHERE id=?) OR EXISTS(SELECT 1 FROM camp_plants WHERE id=?)", id, id, id).Scan(&used); err != nil {
			return err
		}
	}
	if id == "" || used {
		var err error
		if id, err = store.Random(); err != nil {
			return err
		}
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO carried_plants(id,account_id,item_def,planted_at,carried_at) VALUES(?,?,?,?,?)", id, account, def, plantedAt, now)
	return err
}

// collectEntry marks one entry collected and gives it, once: false when it
// was collected already. asPlant: a plant comes as itself (carryPlant), not
// its seed.
func collectEntry(ctx context.Context, tx *sql.Tx, account string, e recoveryEntry, asPlant bool, now int64) (bool, error) {
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
	if e.Kind == "tool" {
		// A tool or gear, its fittings still on it, into the pack.
		if e.instance == nil {
			return false, fail(409, "item-not-available")
		}
		if err := moveInstance(ctx, tx, *e.instance, e.ItemDef, instanceAt{"crate", account}, instanceAt{"pack", account}, now); err != nil {
			return false, err
		}
		if err := currency(ctx, tx, account, content.StackCurrency(e.ItemDef), 1, "recovery-collect", *e.instance, now); err != nil {
			return false, err
		}
		return true, fittedLedger(ctx, tx, account, *e.instance, 1, "recovery-collect", *e.instance, now)
	}
	if e.Kind == "plant" && asPlant {
		at := now
		if e.plantedAt.Valid {
			at = e.plantedAt.Int64
		}
		return true, carryPlant(ctx, tx, account, e.plant, e.ItemDef, at, now)
	}
	return true, packPut(ctx, tx, account, e.ItemDef, []makerQty{{Maker: e.maker, Qty: int(e.Qty)}}, "recovery-collect", ref, now)
}
