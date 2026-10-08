package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"glimway/content"
	"glimway/server/internal/profile"
	"glimway/server/internal/rules"
	"math"
	"slices"
	"strings"
	"time"
)

// Documents are consulted once. Unknown namespaces abort the entire upgrade.
func moveStory028(tx *sql.Tx) error {
	type saved struct {
		id, doc string
		at      int64
	}
	var savedRows []saved
	rows, err := tx.Query("SELECT account_id,doc_json,updated_at FROM progress")
	if err != nil {
		return err
	}
	for rows.Next() {
		var r saved
		if err = rows.Scan(&r.id, &r.doc, &r.at); err != nil {
			rows.Close()
			return err
		}
		savedRows = append(savedRows, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	ctx := context.Background()
	for _, r := range savedRows {
		if err = func() (err error) {
			defer func() {
				if err != nil {
					err = fmt.Errorf("account %s: %w", r.id, err)
				}
			}()
			state := rules.NewState()
			if err = json.Unmarshal([]byte(r.doc), &state); err != nil {
				return fmt.Errorf("bad story JSON: %w", err)
			}
			if content.QuestIndex(state.Quest) < -1 {
				return fmt.Errorf("unknown quest stage %s", state.Quest)
			}
			if state.Quest != "new" {
				if _, err = tx.Exec("INSERT INTO quest_progress VALUES(?,'lantern-road',?)", r.id, state.Quest); err != nil {
					return err
				}
			}
			add := func(mark, writer string) error {
				_, e := tx.Exec("INSERT OR IGNORE INTO story_marks VALUES(?,?,?,?)", r.id, mark, writer, r.at)
				return e
			}
			for _, f := range state.Flags {
				writer := content.MarkWriter(f)
				if writer == "" {
					return fmt.Errorf("unknown flag namespace: %s", f)
				}
				if rules.EconomyFlag(f) {
					continue
				}
				if err = add(f, writer); err != nil {
					return err
				}
			}
			for _, id := range state.Discoveries {
				if err = add("found:"+id, "client"); err != nil {
					return err
				}
			}
			for _, id := range state.DefeatedEnemies {
				if err = add("defeated:"+id, "client"); err != nil {
					return err
				}
			}
			for _, id := range state.Inventory {
				if slices.Contains(rules.QuestItems, id) {
					if err = add(id, "quest-item"); err != nil {
						return err
					}
				}
			}
			switch {
			case state.Area == "wilds" || strings.HasPrefix(state.Area, "wilds:"):
				state.Area = "commons"
				// Tangle arch: src/game/commons.ts COMMONS_FROM_WILDS.
				state.Position = rules.Position{X: 23*16 + 8, Y: 2*16 + 8}
			case !slices.Contains([]string{"village", "woodland", "ruin", "commons"}, state.Area):
				gate := rules.HomeGate(state.Area)
				var valid int
				if gate >= 0 {
					if err = tx.QueryRow("SELECT count(*) FROM homesteads WHERE gate=? AND world_id=(SELECT world_id FROM players WHERE account_id=?)", gate, r.id).Scan(&valid); err != nil {
						return err
					}
				}
				if valid == 0 {
					state.Area = "village"
					state.Position = rules.NewState().Position
				}
			}
			s := Snapshot{AccountID: r.id}
			if err = BumpVersion(ctx, tx, &s); err != nil {
				return err
			}
			var source string
			if err = tx.QueryRow("SELECT profile_source FROM players WHERE account_id=?", r.id).Scan(&source); err != nil {
				return err
			}
			p, e := profile.For(ctx, tx, profile.Account{ID: r.id, Source: source})
			if e != nil {
				return e
			}
			maxHP, maxMP := rules.NewState().MaxHP, rules.NewState().MaxMana
			if p != nil {
				maxHP, maxMP = p.MaxHP, p.MaxMP
			}
			now := float64(time.Now().UnixNano()) / 1e9
			if _, err = tx.Exec("UPDATE player_vitals SET hp=?,mana=?,vitals_at=?,vitals_set_version=?,cast_ready_at=MAX(cast_ready_at,?) WHERE account_id=?", math.Max(0, math.Min(state.HP, maxHP)), math.Max(0, math.Min(state.Mana, maxMP)), now, s.Version, now, r.id); err != nil {
				return err
			}
			if _, err = tx.Exec("UPDATE players SET play_seconds=? WHERE account_id=?", state.PlaySeconds, r.id); err != nil {
				return err
			}
			if _, err = tx.Exec("UPDATE player_place SET area=?,x=?,y=?,place_set_version=?,last_outer_epoch='',last_outer_starts_at=NULL WHERE account_id=?", state.Area, state.Position.X, state.Position.Y, s.Version, r.id); err != nil {
				return err
			}
			return nil
		}(); err != nil {
			return err
		}
	}

	for _, g := range []struct{ old, new string }{{"quest-gift:defeat-guardian", "quest-gift:lantern-road:guardian-defeated"}, {"quest-gift:return-village", "quest-gift:lantern-road:complete"}} {
		if _, err = tx.Exec("UPDATE OR IGNORE outcomes SET outcome_id=? WHERE outcome_id=?", g.new, g.old); err != nil {
			return err
		}
		if _, err = tx.Exec("DELETE FROM outcomes WHERE outcome_id=?", g.old); err != nil {
			return err
		}
	}
	_, err = tx.Exec("DROP TABLE progress")
	return err
}
