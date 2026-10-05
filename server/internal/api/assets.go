package api

import (
	"context"
	"database/sql"
	"fingersnap/content"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
	"slices"
)

type assetCounts struct {
	Materials   map[string]int `json:"materials"`
	Items       map[string]int `json:"items"`
	Decorations map[string]int `json:"decorations"`
}

func validAsset(v content.Asset) error {
	if v.Qty < 1 || v.Qty > 10000 {
		return fail(400, "invalid-quantity")
	}
	known := false
	switch v.Kind {
	case "material":
		known = slices.Contains(content.WildsRules.Materials, v.ID)
	case "item":
		known = content.KnownAdventureItem(v.ID)
	case "decoration":
		_, known = content.HomeItemFor(v.ID)
	}
	if !known {
		return fail(400, "invalid-asset")
	}
	return nil
}
func itemChange(ctx context.Context, tx *sql.Tx, s *store.Snapshot, id string, delta int, reason, ref string, now int64) error {
	var n int
	err := tx.QueryRowContext(ctx, "SELECT qty FROM inventory WHERE habitica_id=? AND item_def=?", s.HabiticaID, id).Scan(&n)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if n+delta < 0 {
		return fail(409, "insufficient-items")
	}
	if n+delta == 0 {
		_, err = tx.ExecContext(ctx, "DELETE FROM inventory WHERE habitica_id=? AND item_def=?", s.HabiticaID, id)
	} else {
		_, err = tx.ExecContext(ctx, "INSERT INTO inventory VALUES(?,?,?) ON CONFLICT(habitica_id,item_def) DO UPDATE SET qty=excluded.qty", s.HabiticaID, id, n+delta)
	}
	if err != nil {
		return err
	}
	if err = currency(ctx, tx, s.HabiticaID, "item:"+id, delta, reason, ref, now); err != nil {
		return err
	}
	return refreshItems(ctx, tx, s)
}
func refreshItems(ctx context.Context, tx *sql.Tx, s *store.Snapshot) error {
	out := []string{}
	for _, id := range s.State.Inventory {
		if slices.Contains(rules.QuestItems, id) {
			out = rules.AddUnique(out, id)
		}
	}
	rows, err := tx.QueryContext(ctx, "SELECT item_def FROM inventory WHERE habitica_id=? ORDER BY item_def", s.HabiticaID)
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			return err
		}
		out = rules.AddUnique(out, id)
	}
	if err = rows.Err(); err != nil {
		return err
	}
	s.State.Inventory = out
	return nil
}
func decorationIDs(ctx context.Context, tx *sql.Tx, id, def, location string, n int) ([]string, error) {
	rows, err := tx.QueryContext(ctx, "SELECT id FROM homestead_items WHERE habitica_id=? AND item_def=? AND location=? AND scene IS NULL ORDER BY id LIMIT ?", id, def, location, n)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var v string
		if err = rows.Scan(&v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	if err = rows.Err(); err != nil {
		return nil, err
	}
	if len(out) != n {
		return nil, fail(409, "insufficient-items")
	}
	return out, nil
}
func moveDecorations(ctx context.Context, tx *sql.Tx, ids []string, fromOwner, toOwner, from, to string) error {
	for _, id := range ids {
		res, err := tx.ExecContext(ctx, "UPDATE homestead_items SET habitica_id=?,location=? WHERE id=? AND habitica_id=? AND location=? AND scene IS NULL", toOwner, to, id, fromOwner, from)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			return fail(409, "item-not-available")
		}
	}
	return nil
}
func takeAsset(ctx context.Context, tx *sql.Tx, s *store.Snapshot, v content.Asset, destination, reason, ref string, now int64) ([]string, error) {
	if err := validAsset(v); err != nil {
		return nil, err
	}
	switch v.Kind {
	case "material":
		return []string{}, materialChange(ctx, tx, s.HabiticaID, v.ID, -v.Qty, reason, ref, now)
	case "item":
		return []string{}, itemChange(ctx, tx, s, v.ID, -v.Qty, reason, ref, now)
	default:
		ids, err := decorationIDs(ctx, tx, s.HabiticaID, v.ID, "inventory", v.Qty)
		if err != nil {
			return nil, err
		}
		if err = moveDecorations(ctx, tx, ids, s.HabiticaID, s.HabiticaID, "inventory", destination); err != nil {
			return nil, err
		}
		return ids, currency(ctx, tx, s.HabiticaID, "decoration:"+v.ID, -v.Qty, reason, ref, now)
	}
}
func giveAsset(ctx context.Context, tx *sql.Tx, s *store.Snapshot, v content.Asset, ids []string, fromOwner, source, reason, ref string, now int64) error {
	switch v.Kind {
	case "material":
		return materialChange(ctx, tx, s.HabiticaID, v.ID, v.Qty, reason, ref, now)
	case "item":
		return itemChange(ctx, tx, s, v.ID, v.Qty, reason, ref, now)
	case "decoration":
		if len(ids) != v.Qty {
			return fail(409, "item-not-available")
		}
		if _, err := ensureHome(ctx, tx, s, now); err != nil {
			return err
		}
		if err := moveDecorations(ctx, tx, ids, fromOwner, s.HabiticaID, source, "inventory"); err != nil {
			return err
		}
		return currency(ctx, tx, s.HabiticaID, "decoration:"+v.ID, v.Qty, reason, ref, now)
	}
	return fail(400, "invalid-asset")
}
func counts(ctx context.Context, tx *sql.Tx, id string, storage bool) (assetCounts, error) {
	v := assetCounts{Materials: map[string]int{}, Items: map[string]int{}, Decorations: map[string]int{}}
	location := "inventory"
	if !storage {
		var err error
		v.Materials, err = materials(ctx, tx, id)
		if err != nil {
			return v, err
		}
		rows, err := tx.QueryContext(ctx, "SELECT item_def,qty FROM inventory WHERE habitica_id=? ORDER BY item_def", id)
		if err != nil {
			return v, err
		}
		for rows.Next() {
			var def string
			var n int
			if err = rows.Scan(&def, &n); err != nil {
				rows.Close()
				return v, err
			}
			if content.KnownAdventureItem(def) {
				v.Items[def] = n
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return v, err
		}
	} else {
		location = "storage"
		rows, err := tx.QueryContext(ctx, "SELECT kind,item_def,qty FROM home_storage WHERE habitica_id=? ORDER BY kind,item_def", id)
		if err != nil {
			return v, err
		}
		for rows.Next() {
			var kind, def string
			var n int
			if err = rows.Scan(&kind, &def, &n); err != nil {
				rows.Close()
				return v, err
			}
			if kind == "material" {
				v.Materials[def] = n
			} else {
				v.Items[def] = n
			}
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return v, err
		}
	}
	rows, err := tx.QueryContext(ctx, "SELECT item_def,count(*) FROM homestead_items WHERE habitica_id=? AND location=? GROUP BY item_def ORDER BY item_def", id, location)
	if err != nil {
		return v, err
	}
	defer rows.Close()
	for rows.Next() {
		var def string
		var n int
		if err = rows.Scan(&def, &n); err != nil {
			return v, err
		}
		v.Decorations[def] = n
	}
	return v, rows.Err()
}
func debitMaterials(ctx context.Context, tx *sql.Tx, s *store.Snapshot, costs map[string]int, qty int, reason, ref string, now int64) error {
	for _, id := range content.WildsRules.Materials {
		if n := costs[id] * qty; n > 0 {
			if err := materialChange(ctx, tx, s.HabiticaID, id, -n, reason, ref, now); err != nil {
				return err
			}
		}
	}
	return nil
}
func workshop(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) error {
	if _, err := ensureHome(ctx, tx, s, now); err != nil {
		return err
	}
	var tier int
	if err := tx.QueryRowContext(ctx, "SELECT tier FROM homesteads WHERE habitica_id=?", s.HabiticaID).Scan(&tier); err != nil {
		return err
	}
	if tier < 2 {
		return fail(409, "tier-required")
	}
	return nil
}
