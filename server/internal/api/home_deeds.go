package api

import (
	"context"
	"database/sql"
	"fmt"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/itemmove"
	"glimway/server/internal/store"
)

const day = 86400

func desolate(vacantSince *int64, now int64) bool {
	return vacantSince != nil && now-*vacantSince >= int64(content.HomeRules.Desolation.DesolateAfterDays)*day
}

// memberOf is the caller's homestead, if any.
func memberOf(ctx context.Context, tx *sql.Tx, id string) (string, bool, error) {
	var home string
	err := tx.QueryRowContext(ctx, "SELECT homestead_id FROM homestead_members WHERE account_id=?", id).Scan(&home)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	return home, err == nil, err
}

// settleHomes applies the passage of time to a world's empty homesteads:
// past deedLostAfterDays the deed is lost, the land returns to unclaimed and
// everything left on it (placed pieces, the shared chest, cleared ground,
// pending invites) goes with it. Desolation itself is derived on read.
func settleHomes(ctx context.Context, tx *sql.Tx, world string, now int64) error {
	cutoff := now - int64(content.HomeRules.Desolation.DeedLostAfterDays)*day
	rows, err := tx.QueryContext(ctx, "SELECT id,gate FROM homesteads WHERE world_id=? AND vacant_since IS NOT NULL AND vacant_since<=? ORDER BY gate", world, cutoff)
	if err != nil {
		return err
	}
	type lost struct {
		id   string
		gate int
	}
	all := []lost{}
	for rows.Next() {
		var v lost
		if err = rows.Scan(&v.id, &v.gate); err != nil {
			rows.Close()
			return err
		}
		all = append(all, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, v := range all {
		if err = writeOffLostDeed(ctx, tx, v.id, v.gate, now); err != nil {
			return err
		}
		for _, q := range []string{
			"DELETE FROM homestead_departures WHERE homestead_id=?",
			"DELETE FROM homestead_invites WHERE homestead_id=?",
			"DELETE FROM homestead_cleared WHERE homestead_id=?",
			"DELETE FROM homestead_stumps WHERE homestead_id=?",
			"DELETE FROM homestead_plants WHERE homestead_id=?",
			"DELETE FROM gate_shelf_takes WHERE homestead_id=?",
			"DELETE FROM gate_shelf_slots WHERE homestead_id=?",
			"DELETE FROM item_stacks WHERE location='storage' AND owner=?",
			"DELETE FROM item_instances WHERE location='fitted' AND owner IN (SELECT id FROM item_instances WHERE (location='storage' OR location='shelf') AND owner=?)",
			"DELETE FROM item_instances WHERE (location='storage' OR location='shelf') AND owner=?",
			// The woodpile's stacks reference the homestead: they go before it.
			"DELETE FROM woodpile_stacks WHERE homestead_id=?",
			// So do the stable's stalls (030).
			"DELETE FROM homestead_stalls WHERE homestead_id=?",
			"DELETE FROM homestead_items WHERE homestead_id=?",
			"DELETE FROM homestead_members WHERE homestead_id=?",
			"DELETE FROM homesteads WHERE id=?",
		} {
			if _, err = tx.ExecContext(ctx, q, v.id); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO lost_gates(world_id,gate,lost_at) VALUES(?,?,?) ON CONFLICT(world_id,gate) DO UPDATE SET lost_at=excluded.lost_at", world, v.gate, now); err != nil {
			return err
		}
	}
	return nil
}

// writeOffLostDeed records what a lost deed takes with it, on the ledger of
// the last member to leave: an offsetting row for everything in the home
// chest (so the per-currency sums still balance), a zero row naming every
// piece set out on the land, and one for the deed itself.
func writeOffLostDeed(ctx context.Context, tx *sql.Tx, home string, gate int, now int64) error {
	var last string
	err := tx.QueryRowContext(ctx, "SELECT account_id FROM homestead_departures WHERE homestead_id=? ORDER BY left_at DESC,account_id LIMIT 1", home).Scan(&last)
	if err == sql.ErrNoRows {
		return nil // nobody ever left it (it can't be vacant then)
	}
	if err != nil {
		return err
	}
	ref := fmt.Sprintf("%s:gate:%d", home, gate)
	type row struct {
		currency string
		delta    int
		ref      string
	}
	out := []row{}
	// The woodpile's green timber (the pile's own currency), written off
	// like the chest's stacks: it was on nobody's pack any more.
	var pile int
	if err = tx.QueryRowContext(ctx, "SELECT COALESCE(SUM(qty),0) FROM woodpile_stacks WHERE homestead_id=?", home).Scan(&pile); err != nil {
		return err
	}
	if pile > 0 {
		out = append(out, row{woodpileCurrency, -pile, ref})
	}
	// The shared chest's stacks (every maker together), in the currencies
	// the deposits used: storage:material:<id> / storage:item:<id>.
	rows, err := tx.QueryContext(ctx, "SELECT item_def,SUM(qty) FROM item_stacks WHERE location='storage' AND owner=? GROUP BY item_def ORDER BY item_def", home)
	if err != nil {
		return err
	}
	for rows.Next() {
		var def string
		var n int
		if err = rows.Scan(&def, &n); err != nil {
			rows.Close()
			return err
		}
		kind := "item"
		if d, ok := content.ItemFor(def); ok {
			kind = content.ItemAssetKind(d)
		}
		out = append(out, row{itemmove.LocationCurrency("storage", kind, def), -n, ref})
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	// Tools and gear in the chest, one by one (storage:instance:<id>), and
	// a zero row naming each fitting that goes with them.
	rows, err = tx.QueryContext(ctx, `SELECT i.id,i.item_def,'storage' FROM item_instances i WHERE i.location='storage' AND i.owner=?
 UNION ALL SELECT f.id,f.item_def,'fitted' FROM item_instances f JOIN item_instances t ON t.id=f.owner WHERE f.location='fitted' AND t.location='storage' AND t.owner=?
 ORDER BY 3 DESC,1`, home, home)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, def, where string
		if err = rows.Scan(&id, &def, &where); err != nil {
			rows.Close()
			return err
		}
		if where == "storage" {
			out = append(out, row{"storage:instance:" + def, -1, ref + ":" + id})
		} else {
			out = append(out, row{"fitted:" + def, 0, ref + ":" + id})
		}
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	rows, err = tx.QueryContext(ctx, "SELECT id,item_def,location FROM homestead_items WHERE homestead_id=? ORDER BY id", home)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, def, location string
		if err = rows.Scan(&id, &def, &location); err != nil {
			rows.Close()
			return err
		}
		if location == "storage" {
			out = append(out, row{"storage:decoration:" + def, -1, ref + ":" + id})
		} else if location == "shelf" {
			// Handled by gate_shelf_slots
		} else {
			out = append(out, row{"decoration:" + def, 0, ref + ":" + id})
		}
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	// Gate shelf contents (shelf:<kind>:<id> currency), written off
	// like the chest's stacks.
	rows, err = tx.QueryContext(ctx, "SELECT kind,item_def,SUM(qty) FROM gate_shelf_slots WHERE homestead_id=? GROUP BY kind,item_def ORDER BY kind,item_def", home)
	if err != nil {
		return err
	}
	for rows.Next() {
		var kind, def string
		var n int
		if err = rows.Scan(&kind, &def, &n); err != nil {
			rows.Close()
			return err
		}
		out = append(out, row{"shelf:" + kind + ":" + def, -n, ref})
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	rows, err = tx.QueryContext(ctx, `SELECT f.id,f.item_def FROM item_instances f JOIN item_instances t ON t.id=f.owner WHERE f.location='fitted' AND t.location='shelf' AND t.owner=? ORDER BY f.id`, home)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, def string
		if err = rows.Scan(&id, &def); err != nil {
			rows.Close()
			return err
		}
		out = append(out, row{"fitted:" + def, 0, ref + ":" + id})
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	out = append(out, row{"homestead", 0, ref})
	for _, r := range out {
		if err = currency(ctx, tx, last, r.currency, r.delta, "deed-lost", r.ref, now); err != nil {
			return err
		}
	}
	return nil
}

// gateCount is how many gates the lane shows: every claimed gate and at
// least SpareGates unclaimed ones.
func gateCount(ctx context.Context, tx *sql.Tx, world string) (int, error) {
	var n, top int
	if err := tx.QueryRowContext(ctx, "SELECT count(*),COALESCE(MAX(gate)+1,0) FROM homesteads WHERE world_id=?", world).Scan(&n, &top); err != nil {
		return 0, err
	}
	return max(top, n+int(content.HomeRules.GetCommons().GetSpareGates())), nil
}

// deedPrice is what a player pays Silas for the deed to an unclaimed gate:
// the first deed is free, unless the land there was lost before.
func deedPrice(ctx context.Context, tx *sql.Tx, player, world string, gate int) (int, error) {
	var deeds, lost int
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE((SELECT deeds FROM player_deeds WHERE account_id=?),0),(SELECT count(*) FROM lost_gates WHERE world_id=? AND gate=?)", player, world, gate).Scan(&deeds, &lost); err != nil {
		return 0, err
	}
	if content.HomeRules.GetDeeds().GetFirstFree() && deeds == 0 && lost == 0 {
		return 0, nil
	}
	return int(content.HomeRules.GetDeeds().GetGlims()), nil
}

func addDeed(ctx context.Context, tx *sql.Tx, player string) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO player_deeds VALUES(?,1) ON CONFLICT(account_id) DO UPDATE SET deeds=deeds+1", player)
	return err
}

func (a *Server) claim(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.HomesteadRequest, member bool, now int64) error {
	if member {
		return fail(409, "already-homesteaded")
	}
	n, err := gateCount(ctx, tx, s.WorldID)
	if err != nil {
		return err
	}
	if req.Gate == nil || req.Gate.GetValue() < 0 || req.Gate.GetValue() >= int32(n) {
		return fail(404, "invalid-gate")
	}
	gate := int(req.Gate.GetValue())
	var held string
	var vacant *int64
	err = tx.QueryRowContext(ctx, "SELECT id,vacant_since FROM homesteads WHERE world_id=? AND gate=?", s.WorldID, gate).Scan(&held, &vacant)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil {
		// Still under its deed. The last ones out may take it back, as it
		// stands, until the deed is lost; anyone else asks a member.
		if vacant == nil || !departed(ctx, tx, held, s.AccountID) {
			return fail(409, "gate-taken")
		}
		return reclaim(ctx, tx, s, held, now)
	}
	price, err := deedPrice(ctx, tx, s.AccountID, s.WorldID, gate)
	if err != nil {
		return err
	}
	ref := fmt.Sprintf("gate:%d", gate)
	if price > 0 {
		err = debitEmbers(ctx, tx, s, price, "homestead-deed", ref, now)
	} else {
		err = store.Credit(ctx, tx, s, 0, 0, "homestead-deed", ref, nil, now)
	}
	if err != nil {
		return err
	}
	id, err := store.Random()
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO homesteads(id,world_id,gate,claimed_at) VALUES(?,?,?,?)", id, s.WorldID, gate, now); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_members VALUES(?,?,?)", s.AccountID, id, now); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM lost_gates WHERE world_id=? AND gate=?", s.WorldID, gate); err != nil {
		return err
	}
	return addDeed(ctx, tx, s.AccountID)
}

