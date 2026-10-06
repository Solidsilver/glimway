package api

import (
	"context"
	"database/sql"
	"fingersnap/content"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
	"slices"
	"strings"
)

// Carried goods (docs/items/overview.md): stacks by count, kept per maker,
// in item_stacks; instances one by one in item_instances; home goods as
// homestead_items. Every change to a player's pack writes its ledger row
// (content.StackCurrency for stacks and instances, "decoration:" for home
// goods) in the same transaction.

type assetCounts struct {
	Materials   map[string]int `json:"materials"`
	Items       map[string]int `json:"items"`
	Decorations map[string]int `json:"decorations"`
	// Instances: tools, off-hand items, carry gear and loose fittings.
	Instances []instanceView `json:"instances"`
}

func emptyCounts() assetCounts {
	return assetCounts{Materials: map[string]int{}, Items: map[string]int{}, Decorations: map[string]int{}, Instances: []instanceView{}}
}

func validAsset(v content.Asset) error {
	if v.Qty < 1 || v.Qty > 10000 {
		return fail(400, "invalid-quantity")
	}
	if v.Maker != nil && len(*v.Maker) > 128 {
		return fail(400, "invalid-asset")
	}
	known := false
	switch v.Kind {
	case "material", "item", "instance":
		d, ok := content.ItemFor(v.ID)
		known = ok && d.AssetKind() == v.Kind
		if v.Kind == "instance" && (v.Qty != 1 || v.Instance == "" || len(v.Instance) > 128) {
			return fail(400, "invalid-asset")
		}
	case "decoration":
		_, known = content.HomeItemFor(v.ID)
	}
	if !known {
		return fail(400, "invalid-asset")
	}
	if v.Kind != "instance" && v.Instance != "" || (v.Kind == "decoration" || v.Kind == "instance") && v.Maker != nil {
		return fail(400, "invalid-asset")
	}
	return nil
}

// ------------------------------------------------------------ stacks

// stackAt is where a stack lies: a player's pack or personal chest
// (owner: the player) or a homestead's shared chest (owner: the home).
type stackAt struct{ location, owner string }

func packOf(id string) stackAt { return stackAt{"pack", id} }

// makerQty is one maker's share of a moved stack (” is unmarked).
type makerQty struct {
	Maker string `json:"maker"`
	Qty   int    `json:"qty"`
}

func splitTotal(split []makerQty) int {
	n := 0
	for _, m := range split {
		n += m.Qty
	}
	return n
}

func shortfall(def string) error {
	if d, ok := content.ItemFor(def); ok && d.Kind == "material" {
		return fail(409, "insufficient-materials")
	}
	return fail(409, "insufficient-items")
}

// stackTotal counts a definition at a place, every maker together.
func stackTotal(ctx context.Context, tx *sql.Tx, at stackAt, def string) (int, error) {
	var n int
	err := tx.QueryRowContext(ctx, "SELECT COALESCE(SUM(qty),0) FROM item_stacks WHERE location=? AND owner=? AND item_def=?", at.location, at.owner, def).Scan(&n)
	return n, err
}

