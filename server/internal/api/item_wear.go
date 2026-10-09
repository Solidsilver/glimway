package api

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/store"
	"slices"
)

func hasFitting(fittings []instanceRow, kind string) bool {
	return slices.ContainsFunc(fittings, func(f instanceRow) bool {
		d, _ := content.ItemFor(f.Def)
		return d.Fitting == kind
	})
}

// wearCost is the points one use takes off an ordinary tool: less with a
// Hold fitting. Warden-set tools dull by wardenWear instead.
func wearCost(fittings []instanceRow) int {
	w := content.ItemsRules.Rules.Wear
	if hasFitting(fittings, "hold") {
		return int(w.GetHoldPointsPerUse())
	}
	return int(w.GetPointsPerUse())
}

func max1(n int) int { return max(1, n) }

func usesLeft(condition, cost int) int {
	return (condition + cost - 1) / max1(cost)
}

// A warden-set tool dulls from sharp in rules.wear.wardenDullUses uses on
// every tool, half as fast with Hold. Dulling is counted in half-uses: a
// use takes two (one with Hold) out of 2×wardenDullUses, and condition is
// that count scaled onto the tool's points.
func wardenSteps() int { return 2 * int(content.ItemsRules.Rules.Wear.GetWardenDullUses()) }

func wardenStep(fittings []instanceRow) int {
	if hasFitting(fittings, "hold") {
		return 1
	}
	return 2
}

// wardenSpent: half-uses already spent at a condition (a partly healed
// tool rounds toward dull).
func wardenSpent(maxCond, condition int) int {
	steps := wardenSteps()
	used := maxCond - max(0, min(maxCond, condition))
	return min(steps, (used*steps+maxCond-1)/max1(maxCond))
}

func wardenCondition(maxCond, spent int) int {
	return maxCond - maxCond*spent/wardenSteps()
}

func wardenWear(maxCond, condition int, fittings []instanceRow) int {
	next := wardenCondition(maxCond, min(wardenSteps(), wardenSpent(maxCond, condition)+wardenStep(fittings)))
	// Every use takes at least a point while any are left.
	if next >= condition && condition > 0 {
		next = condition - 1
	}
	return max(0, next)
}

func wardenUsesLeft(maxCond, condition int, fittings []instanceRow) int {
	if condition <= 0 {
		return 0
	}
	step := wardenStep(fittings)
	return (wardenSteps() - wardenSpent(maxCond, condition) + step - 1) / step
}

type wearResult struct {
	Broke     bool          `json:"broke"`
	WoreOut   bool          `json:"woreOut"`
	State     string        `json:"state"`
	WornOut   []string      `json:"wornOut"`
	Instance  *instanceView `json:"instance"`
	Returned  []string      `json:"returned"`
	ItemDef   string        `json:"itemDef"`
	UsesLeft  int           `json:"usesLeft"`
	Condition int           `json:"condition"`
	MakerID   string        `json:"makerId,omitempty"`
}

// checkTool runs a tool use's checks without the wear — useTool's own
// checks, shared with the fishing rod's (design 5.4): the instance is the
// caller's in their pack, a tool with the action asked for, and it has a
// use left. The fittings come back for the wear that follows.
func checkTool(ctx context.Context, tx *sql.Tx, s *store.Snapshot, id, action string, now int64) (instanceRow, *content.ItemDef, []instanceRow, error) {
	if err := healWardens(ctx, tx, s.AccountID, now); err != nil {
		return instanceRow{}, nil, nil, err
	}
	v, err := loadInstance(ctx, tx, id)
	if err != nil {
		return v, nil, nil, err
	}
	def, _ := content.ItemFor(v.Def)
	if v.Location != "pack" || v.Owner != s.AccountID {
		return v, def, nil, fail(404, "item-not-found")
	}
	if def.GetKind() != "tool" {
		return v, def, nil, fail(409, "not-a-tool")
	}
	if action != "" && !slices.Contains(def.Actions, action) {
		return v, def, nil, fail(409, "wrong-tool")
	}
	if action == "draw" {
		// The well stands where the repairs data puts it (shared content).
		well, ok := content.RepairFor("well-rope")
		if !ok || !nearTile(s, well.Area, int(well.GetPos().GetTx()), int(well.GetPos().GetTy()), 4) {
			return v, def, nil, fail(409, "too-far-away")
		}
		var mendedAt sql.NullInt64
		err = tx.QueryRowContext(ctx, "SELECT mended_at FROM village_repairs WHERE world_id=? AND repair_id='well-rope'", s.WorldID).Scan(&mendedAt)
		if err == sql.ErrNoRows || !mendedAt.Valid {
			return v, def, nil, fail(409, "well-rope-broken")
		}
		if err != nil {
			return v, def, nil, err
		}
	}
	fittings, err := fittingRows(ctx, tx, v.ID)
	if err != nil {
		return v, def, nil, err
	}
	if v.Max > 0 && v.Condition == 0 && !hasFitting(fittings, "remember") {
		return v, def, nil, fail(409, "tool-blunt")
	}
	return v, def, fittings, nil
}