// departed: the player was on this home's deed and gave up their place.
func departed(ctx context.Context, tx *sql.Tx, home, player string) bool {
	var n int
	return tx.QueryRowContext(ctx, "SELECT count(*) FROM homestead_departures WHERE homestead_id=? AND account_id=?", home, player).Scan(&n) == nil && n > 0
}

// reclaim puts a former member back on their vacant home's deed: the land,
// the cottage, the posts and the chest as they were, and no charge.
func reclaim(ctx context.Context, tx *sql.Tx, s *store.Snapshot, home string, now int64) error {
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{"UPDATE homesteads SET vacant_since=NULL WHERE id=?", []any{home}},
		{"INSERT INTO homestead_members VALUES(?,?,?)", []any{s.AccountID, home, now}},
		{"DELETE FROM homestead_departures WHERE homestead_id=? AND account_id=?", []any{home, s.AccountID}},
	} {
		if _, err := tx.ExecContext(ctx, q.sql, q.args...); err != nil {
			return err
		}
	}
	return store.Credit(ctx, tx, s, 0, 0, "homestead-reclaim", home, nil, now)
}

func upgradeHome(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, req *contract.HomesteadRequest, now int64) error {
	tiers := content.HomeRules.Tiers
	if req.Tier == nil || req.Tier.GetValue() != int32(h.Tier+1) || req.Tier.GetValue() >= int32(len(tiers)) || !tiers[req.Tier.GetValue()].GetPurchasable() {
		return fail(409, "tier-unavailable")
	}
	t := tiers[req.Tier.GetValue()]
	if err := debitEmbers(ctx, tx, s, int(t.GetGlims()), "homestead-upgrade", t.GetId(), now); err != nil {
		return err
	}
	if err := debitMaterials(ctx, tx, s, t.GetMaterials(), 1, "homestead-upgrade", t.GetId(), now); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "UPDATE homesteads SET tier=? WHERE id=?", t.GetTier(), h.ID)
	return err
}

