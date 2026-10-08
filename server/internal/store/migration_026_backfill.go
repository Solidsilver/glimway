package store

import (
	"database/sql"
	"encoding/json"
	"glimway/server/internal/rules"
	"log"
	"math"
)

// Old checkpoints are evidence, never a prerequisite for starting an upgrade.
// Prefer a valid imported profile, then checkpoint, retain the verified XP mark,
// and otherwise finish with the default state and no imported profile.
func finishOrigins026(tx *sql.Tx) error {
	rows, err := tx.Query(`SELECT o.account_id,b.profile_json,b.checkpoint_json,b.verified_xp FROM origins_026 o LEFT JOIN sync_baselines b USING(account_id)`)
	if err != nil {
		return err
	}
	type pending struct {
		id       string
		profile  *rules.Profile
		xp       float64
		fallback string
	}
	var players []pending
	for rows.Next() {
		var id string
		var imported, checkpoint sql.NullString
		var xp sql.NullFloat64
		if err = rows.Scan(&id, &imported, &checkpoint, &xp); err != nil {
			rows.Close()
			return err
		}
		v := pending{id: id, fallback: "no valid profile; default state"}
		if xp.Valid && xp.Float64 >= 0 && !math.IsNaN(xp.Float64) && !math.IsInf(xp.Float64, 0) {
			v.xp = xp.Float64
		}
		for i, raw := range []sql.NullString{imported, checkpoint} {
			var p rules.Profile
			if raw.Valid && json.Unmarshal([]byte(raw.String), &p) == nil && rules.ValidProfile(p) {
				v.profile = &p
				v.fallback = []string{"profile_json", "checkpoint_json"}[i]
				if p.Exp != nil && xp.Valid && math.Abs(rules.LifetimeXP(p.Level, *p.Exp)-v.xp) < 1e-6 && i == 1 {
					v.fallback = ""
				}
				break
			}
		}
		players = append(players, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, v := range players {
		if v.fallback != "" {
			log.Printf("migration 026 account %s fallback: %s; verified XP mark %g", v.id, v.fallback, v.xp)
		}
		state := rules.NewState()
		var imported any
		source := "none"
		checkpoint := rules.Profile{ID: v.id, Name: "Player", Level: 1, HP: state.HP, MaxHP: state.MaxHP, MP: state.Mana, MaxMP: state.MaxMana, Stats: rules.Stats{}}
		exp := 0.
		checkpoint.Exp = &exp
		if v.profile != nil {
			checkpoint = *v.profile
			imported = JSON(v.profile)
			source = "habitica"
			state.HP = min(checkpoint.HP, checkpoint.MaxHP)
			state.Mana = min(checkpoint.MP, checkpoint.MaxMP)
		}
		if _, err = tx.Exec(`INSERT INTO sync_baselines(account_id,profile_json,xp_mark,verified_xp,checkpoint_json,checkpoint_at,updated_at)
   VALUES(?,?,?,?,?,0,0) ON CONFLICT(account_id) DO UPDATE SET profile_json=excluded.profile_json,xp_mark=excluded.xp_mark,verified_xp=excluded.verified_xp,checkpoint_json=excluded.checkpoint_json`, v.id, imported, v.xp, v.xp, JSON(checkpoint)); err != nil {
			return err
		}
		if _, err = tx.Exec("UPDATE players SET rev=rev+1,profile_source=? WHERE account_id=?", source, v.id); err != nil {
			return err
		}
		if _, err = tx.Exec(`INSERT INTO progress(account_id,schema_version,rev,doc_json,updated_at) VALUES(?,1,(SELECT rev FROM players WHERE account_id=?),?,0)
   ON CONFLICT(account_id) DO UPDATE SET doc_json=excluded.doc_json,rev=excluded.rev`, v.id, v.id, JSON(state)); err != nil {
			return err
		}
	}
	_, err = tx.Exec("DROP TABLE origins_026")
	return err
}
