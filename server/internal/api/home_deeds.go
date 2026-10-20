package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/itemmove"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
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

// settleTurning judges any turning due (store/holds.go) before a lot's
// lantern or backland is read or changed, as camp operations do (turnWick):
// fuel poured after a turning never pays the wick before it. Without a
// generator (or stored epochs) there is nothing to judge.
func (a *Server) settleTurning(ctx context.Context, tx *sql.Tx, world string, now int64) error {
	if a.Config.WildsGenerator == nil || a.Config.Epochs == nil || world == "" {
		return nil
	}
	_, err := chunks.Epoch(ctx, tx, a.Config.Epochs, world, store.EpochWick, now)
	if err != nil && !errors.Is(err, store.ErrGeneratorUnavailable) && !errors.Is(err, chunks.ErrUnavailable) && !errors.Is(err, chunks.ErrEpochEnded) && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	return nil
}

// settleHomes applies the passage of time to a world's homesteads: any
// turning due is judged first (settleTurning), then past deedLostAfterDays
// an empty home's deed is lost and the land returns to unclaimed. Nothing
// on it is lost (roadmap rule 3): everything placed there, its chest, shelf,
// plants, woodpile and the lantern's unspent oil packs into a crate at
// Pell's first (crateLostDeed), then the home and its ground (cleared
// tiles, pending invites) go. Desolation itself is derived on read.
func (a *Server) settleHomes(ctx context.Context, tx *sql.Tx, world string, now int64) error {
	if err := a.settleTurning(ctx, tx, world, now); err != nil {
		return err
	}
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
		if err = crateLostDeed(ctx, tx, world, v.id, v.gate, now); err != nil {
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
			"DELETE FROM lot_lanterns WHERE homestead_id=?",
			"DELETE FROM homestead_land_archive WHERE homestead_id=?",
			"DELETE FROM homestead_members WHERE homestead_id=?",
			"DELETE FROM homesteads WHERE id=?",
		} {
			if _, err = tx.ExecContext(ctx, q, v.id); err != nil {
				return err
			}
		}
		// Nobody is left to tend the lantern: its hold goes at the turning.
		if err = releaseLantern(ctx, tx, world, v.gate, now); err != nil {
			return err
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

// gateCount is how many gates the lane shows: the Commons' frozen capacity
// (its layout has that many gates: location-seam.md 0 decision 10). No home
// sits past it: claim refuses those gates, and CheckHomesteadGates keeps the
// server from starting on a database where one does.
func gateCount() int {
	return commonsGates()
}

// commonsGates is the Commons' gate capacity (its places.json gate anchors).
func commonsGates() int {
	for _, f := range content.PlacesRules.GetFixed() {
		if f.GetId() == "hearthwick" {
			return content.GateCapacity(f)
		}
	}
	return 0
}

// CheckHomesteadGates refuses a database with a homestead past the Commons'
// gate capacity: the lane has no gate there, so its members could never
// reach it. The server runs it at startup; move such a home to a free gate
// first.
func CheckHomesteadGates(ctx context.Context, db *sql.DB) error {
	n := commonsGates()
	var id, world string
	var gate int
	err := db.QueryRowContext(ctx, "SELECT id,world_id,gate FROM homesteads WHERE gate>=? ORDER BY world_id,gate LIMIT 1", n).Scan(&id, &world, &gate)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	return fmt.Errorf("homestead %s (world %s) is at gate %d, past the Commons' %d gates (0-%d): move it to a free gate below %d before starting the server", id, world, gate, n, n-1, n)
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
	if req.Gate == nil || req.Gate.GetValue() < 0 || req.Gate.GetValue() >= int32(gateCount()) {
		return fail(404, "invalid-gate")
	}
	gate := int(req.Gate.GetValue())
	var held string
	var vacant *int64
	err := tx.QueryRowContext(ctx, "SELECT id,vacant_since FROM homesteads WHERE world_id=? AND gate=?", s.WorldID, gate).Scan(&held, &vacant)
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
		err = debitGlims(ctx, tx, s, price, "homestead-deed", ref, now)
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
	if err := debitGlims(ctx, tx, s, int(t.GetGlims()), "homestead-upgrade", t.GetId(), now); err != nil {
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
		// A home good's price may name glims, materials, or both
		// (home_item.price — the stable is priced in both). Both are
		// charged together, the Workshop upgrade does the same, and a
		// shortfall in either refuses the buy with the error that currency
		// owes. A refused buy keeps nothing: the keyed operation rolls its
		// gameplay savepoint back.
		if def.GetGlims() > 0 {
			if err := debitGlims(ctx, tx, s, int(def.GetGlims()), "homestead-buy", def.GetId(), now); err != nil {
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

// crateLostDeed packs everything a lost deed's lot holds into one crate at
// Pell's (roadmap rule 3; lamps.md 2.7), before the home row goes, so it
// waits there after: what is someone's own (the timber they stacked on the
// woodpile) to them, the household's to the last member out. Pieces (set out
// indoors, in the yard or the backland, in the chest or on the gate shelf)
// and the chest's tools go as the same instances; the chest's and shelf's
// stacks keep their makers; plants go as their seed with the planting kept;
// the lantern's unspent oil goes as flasks. A home nobody ever left (it
// can't be vacant) packs nothing.
func crateLostDeed(ctx context.Context, tx *sql.Tx, world, home string, gate int, now int64) error {
	var last string
	err := tx.QueryRowContext(ctx, "SELECT d.account_id FROM homestead_departures d JOIN players p ON p.account_id=d.account_id WHERE d.homestead_id=? ORDER BY d.left_at DESC,d.account_id LIMIT 1", home).Scan(&last)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	type entry struct {
		account, kind, def string
		qty                int
		instance           any
		state              string
	}
	entries := []entry{}
	stateOf := func(v any) string {
		b, _ := json.Marshal(v)
		return string(b)
	}
	makerState := func(maker string) string {
		if maker == "" {
			return "{}"
		}
		return stateOf(map[string]string{"maker": maker})
	}
	// Pieces: placed (with where they stood), in the chest, on the shelf.
	rows, err := tx.QueryContext(ctx, "SELECT id,item_def,location,scene,x,y,rotation FROM homestead_items WHERE homestead_id=? ORDER BY id", home)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, def, location string
		var scene sql.NullString
		var x, y, rot sql.NullInt64
		if err = rows.Scan(&id, &def, &location, &scene, &x, &y, &rot); err != nil {
			rows.Close()
			return err
		}
		state := "{}"
		if scene.Valid {
			state = stateOf(map[string]any{"scene": scene.String, "x": x.Int64, "y": y.Int64, "rotation": rot.Int64})
		}
		entries = append(entries, entry{last, "piece", def, 1, id, state})
	}
	if err = closeRows(rows); err != nil {
		return err
	}
	// The chest's and shelf's tools and gear, fittings and all.
	rows, err = tx.QueryContext(ctx, "SELECT id,item_def FROM item_instances WHERE location IN ('storage','shelf') AND owner=? ORDER BY id", home)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, def string
		if err = rows.Scan(&id, &def); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, entry{last, "tool", def, 1, id, "{}"})
	}
	if err = closeRows(rows); err != nil {
		return err
	}
	// The chest's stacks and the shelf's, by maker.
	rows, err = tx.QueryContext(ctx, `SELECT item_def,maker_id,SUM(qty) FROM (
 SELECT item_def,maker_id,qty FROM item_stacks WHERE location='storage' AND owner=?
 UNION ALL SELECT item_def,maker_id,qty FROM gate_shelf_slots WHERE homestead_id=? AND kind IN ('material','item'))
 GROUP BY item_def,maker_id ORDER BY item_def,maker_id`, home, home)
	if err != nil {
		return err
	}
	for rows.Next() {
		var def, maker string
		var n int
		if err = rows.Scan(&def, &maker, &n); err != nil {
			rows.Close()
			return err
		}
		if n > 0 {
			entries = append(entries, entry{last, "stack", def, n, nil, makerState(maker)})
		}
	}
	if err = closeRows(rows); err != nil {
		return err
	}
	// Plants, in the yard and the backland: the seed back, the planting kept.
	rows, err = tx.QueryContext(ctx, "SELECT id,item_def,x,y,planted_at,planted_day FROM homestead_plants WHERE homestead_id=? ORDER BY planted_at,id", home)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, def string
		var x, y int
		var at, day int64
		if err = rows.Scan(&id, &def, &x, &y, &at, &day); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, entry{last, "plant", def, 1, nil, stateOf(map[string]any{"id": id, "x": x, "y": y, "plantedAt": at, "plantedDay": day})})
	}
	if err = closeRows(rows); err != nil {
		return err
	}
	// Each stacker's own timber on the woodpile, seasoned once it has
	// stood a day (as collecting it would give).
	rows, err = tx.QueryContext(ctx, `SELECT w.account_id,CASE WHEN ?-w.stacked_at>=86400 THEN 'seasoned-timber' ELSE 'timber' END,SUM(w.qty)
 FROM woodpile_stacks w JOIN players p ON p.account_id=w.account_id WHERE w.homestead_id=? GROUP BY 1,2 ORDER BY 1,2`, now, home)
	if err != nil {
		return err
	}
	for rows.Next() {
		var account, def string
		var n int
		if err = rows.Scan(&account, &def, &n); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, entry{account, "stack", def, n, nil, "{}"})
	}
	if err = closeRows(rows); err != nil {
		return err
	}
	// The lantern's unspent oil, as whole flasks.
	var oil int
	if err = tx.QueryRowContext(ctx, "SELECT oil FROM lot_lanterns WHERE homestead_id=?", home).Scan(&oil); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	rules := content.HomeRules.GetLotLantern()
	if flasks := oil / int(max(rules.GetWicksPerOil(), 1)); flasks > 0 {
		entries = append(entries, entry{last, "stack", rules.GetOil(), flasks, nil, "{}"})
	}
	if len(entries) == 0 {
		return nil
	}
	S := chunkSize()
	ox, oy := chunks.LotOrigin(gate)
	crate, err := recoveryCrate(ctx, tx, world, fmt.Sprintf("deed:%s", home), wilds.FloorDiv(ox, S), wilds.FloorDiv(oy, S), now)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if err = addRecoveryEntryFor(ctx, tx, crate, e.account, e.kind, e.def, e.qty, e.instance, e.state, reasonDeedLost); err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE homestead_items SET location='crate',account_id=?,homestead_id=NULL,scene=NULL,x=NULL,y=NULL,rotation=NULL WHERE homestead_id=?", last, home); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE item_instances SET location='crate',owner=? WHERE location IN ('storage','shelf') AND owner=?", last, home)
	return err
}
