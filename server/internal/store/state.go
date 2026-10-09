package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"glimway/content"
	"glimway/server/internal/profile"
	"glimway/server/internal/rules"
	"strings"
)

func Load(ctx context.Context, tx *sql.Tx, id string) (Snapshot, error) {
	var s Snapshot
	s.State = rules.NewState()
	var flagged sql.NullInt64
	var checkpoint string
	err := tx.QueryRowContext(ctx, `SELECT p.account_id,p.display_name,p.world_id,p.habitica_party_id,p.version,p.profile_source,p.flagged_at,p.lease_id,p.lease_client,p.lease_seen_at,v.hp,v.mana,l.area,l.x,l.y,p.play_seconds,b.embers,b.xp_embers,x.xp_mark,x.pending,x.verified_xp,x.checkpoint_json,x.checkpoint_at,x.loss_level,x.loss_xp,x.loss_at,x.verified_high_level,COALESCE(x.class_mark,''),x.checkpoint_ledger_id FROM players p JOIN player_vitals v USING(account_id) JOIN player_place l USING(account_id) JOIN balances b USING(account_id) JOIN sync_baselines x USING(account_id) WHERE p.account_id=?`, id).Scan(&s.AccountID, &s.DisplayName, &s.WorldID, &s.HabiticaPartyID, &s.Version, &s.ProfileSource, &flagged, &s.LeaseID, &s.LeaseClient, &s.LeaseSeen, &s.State.HP, &s.State.Mana, &s.State.Area, &s.State.Position.X, &s.State.Position.Y, &s.State.PlaySeconds, &s.State.Embers, &s.State.XPEmbers, &s.State.EmberXP, &s.Pending, &s.VerifiedXP, &checkpoint, &s.CheckpointAt, &s.LossReference.Level, &s.LossReference.XP, &s.LossAt, &s.VerifiedHighLevel, &s.ClassMark, &s.CheckpointLedgerID)
	if err != nil {
		return s, err
	}
	s.State.Inventory = []string{}
	s.State.Flags = []string{}
	quests, err := tx.QueryContext(ctx, "SELECT quest,step,reached_at,gate_at FROM quest_progress WHERE account_id=? ORDER BY quest", id)
	if err != nil {
		return s, err
	}
	for quests.Next() {
		var quest, step string
		var reached, gate int64
		if err = quests.Scan(&quest, &step, &reached, &gate); err != nil {
			quests.Close()
			return s, err
		}
		s.State.Quests[quest] = step
		s.State.ReachedAt[quest] = reached
		s.State.GateAt[quest] = gate
	}
	err = quests.Err()
	quests.Close()
	if err != nil {
		return s, err
	}
	marks, err := tx.QueryContext(ctx, "SELECT mark,writer FROM story_marks WHERE account_id=? ORDER BY at,mark", id)
	if err != nil {
		return s, err
	}
	for marks.Next() {
		var mark, writer string
		if err = marks.Scan(&mark, &writer); err != nil {
			marks.Close()
			return s, err
		}
		switch {
		case writer == "quest-item":
			s.State.Inventory = rules.AddUnique(s.State.Inventory, mark)
		case strings.HasPrefix(mark, "found:"):
			s.State.Discoveries = rules.AddUnique(s.State.Discoveries, strings.TrimPrefix(mark, "found:"))
		case strings.HasPrefix(mark, "defeated:"):
			s.State.DefeatedEnemies = rules.AddUnique(s.State.DefeatedEnemies, strings.TrimPrefix(mark, "defeated:"))
		default:
			s.State.Flags = rules.AddUnique(s.State.Flags, mark)
		}
	}
	err = marks.Err()
	marks.Close()
	if err != nil {
		return s, err
	}
	s.Flagged = flagged.Valid
	// The class mark keeps the game's own spellings (crafts.md 4.2): anything
	// Habitica-spelled reads through NormalizeClass at every intake.
	if c, ok := rules.NormalizeClass(s.ClassMark); ok {
		s.ClassMark = c
	} else {
		s.ClassMark = ""
	}
	if err = json.Unmarshal([]byte(checkpoint), &s.Checkpoint); err != nil {
		return s, err
	}
	s.ImportedProfile, err = profile.For(ctx, tx, profile.Account{ID: id, Source: s.ProfileSource})
	if err != nil {
		return s, err
	}
	s.VitalsSource = "demo"
	if s.ImportedProfile != nil {
		s.VitalsSource = "imported"
	}
	if p := s.ImportedProfile; p != nil {
		s.State.MaxHP = p.MaxHP
		s.State.MaxMana = p.MaxMP
	}
	rows, err := tx.QueryContext(ctx, "SELECT outcome_id FROM outcomes WHERE account_id=? ORDER BY at,outcome_id", id)
	if err != nil {
		return s, err
	}
	for rows.Next() {
		var v string
		if err = rows.Scan(&v); err != nil {
			rows.Close()
			return s, err
		}
		if rules.EconomyFlag(v) {
			s.State.Flags = rules.AddUnique(s.State.Flags, v)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return s, err
	}
	items, err := PackItems(ctx, tx, id)
	if err != nil {
		return s, err
	}
	for _, v := range items {
		s.State.Inventory = rules.AddUnique(s.State.Inventory, v)
	}
	err = recoverRoom(ctx, tx, &s)
	return s, err
}

func Persist(ctx context.Context, tx *sql.Tx, s *Snapshot, now int64) error {
	// Explicit refills also reset the watermark when the numeric value is unchanged.
	// Reports write their bounded values before Persist, preserving the server watermark.
	var hp, mana float64
	err := tx.QueryRowContext(ctx, "SELECT hp,mana FROM player_vitals WHERE account_id=?", s.AccountID).Scan(&hp, &mana)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	writeVitals := s.VitalsWritten || err == sql.ErrNoRows || hp != s.State.HP || mana != s.State.Mana
	if err := BumpVersion(ctx, tx, s); err != nil {
		return err
	}
	var p any
	if s.ImportedProfile != nil {
		p = JSON(s.ImportedProfile)
	}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{"UPDATE players SET last_seen_at=? WHERE account_id=?", []any{now, s.AccountID}},
		{"UPDATE balances SET embers=?,xp_embers=? WHERE account_id=?", []any{s.State.Embers, s.State.XPEmbers, s.AccountID}},
		{"UPDATE sync_baselines SET profile_json=?,xp_mark=?,pending=?,updated_at=? WHERE account_id=?", []any{p, s.State.EmberXP, s.Pending, now, s.AccountID}},
	} {
		if _, err := tx.ExecContext(ctx, q.sql, q.args...); err != nil {
			return err
		}
	}
	// Only server vitals writes advance the combat watermark and budget.
	if writeVitals {
		at := s.VitalsAt
		if at == 0 {
			at = float64(now)
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO player_vitals(account_id,hp,mana,vitals_at,vitals_set_version,cast_ready_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET hp=excluded.hp,mana=excluded.mana,vitals_at=excluded.vitals_at,vitals_set_version=excluded.vitals_set_version,cast_ready_at=MAX(player_vitals.cast_ready_at,excluded.cast_ready_at)`, s.AccountID, s.State.HP, s.State.Mana, at, s.Version, at); err != nil {
			return err
		}
	}
	placeVersion := int64(0)
	if s.PlaceWritten {
		placeVersion = s.Version
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO player_place(account_id,area,x,y,place_set_version) VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET area=excluded.area,x=excluded.x,y=excluded.y,place_set_version=MAX(player_place.place_set_version,excluded.place_set_version)`, s.AccountID, s.State.Area, s.State.Position.X, s.State.Position.Y, placeVersion); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE players SET play_seconds=? WHERE account_id=?", s.State.PlaySeconds, s.AccountID); err != nil {
		return err
	}
	for quest, step := range s.State.Quests {
		if _, err := tx.ExecContext(ctx, `INSERT INTO quest_progress(account_id,quest,step,reached_at,gate_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id,quest) DO UPDATE SET step=excluded.step,reached_at=excluded.reached_at,gate_at=excluded.gate_at`, s.AccountID, quest, step, s.State.ReachedAt[quest], s.State.GateAt[quest]); err != nil {
			return err
		}
	}
	for _, mark := range s.State.Flags {
		if rules.EconomyFlag(mark) {
			continue
		}
		writer := content.MarkWriter(mark)
		if writer == "" {
			return fmt.Errorf("unknown mark namespace %s", mark)
		}
		if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO story_marks VALUES(?,?,?,?)", s.AccountID, mark, writer, now); err != nil {
			return err
		}
	}
	for _, group := range []struct {
		items          []string
		prefix, writer string
	}{{questInventory(s.State.Inventory), "", "quest-item"}, {s.State.Discoveries, "found:", "client"}, {s.State.DefeatedEnemies, "defeated:", "client"}} {
		for _, id := range group.items {
			if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO story_marks VALUES(?,?,?,?)", s.AccountID, group.prefix+id, group.writer, now); err != nil {
				return err
			}
		}
	}
	return nil
}
