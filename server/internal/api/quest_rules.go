package api

import (
	"context"
	"database/sql"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"slices"
	"strings"
)

func questMark(s *store.Snapshot, mark string) {
	switch {
	case strings.HasPrefix(mark, "quest-item:"):
		s.State.Inventory = rules.AddUnique(s.State.Inventory, strings.TrimPrefix(mark, "quest-item:"))
	case strings.HasPrefix(mark, "found:"):
		s.State.Discoveries = rules.AddUnique(s.State.Discoveries, strings.TrimPrefix(mark, "found:"))
	case strings.HasPrefix(mark, "defeated:"):
		s.State.DefeatedEnemies = rules.AddUnique(s.State.DefeatedEnemies, strings.TrimPrefix(mark, "defeated:"))
	default:
		s.State.Flags = rules.AddUnique(s.State.Flags, mark)
	}
}
func questHasMark(s *store.Snapshot, mark string) bool {
	if strings.HasPrefix(mark, "quest-item:") {
		return slices.Contains(s.State.Inventory, strings.TrimPrefix(mark, "quest-item:"))
	}
	if strings.HasPrefix(mark, "found:") {
		return slices.Contains(s.State.Discoveries, strings.TrimPrefix(mark, "found:"))
	}
	if strings.HasPrefix(mark, "defeated:") {
		return slices.Contains(s.State.DefeatedEnemies, strings.TrimPrefix(mark, "defeated:"))
	}
	return slices.Contains(s.State.Flags, mark)
}
func questPrerequisites(s store.Snapshot, q content.Quest) error {
	for _, ref := range q.After {
		quest, step, part := strings.Cut(ref, ":")
		other, ok := content.QuestFor(quest)
		if !ok {
			return fail(409, "not-next-step")
		}
		if !part {
			step = other.Steps[len(other.Steps)-1].ID
		}
		if content.QuestIndex(quest, s.State.Quests[quest]) < content.QuestIndex(quest, step) {
			return fail(409, "not-next-step")
		}
	}
	if q.Needs == "habitica" && s.ProfileSource != "habitica" {
		return fail(409, "needs-habitica")
	}
	return nil
}

