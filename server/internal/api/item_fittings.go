package api

import (
	"context"
	"database/sql"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

// repairTool mends an heirloom at the caller's bench (Workshop) or by a
// mender (standing near Silas or Orrin). Cheap tools can't be mended.
func repairTool(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.ItemsRequest, now int64, out *contract.ItemsResult) error {
	v, err := loadInstance(ctx, tx, req.Instance)
	if err != nil {
		return err
	}
	if v.Location != "pack" || v.Owner != s.AccountID {
		return fail(404, "item-not-found")
	}
	def, _ := content.ItemFor(v.Def)
	if def.Repair == nil {
		return fail(409, "cannot-mend")
	}
	if v.Condition >= v.Max {
		return fail(409, "not-needed")
	}
	cost, embers := def.Repair.Bench, 0
	if req.At == "bench" {
		if _, err = workshop(ctx, tx, s); err != nil {
			return err
		}
	} else {
		m, ok := content.MenderFor(req.At)
		if !ok {
			return fail(400, "invalid-mender")
		}
		if !nearTile(s, m.GetArea(), int(m.GetTx()), int(m.GetTy()), int(m.GetRadiusTiles())) {
			return fail(409, "too-far-away")
		}
		cost, embers = def.GetRepair().GetMender(), int(def.GetRepair().GetMenderEmbers())
	}
	if err = checkMaterials(ctx, tx, s.AccountID, cost); err != nil {
		return err
	}
	if embers > 0 {
		if err = debitEmbers(ctx, tx, s, embers, "mend", v.Def, now); err != nil {
			return err
		}
	}
	if err = debitMaterials(ctx, tx, s, cost, 1, "mend", v.ID, now); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE item_instances SET condition=max_condition WHERE id=?", v.ID); err != nil {
		return err
	}
	out.Mended = v.ID
	return currency(ctx, tx, s.AccountID, "mend:"+v.Def, 0, "mend", req.At, now)
}

// fitTool puts a fitting on a tool at the bench: from the pack, or moved
// straight from another tool (keeping its wear). One of each kind per tool,
// up to the tool's slots.
func fitTool(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.ItemsRequest, now int64) error {
	if _, err := workshop(ctx, tx, s); err != nil {
		return err
	}
	tool, err := loadInstance(ctx, tx, req.Tool)
	if err != nil {
		return err
	}
	if tool.Location != "pack" || tool.Owner != s.AccountID {
		return fail(404, "item-not-found")
	}
	f, err := loadInstance(ctx, tx, req.Instance)
	if err != nil {
		return err
	}
	tdef, _ := content.ItemFor(tool.Def)
	fdef, _ := content.ItemFor(f.Def)
	if fdef.Kind != "fitting" || tdef.Kind != "tool" {
		return fail(400, "invalid-item")
	}
	from := instanceAt{f.Location, f.Owner}
	switch {
	case f.Location == "pack" && f.Owner == s.AccountID:
	case f.Location == "fitted":
		other, err := loadInstance(ctx, tx, f.Owner)
		if err != nil || other.Location != "pack" || other.Owner != s.AccountID {
			return fail(404, "item-not-found")
		}
		if other.ID == tool.ID {
			return fail(409, "already-fitted")
		}
	default:
		return fail(404, "item-not-found")
	}
	fitted, err := fittingRows(ctx, tx, tool.ID)
	if err != nil {
		return err
	}
	if len(fitted) >= content.ItemSlotCount(tdef) {
		return fail(409, "no-free-slot")
	}
	if hasFitting(fitted, fdef.Fitting) {
		return fail(409, "fitting-kind-taken")
	}
	if fdef.Fitting == "remember" {
		exceptTool := ""
		if from.location == "fitted" {
			exceptTool = from.owner
		}
		has, err := hasWardenSetInPack(ctx, tx, s.AccountID, exceptTool)
		if err != nil {
			return err
		}
		if has {
			return fail(409, "two-wardens-grind")
		}
	}
	if err = moveInstance(ctx, tx, f.ID, f.Def, from, instanceAt{"fitted", tool.ID}, now); err != nil {
		return err
	}
	if from.location == "pack" {
		if err = currency(ctx, tx, s.AccountID, content.StackCurrency(f.Def), -1, "fit", tool.ID, now); err != nil {
			return err
		}
		return currency(ctx, tx, s.AccountID, "fitted:"+f.Def, 1, "fit", tool.ID, now)
	}
	return nil
}

// unfitTool takes a fitting off a tool (at the bench) into the pack.
func unfitTool(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.ItemsRequest, now int64) error {
	if _, err := workshop(ctx, tx, s); err != nil {
		return err
	}
	f, err := loadInstance(ctx, tx, req.Instance)
	if err != nil {
		return err
	}
	if f.Location != "fitted" {
		return fail(409, "not-fitted")
	}
	tool, err := loadInstance(ctx, tx, f.Owner)
	if err != nil || tool.Location != "pack" || tool.Owner != s.AccountID {
		return fail(404, "item-not-found")
	}
	if err = moveInstance(ctx, tx, f.ID, f.Def, instanceAt{"fitted", tool.ID}, instanceAt{"pack", s.AccountID}, now); err != nil {
		return err
	}
	if err = currency(ctx, tx, s.AccountID, "fitted:"+f.Def, -1, "unfit", tool.ID, now); err != nil {
		return err
	}
	return currency(ctx, tx, s.AccountID, content.StackCurrency(f.Def), 1, "unfit", tool.ID, now)
}
