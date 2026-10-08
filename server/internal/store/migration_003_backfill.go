// DO NOT EDIT; hashed by migrations/history.json. Change behavior in a forward migration.
// This historical backfill depends on rules.Profile, rules.LossReference and
// rules.LifetimeXP; their JSON shape and XP formula also affect replaying 003.
package store

import (
	"database/sql"
	"encoding/json"
	"glimway/server/internal/rules"
)

// Old databases did not retain a sync-only timestamp. Use the best available
// baseline timestamp on upgrade; all new sync/checkpoint events record loss_at.
func initializeLossReferences(tx *sql.Tx) error {
	rows, err := tx.Query("SELECT habitica_id,profile_json,checkpoint_json,verified_xp,checkpoint_at,updated_at FROM sync_baselines")
	if err != nil {
		return err
	}
	type entry struct {
		id   string
		ref  rules.LossReference
		at   int64
		high float64
	}
	var entries []entry
	for rows.Next() {
		var id, raw string
		var baseline sql.NullString
		var xp float64
		var cpAt, updated int64
		if err = rows.Scan(&id, &baseline, &raw, &xp, &cpAt, &updated); err != nil {
			rows.Close()
			return err
		}
		var cp rules.Profile
		if err = json.Unmarshal([]byte(raw), &cp); err != nil {
			rows.Close()
			return err
		}
		e := entry{id: id, ref: rules.LossReference{Level: max(1, cp.Level), XP: xp}, at: cpAt, high: max(1, cp.Level)}
		if baseline.Valid && updated > cpAt {
			var p rules.Profile
			if err = json.Unmarshal([]byte(baseline.String), &p); err != nil {
				rows.Close()
				return err
			}
			if p.Exp != nil {
				e.ref = rules.LossReference{Level: p.Level, XP: rules.LifetimeXP(p.Level, *p.Exp)}
				e.at = updated
			}
		}
		entries = append(entries, e)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, e := range entries {
		if _, err = tx.Exec(`UPDATE sync_baselines SET loss_level=?,loss_xp=?,loss_at=?,verified_high_level=MAX(?,COALESCE((SELECT MAX(json_extract(checkpoint_json,'$.level')) FROM sessions WHERE habitica_id=?),1),CASE WHEN EXISTS(SELECT 1 FROM ledger WHERE habitica_id=? AND reason='rebirth' AND ref='checkpoint') THEN 2 ELSE 1 END) WHERE habitica_id=?`, e.ref.Level, e.ref.XP, e.at, e.high, e.id, e.id, e.id); err != nil {
			return err
		}
	}
	return nil
}
