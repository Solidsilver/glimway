package api

import (
	"context"
	"database/sql"
	"glimway/server/internal/itemmove"
)

// ------------------------------------------------------------ wear

func utcDay(now int64) int64 { return now / 86400 }

// healWardens: warden-set tools heal overnight (the next calendar day / worn_day < utcDay(now))
// or over ~1 hour (3600s) of real time on a lit tool rack in home storage.
func healWardens(ctx context.Context, tx *sql.Tx, player string, now int64) error {
	today := utcDay(now)
	_, err := tx.ExecContext(ctx, `UPDATE item_instances SET condition=max_condition, worn_day=?
WHERE (location='pack' OR location='personal') AND owner=? AND worn_day<? AND condition<max_condition
 AND EXISTS(SELECT 1 FROM item_instances f WHERE f.location='fitted' AND f.owner=item_instances.id AND f.item_def IN (`+wardenDefs()+`))`, today, player, today)
	if err != nil {
		return err
	}
	var homeID string
	_ = tx.QueryRowContext(ctx, "SELECT homestead_id FROM homestead_members WHERE habitica_id=?", player).Scan(&homeID)
	if homeID != "" {
		return healWardensHome(ctx, tx, homeID, now)
	}
	return nil
}

func healWardensHome(ctx context.Context, tx *sql.Tx, homeID string, now int64) error {
	today := utcDay(now)
	_, err := tx.ExecContext(ctx, `UPDATE item_instances SET condition=max_condition, worn_day=?
WHERE location='storage' AND owner=? AND worn_day<? AND condition<max_condition
 AND EXISTS(SELECT 1 FROM item_instances f WHERE f.location='fitted' AND f.owner=item_instances.id AND f.item_def IN (`+wardenDefs()+`))`, today, homeID, today)
	if err != nil {
		return err
	}
	h, err := loadHome(ctx, tx, homeID, "", now)
	if err != nil || h.Desolate {
		return err
	}
	// Shared storage is the rack: its tools heal only while a placed rack stands in lamplight.
	rackLit := false
	for _, item := range h.Items {
		if item.ItemDef != "tool-rack" || item.Scene == nil {
			continue
		}
		if *item.Scene == "indoor" {
			rackLit = true
			break
		}
		if r, ok := placedRect(item); ok && rectLit(connectedLights(h.Items, ""), r) {
			rackLit = true
			break
		}
	}
	if !rackLit {
		return nil
	}
	rows, err := tx.QueryContext(ctx, `SELECT id, condition, max_condition, racked_at FROM item_instances
WHERE location='storage' AND owner=? AND condition<max_condition
 AND EXISTS(SELECT 1 FROM item_instances f WHERE f.location='fitted' AND f.owner=item_instances.id AND f.item_def IN (`+wardenDefs()+`))`, homeID)
	if err != nil {
		return err
	}
	defer rows.Close()
	type rackTool struct {
		id            string
		cond, maxCond int
		rackedAt      int64
	}
	var tools []rackTool
	for rows.Next() {
		var t rackTool
		if err := rows.Scan(&t.id, &t.cond, &t.maxCond, &t.rackedAt); err != nil {
			return err
		}
		tools = append(tools, t)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, t := range tools {
		if t.rackedAt == 0 {
			if _, err = tx.ExecContext(ctx, "UPDATE item_instances SET racked_at=? WHERE id=?", now, t.id); err != nil {
				return err
			}
			continue
		}
		elapsed := now - t.rackedAt
		if elapsed >= 3600 {
			if _, err = tx.ExecContext(ctx, "UPDATE item_instances SET condition=max_condition, racked_at=? WHERE id=?", now, t.id); err != nil {
				return err
			}
		} else if elapsed > 0 {
			add := int(float64(t.maxCond) * float64(elapsed) / 3600.0)
			if add > 0 {
				newCond := min(t.maxCond, t.cond+add)
				advanced := int64(add * 3600 / max1(t.maxCond))
				if _, err = tx.ExecContext(ctx, "UPDATE item_instances SET condition=?, racked_at=racked_at+? WHERE id=?", newCond, advanced, t.id); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func isWardenSet(ctx context.Context, tx *sql.Tx, instanceID string) (bool, error) {
	var count int
	err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM item_instances WHERE location='fitted' AND owner=? AND item_def IN ("+wardenDefs()+")", instanceID).Scan(&count)
	return count > 0, err
}

func hasWardenSetInPack(ctx context.Context, tx *sql.Tx, player, exceptTool string) (bool, error) {
	var count int
	err := tx.QueryRowContext(ctx, `SELECT COUNT(*) FROM item_instances t
WHERE t.location='pack' AND t.owner=? AND t.id<>?
		AND EXISTS (SELECT 1 FROM item_instances f WHERE f.location='fitted' AND f.owner=t.id AND f.item_def IN (`+wardenDefs()+`))`, player, exceptTool).Scan(&count)
	return count > 0, err
}

func wardenDefs() string { return itemmove.WardenDefsSQL() }