func buyItem(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, req *contract.HomesteadRequest, now int64) (string, error) {
	def, ok := content.HomeItemFor(req.ItemDef)
	if !ok {
		return "", fail(400, "invalid-item")
	}
	// Pieces made at the bench (or given by the story) are never sold.
	if def.GetCraftOnly() {
		return "", fail(409, "craft-only")
	}
	if int(def.GetMinTier()) > h.Tier {
		return "", fail(409, "tier-required")
	}
	// One stable per homestead (docs/design/crafts.md 3.2): placed here,
	// stored here, or carried by one of its members. It comes with stall 1
	// and grows east from there.
	if def.GetId() == stableItemID() {
		var taken bool
		if err := tx.QueryRowContext(ctx, `SELECT EXISTS(
 SELECT 1 FROM homestead_items WHERE item_def=? AND (homestead_id=? OR account_id IN (SELECT account_id FROM homestead_members WHERE homestead_id=?)))`, def.GetId(), h.ID, h.ID).Scan(&taken); err != nil {
			return "", err
		}
		if taken {
			return "", fail(409, "stable-full")
		}
	}
	if def.GetId() == content.HomeRules.GetLanternPosts().GetItem() {
		// Each post costs more than the last (the homestead's count, not the buyer's).
		cost := content.HomePostCost(content.HomeRules, h.PostsBought)
		if err := checkMaterials(ctx, tx, s.AccountID, cost); err != nil {
			return "", err
		}
		if err := debitMaterials(ctx, tx, s, cost, 1, "homestead-buy", def.GetId(), now); err != nil {
			return "", err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE homesteads SET posts_bought=posts_bought+1 WHERE id=?", h.ID); err != nil {
			return "", err
		}
	} else {
		// A home good's price may name embers, materials, or both
		// (home_item.price — the stable is priced in both). Both are
		// charged together, the Workshop upgrade does the same, and a
		// shortfall in either refuses the buy with the error that currency
		// owes. A refused buy keeps nothing: the keyed operation rolls its
		// gameplay savepoint back.
		if def.GetGlims() > 0 {
			if err := debitEmbers(ctx, tx, s, int(def.GetGlims()), "homestead-buy", def.GetId(), now); err != nil {
				return "", err
			}
		}
		if len(def.GetMaterials()) > 0 {
			if err := checkMaterials(ctx, tx, s.AccountID, def.GetMaterials()); err != nil {
				return "", err
			}
			if err := debitMaterials(ctx, tx, s, def.GetMaterials(), 1, "homestead-buy", def.GetId(), now); err != nil {
				return "", err
			}
		}
	}
	id, err := store.Random()
	if err != nil {
		return "", err
	}
	var stalls any
	if def.GetId() == stableItemID() {
		stalls = 1 // "comes with stall 1" (3.1)
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_items(id,item_def,location,account_id,stalls) VALUES(?,?,'inventory',?,?)", id, def.GetId(), s.AccountID, stalls); err != nil {
		return "", err
	}
	return id, currency(ctx, tx, s.AccountID, "decoration:"+def.GetId(), 1, "homestead-buy", id, now)
}
