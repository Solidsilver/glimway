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

// holder is where a decoration instance sits: a player's pack ('inventory'),
// personal chest or parcel (player set), or a homestead's shared chest or
// grounds (home set).
type holder struct{ location, player, home string }

func pack(id string) holder { return holder{"inventory", id, ""} }

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func decorationIDs(ctx context.Context, tx *sql.Tx, from holder, def string, n int) ([]string, error) {
	rows, err := tx.QueryContext(ctx, "SELECT id FROM homestead_items WHERE location=? AND habitica_id IS ? AND homestead_id IS ? AND item_def=? AND scene IS NULL ORDER BY id LIMIT ?", from.location, nullable(from.player), nullable(from.home), def, n)
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
func moveDecorations(ctx context.Context, tx *sql.Tx, ids []string, from, to holder) error {
	for _, id := range ids {
		res, err := tx.ExecContext(ctx, "UPDATE homestead_items SET location=?,habitica_id=?,homestead_id=? WHERE id=? AND location=? AND habitica_id IS ? AND homestead_id IS ? AND scene IS NULL", to.location, nullable(to.player), nullable(to.home), id, from.location, nullable(from.player), nullable(from.home))
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

// takeAsset takes goods out of the caller's pack; decorations go to `to`.
func takeAsset(ctx context.Context, tx *sql.Tx, s *store.Snapshot, v content.Asset, to holder, reason, ref string, now int64) ([]string, error) {
	if err := validAsset(v); err != nil {
		return nil, err
	}
	switch v.Kind {
	case "material":
		return []string{}, materialChange(ctx, tx, s.HabiticaID, v.ID, -v.Qty, reason, ref, now)
	case "item":
		return []string{}, itemChange(ctx, tx, s, v.ID, -v.Qty, reason, ref, now)
	default:
		ids, err := decorationIDs(ctx, tx, pack(s.HabiticaID), v.ID, v.Qty)
		if err != nil {
			return nil, err
		}
		if err = moveDecorations(ctx, tx, ids, pack(s.HabiticaID), to); err != nil {
			return nil, err
		}
		return ids, currency(ctx, tx, s.HabiticaID, "decoration:"+v.ID, -v.Qty, reason, ref, now)
	}
}

// giveAsset puts goods into the caller's pack; decorations come from `from`.
func giveAsset(ctx context.Context, tx *sql.Tx, s *store.Snapshot, v content.Asset, ids []string, from holder, reason, ref string, now int64) error {
	switch v.Kind {
	case "material":
		return materialChange(ctx, tx, s.HabiticaID, v.ID, v.Qty, reason, ref, now)
	case "item":
		return itemChange(ctx, tx, s, v.ID, v.Qty, reason, ref, now)
	case "decoration":
		if len(ids) != v.Qty {
			return fail(409, "item-not-available")
		}
		if err := moveDecorations(ctx, tx, ids, from, pack(s.HabiticaID)); err != nil {
			return err
		}
		return currency(ctx, tx, s.HabiticaID, "decoration:"+v.ID, v.Qty, reason, ref, now)
	}
	return fail(400, "invalid-asset")
}

// packCounts is what a player carries: materials, adventure items, decorations.
func packCounts(ctx context.Context, tx *sql.Tx, id string) (assetCounts, error) {
	v := assetCounts{Materials: map[string]int{}, Items: map[string]int{}, Decorations: map[string]int{}}
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
	return v, decorationCounts(ctx, tx, pack(id), v.Decorations)
}

// chestCounts is a chest's contents: the shared home chest (home id) or a
// player's personal chest.
func chestCounts(ctx context.Context, tx *sql.Tx, chest holder) (assetCounts, error) {
	v := assetCounts{Materials: map[string]int{}, Items: map[string]int{}, Decorations: map[string]int{}}
	table, key, owner := "home_storage", "homestead_id", chest.home
	if chest.location == "personal" {
		table, key, owner = "personal_storage", "habitica_id", chest.player
	}
	rows, err := tx.QueryContext(ctx, "SELECT kind,item_def,qty FROM "+table+" WHERE "+key+"=? ORDER BY kind,item_def", owner)
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
	return v, decorationCounts(ctx, tx, chest, v.Decorations)
}
func decorationCounts(ctx context.Context, tx *sql.Tx, at holder, out map[string]int) error {
	rows, err := tx.QueryContext(ctx, "SELECT item_def,count(*) FROM homestead_items WHERE location=? AND habitica_id IS ? AND homestead_id IS ? GROUP BY item_def ORDER BY item_def", at.location, nullable(at.player), nullable(at.home))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var def string
		var n int
		if err = rows.Scan(&def, &n); err != nil {
			return err
		}
		out[def] = n
	}
	return rows.Err()
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

// workshop is the caller's homestead when it has a workshop (tier 2+):
// the chests and the bench live there.
func workshop(ctx context.Context, tx *sql.Tx, s *store.Snapshot) (string, error) {
	home, ok, err := memberOf(ctx, tx, s.HabiticaID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fail(409, "not-a-member")
	}
	var tier int
	if err = tx.QueryRowContext(ctx, "SELECT tier FROM homesteads WHERE id=?", home).Scan(&tier); err != nil {
		return "", err
	}
	if tier < 2 {
		return "", fail(409, "tier-required")
	}
	return home, nil
}