// takeStack removes qty from one maker's stack (maker set; ” = unmarked),
// or across makers, unmarked first and then by maker id. Nothing changes on
// a shortfall. Returns what was taken, per maker.
func takeStack(ctx context.Context, tx *sql.Tx, at stackAt, def string, maker *string, qty int) ([]makerQty, error) {
	q := "SELECT maker_id,qty FROM item_stacks WHERE location=? AND owner=? AND item_def=?"
	args := []any{at.location, at.owner, def}
	if maker != nil {
		q += " AND maker_id=?"
		args = append(args, *maker)
	}
	rows, err := tx.QueryContext(ctx, q+" ORDER BY maker_id", args...)
	if err != nil {
		return nil, err
	}
	have := []makerQty{}
	for rows.Next() {
		var v makerQty
		if err = rows.Scan(&v.Maker, &v.Qty); err != nil {
			rows.Close()
			return nil, err
		}
		have = append(have, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	if splitTotal(have) < qty {
		return nil, shortfall(def)
	}
	out := []makerQty{}
	left := qty
	for _, h := range have {
		if left == 0 {
			break
		}
		n := min(left, h.Qty)
		if n == h.Qty {
			_, err = tx.ExecContext(ctx, "DELETE FROM item_stacks WHERE location=? AND owner=? AND item_def=? AND maker_id=?", at.location, at.owner, def, h.Maker)
		} else {
			_, err = tx.ExecContext(ctx, "UPDATE item_stacks SET qty=qty-? WHERE location=? AND owner=? AND item_def=? AND maker_id=?", n, at.location, at.owner, def, h.Maker)
		}
		if err != nil {
			return nil, err
		}
		out = append(out, makerQty{h.Maker, n})
		left -= n
	}
	return out, nil
}
func putStack(ctx context.Context, tx *sql.Tx, at stackAt, def string, split []makerQty) error {
	for _, m := range split {
		if m.Qty <= 0 {
			continue
		}
		if _, err := tx.ExecContext(ctx, "INSERT INTO item_stacks(location,owner,item_def,maker_id,qty) VALUES(?,?,?,?,?) ON CONFLICT(location,owner,item_def,maker_id) DO UPDATE SET qty=qty+excluded.qty", at.location, at.owner, def, m.Maker, m.Qty); err != nil {
			return err
		}
	}
	return nil
}

// packTake takes stacks from a player's pack with the ledger row; a
// keepsake no longer carried leaves its pocket.
func packTake(ctx context.Context, tx *sql.Tx, id, def string, maker *string, qty int, reason, ref string, now int64) ([]makerQty, error) {
	split, err := takeStack(ctx, tx, packOf(id), def, maker, qty)
	if err != nil {
		return nil, err
	}
	if left, err := stackTotal(ctx, tx, packOf(id), def); err != nil {
		return nil, err
	} else if left == 0 {
		if _, err = tx.ExecContext(ctx, "DELETE FROM item_slots WHERE habitica_id=? AND item_def=? AND instance_id IS NULL", id, def); err != nil {
			return nil, err
		}
	}
	return split, currency(ctx, tx, id, content.StackCurrency(def), -qty, reason, ref, now)
}
func packPut(ctx context.Context, tx *sql.Tx, id, def string, split []makerQty, reason, ref string, now int64) error {
	if err := putStack(ctx, tx, packOf(id), def, split); err != nil {
		return err
	}
	return currency(ctx, tx, id, content.StackCurrency(def), splitTotal(split), reason, ref, now)
}

// materialChange adds unmarked goods, or takes any maker's, from a pack.
func materialChange(ctx context.Context, tx *sql.Tx, id, material string, delta int, reason, ref string, now int64) error {
	if delta < 0 {
		_, err := packTake(ctx, tx, id, material, nil, -delta, reason, ref, now)
		return err
	}
	return packPut(ctx, tx, id, material, []makerQty{{"", delta}}, reason, ref, now)
}

// itemChange is materialChange for the snapshot's own pack, keeping its
// carried-item list (GameState.inventory) current.
func itemChange(ctx context.Context, tx *sql.Tx, s *store.Snapshot, id string, delta int, reason, ref string, now int64) error {
	if err := materialChange(ctx, tx, s.HabiticaID, id, delta, reason, ref, now); err != nil {
		return err
	}
	return refreshItems(ctx, tx, s)
}
func materials(ctx context.Context, tx *sql.Tx, id string) (map[string]int, error) {
	out := map[string]int{}
	for _, m := range content.WildsRules.Materials {
		out[m] = 0
	}
	c, err := stackCounts(ctx, tx, packOf(id))
	for k, n := range c.Materials {
		out[k] = n
	}
	return out, err
}
func refreshItems(ctx context.Context, tx *sql.Tx, s *store.Snapshot) error {
	out := []string{}
	for _, id := range s.State.Inventory {
		if slices.Contains(rules.QuestItems, id) {
			out = rules.AddUnique(out, id)
		}
	}
	items, err := store.PackItems(ctx, tx, s.HabiticaID)
	if err != nil {
		return err
	}
	for _, id := range items {
		out = rules.AddUnique(out, id)
	}
	s.State.Inventory = out
	return nil
}

// stackCounts: a place's stacks by definition (every maker together).
func stackCounts(ctx context.Context, tx *sql.Tx, at stackAt) (assetCounts, error) {
	v := emptyCounts()
	rows, err := tx.QueryContext(ctx, "SELECT item_def,SUM(qty) FROM item_stacks WHERE location=? AND owner=? GROUP BY item_def ORDER BY item_def", at.location, at.owner)
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
		d, ok := content.ItemFor(def)
		if !ok {
			continue
		}
		if d.Kind == "material" {
			v.Materials[def] = n
		} else {
			v.Items[def] = n
		}
	}
	return v, rows.Err()
}

// ------------------------------------------------------------ home goods

// holder is where a decoration instance sits: a player's pack ('inventory'),
// personal chest or parcel (player set), or a homestead's shared chest or
// grounds (home set).
type holder struct{ location, player, home string }

func pack(id string) holder { return holder{"inventory", id, ""} }

// stackPlace and instancePlace: the same chest or pack, in the item tables.
func (h holder) stackPlace() stackAt {
	switch h.location {
	case "inventory":
		return stackAt{"pack", h.player}
	case "storage":
		return stackAt{"storage", h.home}
	}
	return stackAt{h.location, h.player}
}

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

// ------------------------------------------------------------ moving any asset

// moved is what left a place: stack shares per maker, or instance ids
// (home goods or one item instance).
type moved struct {
	Makers []makerQty
	IDs    []string
}

// takeAsset takes goods out of the caller's pack; instances and home goods
// go to `to` (a chest or a parcel), stacks are returned for the caller to put.
func takeAsset(ctx context.Context, tx *sql.Tx, s *store.Snapshot, v content.Asset, to holder, reason, ref string, now int64) (moved, error) {
	if err := validAsset(v); err != nil {
		return moved{}, err
	}
	switch v.Kind {
	case "material", "item":
		split, err := packTake(ctx, tx, s.HabiticaID, v.ID, v.Maker, v.Qty, reason, ref, now)
		if err != nil {
			return moved{}, err
		}
		return moved{Makers: split, IDs: []string{}}, refreshItems(ctx, tx, s)
	case "instance":
		if err := moveInstance(ctx, tx, v.Instance, v.ID, instanceAt{"pack", s.HabiticaID}, to.instancePlace()); err != nil {
			return moved{}, err
		}
		if err := fittedLedger(ctx, tx, s.HabiticaID, v.Instance, -1, reason, ref, now); err != nil {
			return moved{}, err
		}
		return moved{Makers: []makerQty{}, IDs: []string{v.Instance}}, currency(ctx, tx, s.HabiticaID, content.StackCurrency(v.ID), -1, reason, ref, now)
	default:
		ids, err := decorationIDs(ctx, tx, pack(s.HabiticaID), v.ID, v.Qty)
		if err != nil {
			return moved{}, err
		}
		if err = moveDecorations(ctx, tx, ids, pack(s.HabiticaID), to); err != nil {
			return moved{}, err
		}
		return moved{Makers: []makerQty{}, IDs: ids}, currency(ctx, tx, s.HabiticaID, "decoration:"+v.ID, -v.Qty, reason, ref, now)
	}
}

// giveAsset puts goods into the caller's pack: stacks from their shares,
// instances and home goods from `from`.
func giveAsset(ctx context.Context, tx *sql.Tx, s *store.Snapshot, v content.Asset, got moved, from holder, reason, ref string, now int64) error {
	switch v.Kind {
	case "material", "item":
		if splitTotal(got.Makers) != v.Qty {
			return fail(409, "item-not-available")
		}
		if err := packPut(ctx, tx, s.HabiticaID, v.ID, got.Makers, reason, ref, now); err != nil {
			return err
		}
		return refreshItems(ctx, tx, s)
	case "instance":
		if len(got.IDs) != 1 {
			return fail(409, "item-not-available")
		}
		if err := moveInstance(ctx, tx, got.IDs[0], v.ID, from.instancePlace(), instanceAt{"pack", s.HabiticaID}); err != nil {
			return err
		}
		if err := fittedLedger(ctx, tx, s.HabiticaID, got.IDs[0], 1, reason, ref, now); err != nil {
			return err
		}
		return currency(ctx, tx, s.HabiticaID, content.StackCurrency(v.ID), 1, reason, ref, now)
	case "decoration":
		if len(got.IDs) != v.Qty {
			return fail(409, "item-not-available")
		}
		if err := moveDecorations(ctx, tx, got.IDs, from, pack(s.HabiticaID)); err != nil {
			return err
		}
		return currency(ctx, tx, s.HabiticaID, "decoration:"+v.ID, v.Qty, reason, ref, now)
	}
	return fail(400, "invalid-asset")
}

// packCounts is what a player carries: materials, items, decorations and
// instances (with their fittings).
func packCounts(ctx context.Context, tx *sql.Tx, id string) (assetCounts, error) {
	v, err := stackCounts(ctx, tx, packOf(id))
	if err != nil {
		return v, err
	}
	if v.Instances, err = instancesAt(ctx, tx, instanceAt{"pack", id}); err != nil {
		return v, err
	}
	return v, decorationCounts(ctx, tx, pack(id), v.Decorations)
}

// chestCounts is a chest's contents: the shared home chest (home id) or a
// player's personal chest.
func chestCounts(ctx context.Context, tx *sql.Tx, chest holder) (assetCounts, error) {
	v, err := stackCounts(ctx, tx, chest.stackPlace())
	if err != nil {
		return v, err
	}
	if v.Instances, err = instancesAt(ctx, tx, chest.instancePlace()); err != nil {
		return v, err
	}
	return v, decorationCounts(ctx, tx, chest, v.Decorations)
}

// debitMaterials takes a bill of stacks (any maker) in a fixed order.
func debitMaterials(ctx context.Context, tx *sql.Tx, s *store.Snapshot, costs map[string]int, qty int, reason, ref string, now int64) error {
	for _, id := range content.SortedCosts(costs) {
		if n := costs[id] * qty; n > 0 {
			if err := materialChange(ctx, tx, s.HabiticaID, id, -n, reason, ref, now); err != nil {
				return err
			}
		}
	}
	return refreshItems(ctx, tx, s)
}

// checkMaterials refuses before any ledger row is written.
func checkMaterials(ctx context.Context, tx *sql.Tx, id string, cost map[string]int) error {
	for _, def := range content.SortedCosts(cost) {
		n, err := stackTotal(ctx, tx, packOf(id), def)
		if err != nil {
			return err
		}
		if n < cost[def] {
			return shortfall(def)
		}
	}
	return nil
}

// workshop is the caller's homestead when it has a workshop (tier 2+):
// the shared chest and the bench live there.
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

// ledgerKind is an asset's chest/mail ledger kind ("storage:<kind>:<id>").
func ledgerKind(v content.Asset) string { return strings.Join([]string{v.Kind, v.ID}, ":") }

// grantOnce gives one unmarked item unless the pack already holds one (the
// Ember Charm: opened chests and migrated saves never stack it).
func grantOnce(ctx context.Context, tx *sql.Tx, id, def, reason string, now int64) error {
	n, err := stackTotal(ctx, tx, packOf(id), def)
	if err != nil || n > 0 {
		return err
	}
	return packPut(ctx, tx, id, def, []makerQty{{"", 1}}, reason, def, now)
}
