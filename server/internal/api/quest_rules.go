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
func questPrerequisites(s store.Snapshot, q *content.Quest) error {
	for _, ref := range q.GetAfter() {
		quest, step, part := strings.Cut(ref, ":")
		other, ok := content.QuestFor(quest)
		if !ok {
			return fail(409, "not-next-step")
		}
		if !part {
			step = other.GetSteps()[len(other.GetSteps())-1].GetId()
		}
		if content.QuestIndex(quest, s.State.Quests[quest]) < content.QuestIndex(quest, step) {
			return fail(409, "not-next-step")
		}
	}
	if q.GetNeeds() == "habitica" && s.ProfileSource != "habitica" {
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
	return content.StoryRules.GetNpcs()[id] == area
}
func questTrigger(ctx context.Context, tx *sql.Tx, s *store.Snapshot, quest string, step *content.QuestStep, now int64) error {
	t := step.GetDo()
	if t == nil {
		return fail(409, "not-next-step")
	}
	switch {
	case t.GetTalk() != "":
		if !personHere(t.GetTalk(), s.State.Area, now) {
			return fail(409, "not-here")
		}
	case t.GetUse() != "":
		if s.State.Area != content.QuestSpotArea(t.GetUse()) {
			return fail(409, "wrong-area")
		}
	case t.GetReach() != "":
		if s.State.Area != t.GetReach() {
			return fail(409, "wrong-area")
		}
	case t.GetDefeat() != "":
		if !questHasMark(s, "defeated:"+t.GetDefeat()) {
			return fail(409, "not-next-step")
		}
	case t.GetCarry() != "":
		if slices.Contains(content.StoryRules.GetQuestItems(), t.GetCarry()) {
			if !questHasMark(s, "quest-item:"+t.GetCarry()) {
				return fail(409, "short")
			}
		} else {
			n, err := questItemCount(ctx, tx, s.AccountID, t.GetCarry())
			if err != nil {
				return err
			}
			if n < 1 {
				return fail(409, "short")
			}
		}
	case t.GetFlag() != "":
		if !questHasMark(s, t.GetFlag()) {
			return fail(409, "not-next-step")
		}
	case t.GetSync() != "":
		var credited bool
		err := tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM ledger WHERE account_id=? AND currency='glims' AND reason='sync' AND delta>0 AND created_at>?)`, s.AccountID, s.State.ReachedAt[quest]).Scan(&credited)
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
func checkQuestGate(ctx context.Context, tx *sql.Tx, s *store.Snapshot, quest string, step *content.QuestStep, now int64) error {
	g := step.GetGate()
	if g == nil {
		return nil
	}
	if g.GetWith() != "" && !personHere(g.GetWith(), s.State.Area, now) {
		return fail(409, "not-here")
	}
	if wait := g.GetWait(); wait != nil {
		at, ok := s.State.GateAt[quest]
		if !ok {
			return fail(409, "not-yet")
		}
		if !content.QuestWaitReady(wait, at, now) {
			return fail(409, "not-yet")
		}
	}
	if item := g.GetItem(); item != nil {
		n, err := questItemCount(ctx, tx, s.AccountID, item.GetDef())
		if err != nil {
			return err
		}
		if n < int(item.GetQty()) {
			return fail(409, "short")
		}
	}
	if g.GetGlims() > 0 {
		if s.State.Glims < int(g.GetGlims()) {
			return fail(409, "short")
		}
		if s.State.HP <= 0 && s.ProfileSource == "habitica" && s.State.XPGlims < int(g.GetGlims()) {
			return fail(409, "needs-earned")
		}
	}
	return nil
}
func spendQuestGate(ctx context.Context, tx *sql.Tx, s *store.Snapshot, quest string, step *content.QuestStep, now int64, out *contract.QuestStepResult) error {
	g := step.GetGate()
	if g == nil {
		return nil
	}
	ref := quest + ":" + step.GetId()
	if item := g.GetItem(); item != nil && item.Keep != nil && !*item.Keep {
		if err := questTake(ctx, tx, s, item.GetDef(), int(item.GetQty()), ref, now); err != nil {
			return err
		}
		out.Taken = append(out.Taken, &contract.ItemQty{Def: item.GetDef(), Qty: float64(item.GetQty())})
	}
	if g.GetGlims() > 0 {
		earned := max(0, int(g.GetGlims())-(s.State.Glims-s.State.XPGlims))
		if s.State.HP <= 0 && s.ProfileSource == "habitica" {
			earned = int(g.GetGlims())
		}
		if err := store.Credit(ctx, tx, s, -int(g.GetGlims()), -earned, "quest", ref, nil, now); err != nil {
			return err
		}
		out.GlimsSpent = float64(g.GetGlims())
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
func questGive(ctx context.Context, tx *sql.Tx, s *store.Snapshot, item *content.QuestItem, ref string, now int64) error {
	d, _ := content.ItemFor(item.Def)
	if !content.ItemInstanced(d) {
		return itemChange(ctx, tx, s, item.GetDef(), int(item.GetQty()), "quest", ref, now)
	}
	for i := 0; i < int(item.GetQty()); i++ {
		if _, err := newInstance(ctx, tx, d, instanceAt{"pack", s.AccountID}, "", -1, now); err != nil {
			return err
		}
	}
	return currency(ctx, tx, s.AccountID, content.StackCurrency(item.GetDef()), int(item.GetQty()), "quest", ref, now)
}
