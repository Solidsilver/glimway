package api

import (
	"context"
	"database/sql"
	"errors"
	"glimway/content"
	"glimway/server/internal/itemmove"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"slices"
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

func validAsset(v *content.Asset) error {
	if v.GetQty() < 1 || v.GetQty() > 10000 {
		return fail(400, "invalid-quantity")
	}
	if v.GetMaker() != "" && len(v.GetMaker()) > 128 {
		return fail(400, "invalid-asset")
	}
	known := false
	switch v.GetKind() {
	case "material", "item", "instance":
		d, ok := content.ItemFor(v.GetId())
		known = ok && content.ItemAssetKind(d) == v.GetKind()
		if v.GetKind() == "instance" && (v.GetQty() != 1 || v.GetInstance() == "" || len(v.GetInstance()) > 128) {
			return fail(400, "invalid-asset")
		}
	case "decoration":
		_, known = content.HomeItemFor(v.GetId())
	}
	if !known {
		return fail(400, "invalid-asset")
	}
	if v.GetKind() != "instance" && v.GetInstance() != "" || (v.GetKind() == "decoration" || v.GetKind() == "instance") && v.Maker != nil {
		return fail(400, "invalid-asset")
	}
	return nil
}

func isGiveable(v *content.Asset) bool {
	if v.GetKind() == "decoration" {
		return v.GetId() != "door-fox"
	}
	d, ok := content.ItemFor(v.GetId())
	return ok && content.ItemGiveable(d)
}

// ------------------------------------------------------------ stacks

// stackAt is where a stack lies: a player's pack or personal chest
// (owner: the player) or a homestead's shared chest (owner: the home).
type stackAt struct{ location, owner string }

func packOf(id string) stackAt { return stackAt{"pack", id} }

// makerQty is one maker's share of a moved stack (the empty string is unmarked).
type makerQty = itemmove.MakerQty

func splitTotal(split []makerQty) int { return itemmove.SplitTotal(split) }

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
		out = append(out, makerQty{Maker: h.Maker, Qty: n})
		left -= n
	}
	return out, nil
}
func putStack(ctx context.Context, tx *sql.Tx, at stackAt, def string, split []makerQty) error {
	for _, m := range split {
		if m.Qty <= 0 {
			continue
		}
		if err := itemmove.RestoreShare(ctx, tx, at.location, at.owner, def, m); err != nil {
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
		if _, err = tx.ExecContext(ctx, "DELETE FROM item_slots WHERE account_id=? AND item_def=? AND instance_id IS NULL", id, def); err != nil {
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
	return packPut(ctx, tx, id, material, []makerQty{{Maker: "", Qty: delta}}, reason, ref, now)
}

// itemChange is materialChange for the snapshot's own pack, keeping its
// carried-item list (GameState.inventory) current.
func itemChange(ctx context.Context, tx *sql.Tx, s *store.Snapshot, id string, delta int, reason, ref string, now int64) error {
	if err := materialChange(ctx, tx, s.AccountID, id, delta, reason, ref, now); err != nil {
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
	items, err := store.PackItems(ctx, tx, s.AccountID)
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

func decorationIDs(ctx context.Context, tx *sql.Tx, from holder, def string, n int) ([]string, error) {
	rows, err := tx.QueryContext(ctx, "SELECT id FROM homestead_items WHERE location=? AND account_id IS ? AND homestead_id IS ? AND item_def=? AND scene IS NULL ORDER BY id LIMIT ?", from.location, itemmove.Nullable(from.player), itemmove.Nullable(from.home), def, n)
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
	err := itemmove.MoveDecorations(ctx, tx, ids, itemmove.DecorationPlace{Location: from.location, Player: from.player, Home: from.home}, itemmove.DecorationPlace{Location: to.location, Player: to.player, Home: to.home})
	if errors.Is(err, itemmove.ErrUnavailable) {
		return fail(409, "item-not-available")
	}
	return err
}
func decorationCounts(ctx context.Context, tx *sql.Tx, at holder, out map[string]int) error {
	rows, err := tx.QueryContext(ctx, "SELECT item_def,count(*) FROM homestead_items WHERE location=? AND account_id IS ? AND homestead_id IS ? GROUP BY item_def ORDER BY item_def", at.location, itemmove.Nullable(at.player), itemmove.Nullable(at.home))
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
func takeAsset(ctx context.Context, tx *sql.Tx, s *store.Snapshot, v *content.Asset, to holder, reason, ref string, now int64) (moved, error) {
	if err := validAsset(v); err != nil {
		return moved{}, err
	}
	switch v.GetKind() {
	case "material", "item":
		split, err := packTake(ctx, tx, s.AccountID, v.GetId(), v.Maker, int(v.GetQty()), reason, ref, now)
		if err != nil {
			return moved{}, err
		}
		return moved{Makers: split, IDs: []string{}}, refreshItems(ctx, tx, s)
	case "instance":
		if err := moveInstance(ctx, tx, v.GetInstance(), v.GetId(), instanceAt{"pack", s.AccountID}, to.instancePlace(), now); err != nil {
			return moved{}, err
		}
		if err := fittedLedger(ctx, tx, s.AccountID, v.GetInstance(), -1, reason, ref, now); err != nil {
			return moved{}, err
		}
		return moved{Makers: []makerQty{}, IDs: []string{v.GetInstance()}}, currency(ctx, tx, s.AccountID, content.StackCurrency(v.GetId()), -1, reason, ref, now)
	default:
		ids, err := decorationIDs(ctx, tx, pack(s.AccountID), v.GetId(), int(v.GetQty()))
		if err != nil {
			return moved{}, err
		}
		if err = moveDecorations(ctx, tx, ids, pack(s.AccountID), to); err != nil {
			return moved{}, err
		}
		return moved{Makers: []makerQty{}, IDs: ids}, currency(ctx, tx, s.AccountID, "decoration:"+v.GetId(), -int(v.GetQty()), reason, ref, now)
	}
}

// giveAsset puts goods into the caller's pack: stacks from their shares,
// instances and home goods from `from`.
func giveAsset(ctx context.Context, tx *sql.Tx, s *store.Snapshot, v *content.Asset, got moved, from holder, reason, ref string, now int64) error {
	switch v.GetKind() {
	case "material", "item":
		if splitTotal(got.Makers) != int(v.GetQty()) {
			return fail(409, "item-not-available")
		}
		if err := packPut(ctx, tx, s.AccountID, v.GetId(), got.Makers, reason, ref, now); err != nil {
			return err
		}
		return refreshItems(ctx, tx, s)
	case "instance":
		if len(got.IDs) != 1 {
			return fail(409, "item-not-available")
		}
		warden, err := isWardenSet(ctx, tx, got.IDs[0])
		if err != nil {
			return err
		}
		if warden {
			has, err := hasWardenSetInPack(ctx, tx, s.AccountID, "")
			if err != nil {
				return err
			}
			if has {
				return fail(409, "two-wardens-grind")
			}
		}
		if err := moveInstance(ctx, tx, got.IDs[0], v.GetId(), from.instancePlace(), instanceAt{"pack", s.AccountID}, now); err != nil {
			return err
		}
		if err := fittedLedger(ctx, tx, s.AccountID, got.IDs[0], 1, reason, ref, now); err != nil {
			return err
		}
		return currency(ctx, tx, s.AccountID, content.StackCurrency(v.GetId()), 1, reason, ref, now)
	case "decoration":
		if len(got.IDs) != int(v.GetQty()) {
			return fail(409, "item-not-available")
		}
		if err := moveDecorations(ctx, tx, got.IDs, from, pack(s.AccountID)); err != nil {
			return err
		}
		return currency(ctx, tx, s.AccountID, "decoration:"+v.GetId(), int(v.GetQty()), reason, ref, now)
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
func debitMaterials(ctx context.Context, tx *sql.Tx, s *store.Snapshot, costs map[string]int32, qty int, reason, ref string, now int64) error {
	for _, id := range content.SortedCosts(costs) {
		if n := int(costs[id]) * qty; n > 0 {
			if err := materialChange(ctx, tx, s.AccountID, id, -n, reason, ref, now); err != nil {
				return err
			}
		}
	}
	return refreshItems(ctx, tx, s)
}

// checkMaterials refuses before any ledger row is written.
func checkMaterials(ctx context.Context, tx *sql.Tx, id string, cost map[string]int32) error {
	for _, def := range content.SortedCosts(cost) {
		n, err := stackTotal(ctx, tx, packOf(id), def)
		if err != nil {
			return err
		}
		if n < int(cost[def]) {
			return shortfall(def)
		}
	}
	return nil
}

// swapOK: a recipe's swaps (a material's stand-ins, one for one), or none.
func swapFor(swaps map[string]*content.RecipeSwap, def string) []string {
	if swaps == nil {
		return nil
	}
	return swaps[def].GetStandIns()
}

// checkMaterialsAny is checkMaterials, with each bill line payable in its
// primary material or any of its swaps (a pressed-flower frame takes dried
// flowers when the fresh ones are gone). Refuses before any ledger row.
func checkMaterialsAny(ctx context.Context, tx *sql.Tx, id string, cost map[string]int32, swaps map[string]*content.RecipeSwap) error {
	for _, def := range content.SortedCosts(cost) {
		need := int(cost[def])
		have := 0
		for _, d := range append([]string{def}, swapFor(swaps, def)...) {
			n, err := stackTotal(ctx, tx, packOf(id), d)
			if err != nil {
				return err
			}
			have += n
			if have >= need {
				break
			}
		}
		if have < need {
			return shortfall(def)
		}
	}
	return nil
}

// debitMaterialsAny pays a bill with swaps: the primary first, then its
// stand-ins in a fixed order, so the ledger reads the same way every time.
func debitMaterialsAny(ctx context.Context, tx *sql.Tx, s *store.Snapshot, costs map[string]int32, swaps map[string]*content.RecipeSwap, qty int, reason, ref string, now int64) error {
	for _, id := range content.SortedCosts(costs) {
		left := int(costs[id]) * qty
		if left <= 0 {
			continue
		}
		for _, d := range append([]string{id}, swapFor(swaps, id)...) {
			if left <= 0 {
				break
			}
			n, err := stackTotal(ctx, tx, packOf(s.AccountID), d)
			if err != nil {
				return err
			}
			take := min(n, left)
			if take > 0 {
				if err := materialChange(ctx, tx, s.AccountID, d, -take, reason, ref, now); err != nil {
					return err
				}
				left -= take
			}
		}
		if left > 0 {
			return shortfall(id)
		}
	}
	return refreshItems(ctx, tx, s)
}

// bloomSeason: the Mark Bloom-wick falls in (Carting, by the calendar).
var bloomSeason = content.CalendarRules.Marks[slices.Index(content.CalendarRules.Wicks, "Bloom")]

// dryFlowers: bloom flowers age (docs/items/overview.md, "Nothing punishes
// waiting" — they dry, they don't rot). They "dry after a season"
// (docs/items/crafting-and-repair.md): once the server's calendar has
// turned out of the Mark Bloom-wick falls in, the pack's fresh posies dry
// into dried flowers, one for one, in a keyed sweep (the same shape as
// healWardens). Flowers in a chest keep: nothing expires, and a dried posy
// is what comes back out.
func dryFlowers(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) error {
	if content.CalendarAt(content.CalendarRules, now).Mark == bloomSeason {
		return nil
	}
	n, err := stackTotal(ctx, tx, packOf(s.AccountID), "bloom-flowers")
	if err != nil || n <= 0 {
		return err
	}
	if err = materialChange(ctx, tx, s.AccountID, "bloom-flowers", -n, "dry", "bloom-season-turned", now); err != nil {
		return err
	}
	if err = packPut(ctx, tx, s.AccountID, "dried-flowers", []makerQty{{Maker: "", Qty: n}}, "dry", "bloom-season-turned", now); err != nil {
		return err
	}
	return refreshItems(ctx, tx, s)
}

// workshop is the caller's homestead when it has a workshop (tier 2+):
// the shared chest and the bench live there.
func workshop(ctx context.Context, tx *sql.Tx, s *store.Snapshot) (string, error) {
	home, ok, err := memberOf(ctx, tx, s.AccountID)
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
func ledgerKind(v *content.Asset) string { return itemmove.Currency(v.GetKind(), v.GetId()) }

// grantOnce gives one unmarked item unless the pack already holds one (the
// Ember Charm: opened chests and migrated saves never stack it).
func grantOnce(ctx context.Context, tx *sql.Tx, id, def, reason string, now int64) error {
	n, err := stackTotal(ctx, tx, packOf(id), def)
	if err != nil || n > 0 {
		return err
	}
	return packPut(ctx, tx, id, def, []makerQty{{Maker: "", Qty: 1}}, reason, def, now)
}
