package api

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/store"
	"strings"
)

// ------------------------------------------------------------ position

// near: the caller's last uploaded spot is in an area, within r tiles of a tile.
// residentReachTiles: how near a named resident (Ada, Hazel) you stand to
// hand them something or take something from them. The client offers the
// same beats at the same reach (src/content/heirlooms.ts RESIDENT_REACH_TILES).
const residentReachTiles = 4

func nearTile(s *store.Snapshot, area string, tx, ty, r int) bool {
	if s.State.Area != area {
		return false
	}
	cx, cy := float64(tx*wildsTileSize+wildsTileSize/2), float64(ty*wildsTileSize+wildsTileSize/2)
	dx, dy := s.State.Position.X-cx, s.State.Position.Y-cy
	rr := float64(r * wildsTileSize)
	return dx*dx+dy*dy <= rr*rr
}

func offHandOpen(s *store.Snapshot) (bool, *string) {
	if s.ImportedProfile == nil || s.ImportedProfile.Class == nil || *s.ImportedProfile.Class == "" {
		return false, nil
	}
	return true, s.ImportedProfile.Class
}

// ------------------------------------------------------------ pockets and the off hand

func carriesGear(ctx context.Context, tx *sql.Tx, player string) (bool, error) {
	ids := []string{}
	for _, d := range content.ItemsRules.Items {
		if d.Kind == "carry-gear" {
			ids = append(ids, "'"+d.ID+"'")
		}
	}
	if len(ids) == 0 {
		return false, nil
	}
	var n int
	err := tx.QueryRowContext(ctx, "SELECT count(*) FROM item_instances WHERE location='pack' AND owner=? AND item_def IN ("+strings.Join(ids, ",")+")", player).Scan(&n)
	return n > 0, err
}

func pocketCount(ctx context.Context, tx *sql.Tx, player string) (int, error) {
	gear, err := carriesGear(ctx, tx, player)
	if gear {
		return content.ItemsRules.Rules.Pockets.WithCarryGear, err
	}
	return content.ItemsRules.Rules.Pockets.Base, err
}

type slotRow struct {
	slot, def string
	instance  sql.NullString
}

func slots(ctx context.Context, tx *sql.Tx, player string) ([]slotRow, error) {
	rows, err := tx.QueryContext(ctx, "SELECT slot,item_def,instance_id FROM item_slots WHERE habitica_id=? ORDER BY slot", player)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []slotRow{}
	for rows.Next() {
		var v slotRow
		if err = rows.Scan(&v.slot, &v.def, &v.instance); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// slotHolds: the thing a slot points at is still in the pack and allowed there.
func slotHolds(ctx context.Context, tx *sql.Tx, player string, v slotRow) (bool, error) {
	def, ok := content.ItemFor(v.def)
	if !ok {
		return false, nil
	}
	if v.instance.Valid {
		var n int
		err := tx.QueryRowContext(ctx, "SELECT count(*) FROM item_instances WHERE id=? AND item_def=? AND location='pack' AND owner=?", v.instance.String, v.def, player).Scan(&n)
		return n == 1 && v.slot == "off-hand" && def.OffHandable(), err
	}
	n, err := stackTotal(ctx, tx, packOf(player), v.def)
	if v.slot == "off-hand" {
		return n > 0 && def.OffHandable() && def.Kind == "keepsake", err
	}
	return n > 0 && def.Kind == "keepsake", err
}

// settleSlots drops anything a pocket or the off hand points at that is no
// longer carried or allowed: a second pocket without carry gear, an off hand
// without a class.
func settleSlots(ctx context.Context, tx *sql.Tx, s *store.Snapshot) error {
	list, err := slots(ctx, tx, s.HabiticaID)
	if err != nil || len(list) == 0 {
		return err
	}
	pockets, err := pocketCount(ctx, tx, s.HabiticaID)
	if err != nil {
		return err
	}
	open, _ := offHandOpen(s)
	pocketed := map[string]bool{}
	for _, v := range list {
		keep, err := slotHolds(ctx, tx, s.HabiticaID, v)
		if err != nil {
			return err
		}
		switch v.slot {
		case "off-hand":
			keep = keep && open
		case "pocket-2":
			keep = keep && pockets >= 2 && !pocketed[v.def]
		}
		if v.slot != "off-hand" && keep {
			pocketed[v.def] = true
		}
		if !keep {
			if _, err = tx.ExecContext(ctx, "DELETE FROM item_slots WHERE habitica_id=? AND slot=?", s.HabiticaID, v.slot); err != nil {
				return err
			}
		}
	}
	return nil
}

// pocketItem puts a carried keepsake in pocket 1 or 2 (empty itemDef: empty it).
func pocketItem(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest) error {
	n, err := pocketCount(ctx, tx, s.HabiticaID)
	if err != nil {
		return err
	}
	if req.Slot < 1 || req.Slot > content.ItemsRules.Rules.Pockets.WithCarryGear {
		return fail(400, "invalid-slot")
	}
	if req.Slot > n {
		return fail(409, "no-such-pocket")
	}
	slot := "pocket-" + string(rune('0'+req.Slot))
	if _, err = tx.ExecContext(ctx, "DELETE FROM item_slots WHERE habitica_id=? AND slot=?", s.HabiticaID, slot); err != nil {
		return err
	}
	if req.ItemDef == "" {
		return nil
	}
	def, ok := content.ItemFor(req.ItemDef)
	if !ok || def.Kind != "keepsake" {
		return fail(400, "not-a-keepsake")
	}
	if have, err := stackTotal(ctx, tx, packOf(s.HabiticaID), def.ID); err != nil {
		return err
	} else if have == 0 {
		return fail(409, "insufficient-items")
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM item_slots WHERE habitica_id=? AND slot LIKE 'pocket-%' AND item_def=?", s.HabiticaID, def.ID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO item_slots(habitica_id,slot,item_def) VALUES(?,?,?)", s.HabiticaID, slot, def.ID)
	return err
}

// offHandItem carries one thing in the off hand (it opens with a class):
// an off-hand instance by id, or an off-hand keepsake by definition.
func offHandItem(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest) error {
	if open, _ := offHandOpen(s); !open {
		return fail(409, "off-hand-closed")
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM item_slots WHERE habitica_id=? AND slot='off-hand'", s.HabiticaID); err != nil {
		return err
	}
	if req.Instance == "" && req.ItemDef == "" {
		return nil
	}
	row := slotRow{slot: "off-hand", def: req.ItemDef}
	if req.Instance != "" {
		v, err := loadInstance(ctx, tx, req.Instance)
		if err != nil {
			return err
		}
		row.def = v.Def
		row.instance = sql.NullString{String: v.ID, Valid: true}
	}
	ok, err := slotHolds(ctx, tx, s.HabiticaID, row)
	if err != nil {
		return err
	}
	if !ok {
		return fail(409, "not-for-the-off-hand")
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO item_slots(habitica_id,slot,item_def,instance_id) VALUES(?,?,?,?)", s.HabiticaID, "off-hand", row.def, row.instance)
	return err
}