// with checks areas only, as talks do; seller reach additionally checks a tile.
func personHere(id, area string, now int64) bool {
	if resident, ok := content.ResidentByID(id); ok {
		for _, spot := range content.CycleSpotsNear(resident, float64(now), int(content.ResidentRules.GetGraceSeconds())) {
			if resident.Spots[spot].Area == area {
				return true
			}
		}
		return false
	}
	return content.StoryRules.NPCs[id] == area
}
func questTrigger(ctx context.Context, tx *sql.Tx, s *store.Snapshot, quest string, step content.QuestStep, now int64) error {
	t := step.Do
	if t == nil {
		return fail(409, "not-next-step")
	}
	switch {
	case t.Talk != "":
		if !personHere(t.Talk, s.State.Area, now) {
			return fail(409, "not-here")
		}
	case t.Use != "":
		if s.State.Area != content.QuestSpotArea(t.Use) {
			return fail(409, "wrong-area")
		}
	case t.Reach != "":
		if s.State.Area != t.Reach {
			return fail(409, "wrong-area")
		}
	case t.Defeat != "":
		if !questHasMark(s, "defeated:"+t.Defeat) {
			return fail(409, "not-next-step")
		}
	case t.Carry != "":
		if slices.Contains(content.StoryRules.QuestItems, t.Carry) {
			if !questHasMark(s, "quest-item:"+t.Carry) {
				return fail(409, "short")
			}
		} else {
			n, err := questItemCount(ctx, tx, s.AccountID, t.Carry)
			if err != nil {
				return err
			}
			if n < 1 {
				return fail(409, "short")
			}
		}
	case t.Flag != "":
		if !questHasMark(s, t.Flag) {
			return fail(409, "not-next-step")
		}
	case t.Sync != "":
		var credited bool
		err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ledger WHERE account_id=? AND currency='embers' AND reason='sync' AND delta>0 AND created_at>?)`, s.AccountID, s.State.ReachedAt[quest]).Scan(&credited)
		if err != nil {
			return err
		}
		if !credited {
			return fail(409, "not-next-step")
		}
		// Opening the journal has no server-observable predicate.
	}
	return nil
}
func checkQuestGate(ctx context.Context, tx *sql.Tx, s *store.Snapshot, quest string, step content.QuestStep, now int64) error {
	g := step.Gate
	if g == nil {
		return nil
	}
	if g.With != "" && !personHere(g.With, s.State.Area, now) {
		return fail(409, "not-here")
	}
	if wait := g.Wait; wait != nil {
		at, ok := s.State.GateAt[quest]
		if !ok {
			return fail(409, "not-yet")
		}
		if !content.QuestWaitReady(*wait, at, now) {
			return fail(409, "not-yet")
		}
	}
	if item := g.Item; item != nil {
		n, err := questItemCount(ctx, tx, s.AccountID, item.Def)
		if err != nil {
			return err
		}
		if n < item.Qty {
			return fail(409, "short")
		}
	}
	if int(g.Embers) > 0 {
		if s.State.Embers < int(g.Embers) {
			return fail(409, "short")
		}
		if s.State.HP <= 0 && s.ProfileSource == "habitica" && s.State.XPEmbers < int(g.Embers) {
			return fail(409, "needs-earned")
		}
	}
	return nil
}
func spendQuestGate(ctx context.Context, tx *sql.Tx, s *store.Snapshot, quest string, step content.QuestStep, now int64, out *contract.QuestStepResult) error {
	g := step.Gate
	if g == nil {
		return nil
	}
	ref := quest + ":" + step.ID
	if item := g.Item; item != nil && item.Keep != nil && !*item.Keep {
		if err := questTake(ctx, tx, s, item.Def, item.Qty, ref, now); err != nil {
			return err
		}
		out.Taken = append(out.Taken, &contract.ItemQty{Def: item.Def, Qty: float64(item.Qty)})
	}
	if int(g.Embers) > 0 {
		earned := max(0, int(g.Embers)-(s.State.Embers-s.State.XPEmbers))
		if s.State.HP <= 0 && s.ProfileSource == "habitica" {
			earned = int(g.Embers)
		}
		if err := store.Credit(ctx, tx, s, -int(g.Embers), -earned, "quest", ref, nil, now); err != nil {
			return err
		}
		out.EmbersSpent = float64(int(g.Embers))
	}
	return nil
}
func questItemCount(ctx context.Context, tx *sql.Tx, account, def string) (int, error) {
	d, ok := content.ItemFor(def)
	if !ok {
		return 0, nil
	}
	if !content.ItemInstanced(d) {
		return stackTotal(ctx, tx, packOf(account), def)
	}
	var count int
	err := tx.QueryRowContext(ctx, "SELECT count(*) FROM item_instances WHERE location='pack' AND owner=? AND item_def=?", account, def).Scan(&count)
	return count, err
}

// Instanced items spend through the same movement/ledger helpers as transfers;
// fittings return to the pack before their parent instance is consumed.
func questTake(ctx context.Context, tx *sql.Tx, s *store.Snapshot, def string, qty int, ref string, now int64) error {
	d, _ := content.ItemFor(def)
	if !content.ItemInstanced(d) {
		_, err := packTake(ctx, tx, s.AccountID, def, nil, qty, "quest", ref, now)
		if err != nil {
			return err
		}
		return refreshItems(ctx, tx, s)
	}
	rows, err := tx.QueryContext(ctx, "SELECT id FROM item_instances WHERE location='pack' AND owner=? AND item_def=? ORDER BY id LIMIT ?", s.AccountID, def, qty)
	if err != nil {
		return err
	}
	ids := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		ids = append(ids, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	if len(ids) != qty {
		return fail(409, "short")
	}
	for _, id := range ids {
		fittings, err := fittingRows(ctx, tx, id)
		if err != nil {
			return err
		}
		for _, f := range fittings {
			if err = moveInstance(ctx, tx, f.ID, f.Def, instanceAt{"fitted", id}, instanceAt{"pack", s.AccountID}, now); err != nil {
				return err
			}
			if err = currency(ctx, tx, s.AccountID, "fitted:"+f.Def, -1, "quest", ref, now); err != nil {
				return err
			}
			if err = currency(ctx, tx, s.AccountID, content.StackCurrency(f.Def), 1, "quest", ref, now); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM item_slots WHERE instance_id=?", id); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM item_instances WHERE id=?", id); err != nil {
			return err
		}
		if err = currency(ctx, tx, s.AccountID, content.StackCurrency(def), -1, "quest", ref, now); err != nil {
			return err
		}
	}
	return refreshItems(ctx, tx, s)
}
func questGive(ctx context.Context, tx *sql.Tx, s *store.Snapshot, item content.QuestItem, ref string, now int64) error {
	d, _ := content.ItemFor(item.Def)
	if !content.ItemInstanced(d) {
		return itemChange(ctx, tx, s, item.Def, item.Qty, "quest", ref, now)
	}
	for i := 0; i < item.Qty; i++ {
		if _, err := newInstance(ctx, tx, d, instanceAt{"pack", s.AccountID}, "", -1, now); err != nil {
			return err
		}
	}
	return currency(ctx, tx, s.AccountID, content.StackCurrency(item.Def), item.Qty, "quest", ref, now)
}