// useTool spends one use of a tool in the caller's pack. The use that
// reaches zero still happens; then a cheap tool breaks (its fittings drop
// into the pack) and an heirloom is blunt (or cracked) until mended. A
// warden-set tool only dulls. Fittings wear on their own count and fall
// away worn out; a warden-stone sliver never wears.
func useTool(ctx context.Context, tx *sql.Tx, s *store.Snapshot, id, action string, now int64) (wearResult, error) {
	out := wearResult{WornOut: []string{}, Returned: []string{}}
	v, def, fittings, err := checkTool(ctx, tx, s, id, action, now)
	out.MakerID = v.Maker
	out.ItemDef = v.Def
	if err != nil {
		return out, err
	}
	warden := hasFitting(fittings, "remember")
	conditionBeforeUse := v.Condition
	if v.Max > 0 {
		if warden {
			v.Condition = wardenWear(v.Max, v.Condition, fittings)
		} else {
			v.Condition = max(0, v.Condition-wearCost(fittings))
		}
		if _, err = tx.ExecContext(ctx, "UPDATE item_instances SET condition=?,worn_day=?,worn_at=? WHERE id=?", v.Condition, utcDay(now), now, v.ID); err != nil {
			return out, err
		}
	}
	// One draw is one bucket: a full stave bucket of well water.
	if action == "draw" {
		if err = itemChange(ctx, tx, s, "water", 1, "draw", v.ID, now); err != nil {
			return out, err
		}
	}
	// Fittings wear on their own.
	per := int(content.ItemsRules.Rules.Wear.GetPointsPerUse())
	for _, f := range fittings {
		if f.Max == 0 {
			continue
		}
		left := f.Condition - per
		if left > 0 {
			if _, err = tx.ExecContext(ctx, "UPDATE item_instances SET condition=? WHERE id=?", left, f.ID); err != nil {
				return out, err
			}
			continue
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM item_instances WHERE id=?", f.ID); err != nil {
			return out, err
		}
		if err = currency(ctx, tx, s.AccountID, "fitted:"+f.Def, -1, "fitting-worn", v.ID, now); err != nil {
			return out, err
		}
		out.WornOut = append(out.WornOut, f.Def)
	}
	if v.Max > 0 && v.Condition == 0 && !warden && content.ItemAtZeroRule(def) == "breaks" {
		// Broken and gone. Whatever was fitted drops into the pack.
		remaining, err := fittingRows(ctx, tx, v.ID)
		if err != nil {
			return out, err
		}
		for _, f := range remaining {
			if err = moveInstance(ctx, tx, f.ID, f.Def, instanceAt{"fitted", v.ID}, instanceAt{"pack", s.AccountID}, now); err != nil {
				return out, err
			}
			if err = currency(ctx, tx, s.AccountID, "fitted:"+f.Def, -1, "tool-broke", v.ID, now); err != nil {
				return out, err
			}
			if err = currency(ctx, tx, s.AccountID, content.StackCurrency(f.Def), 1, "tool-broke", v.ID, now); err != nil {
				return out, err
			}
			out.Returned = append(out.Returned, f.Def)
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM item_slots WHERE instance_id=?", v.ID); err != nil {
			return out, err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM item_instances WHERE id=?", v.ID); err != nil {
			return out, err
		}
		out.Broke = true
		out.State = "broken"
		return out, currency(ctx, tx, s.AccountID, content.StackCurrency(v.Def), -1, "tool-broke", v.ID, now)
	}
	out.WoreOut = conditionBeforeUse > 0 && v.Condition == 0 && !warden
	view, err := viewInstance(ctx, tx, v, map[string]*makerView{})
	if err != nil {
		return out, err
	}
	out.Instance = &view
	out.State = view.State
	out.UsesLeft = view.UsesLeft
	out.Condition = view.Condition
	return out, nil
}
