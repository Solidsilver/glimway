package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"glimway/content"
	"glimway/server/internal/store"
	"net/http"
)

// cottageHearth returns the homestead ID if the caller is a member of a
// homestead with Cottage tier (tier 1+): the doc's hearth rule.
func cottageHearth(ctx context.Context, tx *sql.Tx, s *store.Snapshot) (string, error) {
	home, ok, err := memberOf(ctx, tx, s.AccountID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fail(409, "not-a-member")
	}
	var tier int
	if err = tx.QueryRowContext(ctx, "SELECT tier FROM homesteads WHERE id=?", home).Scan(&tier); err != nil {
		return "", err
	}
	if tier < 1 {
		return "", fail(409, "tier-required")
	}
	return home, nil
}

// writingDeskPlaced checks that the player belongs to a homestead with a
// placed writing desk.
func writingDeskPlaced(ctx context.Context, tx *sql.Tx, s *store.Snapshot) (string, error) {
	home, ok, err := memberOf(ctx, tx, s.AccountID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fail(409, "not-a-member")
	}
	var placed bool
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM homestead_items WHERE homestead_id=? AND item_def='writing-desk' AND location='placed')", home).Scan(&placed); err != nil {
		return "", err
	}
	if !placed {
		return "", fail(409, "desk-required")
	}
	return home, nil
}

// woodpilePlaced checks that the player belongs to a homestead with a
// placed woodpile.
func woodpilePlaced(ctx context.Context, tx *sql.Tx, s *store.Snapshot) (string, error) {
	home, ok, err := memberOf(ctx, tx, s.AccountID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fail(409, "not-a-member")
	}
	var placed bool
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM homestead_items WHERE homestead_id=? AND item_def='woodpile' AND location='placed')", home).Scan(&placed); err != nil {
		return "", err
	}
	if !placed {
		return "", fail(409, "woodpile-required")
	}
	return home, nil
}

// hearthCraft makes consumables, remedies, oils and wax seals at the
// cottage hearth (membership in a tier 1+ homestead).
func (a *Server) hearthCraft(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		Key      string          `json:"key"`
		Progress json.RawMessage `json:"progress,omitempty"`
		RecipeID string          `json:"recipeId"`
		Qty      int             `json:"qty"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	return a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := settleHomes(ctx, tx, s.WorldID, now); err != nil {
			return nil, err
		}
		if _, err := cottageHearth(ctx, tx, s); err != nil {
			return nil, err
		}
		recipe, ok := content.HearthRecipeFor(req.RecipeID)
		if !ok {
			return nil, fail(400, "invalid-recipe")
		}
		// A found recipe is only known once its page is held (the doc's
		// "Recipe source" column; starting recipes need no page).
		if recipe.Page != "" {
			held, err := stackTotal(ctx, tx, packOf(s.AccountID), recipe.Page)
			if err != nil {
				return nil, err
			}
			if held <= 0 {
				return nil, fail(409, "recipe-unknown")
			}
		}
		if req.Qty < 1 || req.Qty > 100 {
			return nil, fail(400, "invalid-quantity")
		}
		// Bloom flowers in the pack dry once their wick has turned.
		if err := dryFlowers(ctx, tx, s, now); err != nil {
			return nil, err
		}
		if err := checkMaterialsAny(ctx, tx, s.AccountID, scaled(recipe.Materials, req.Qty), recipe.Swaps); err != nil {
			return nil, err
		}
		if err := debitMaterialsAny(ctx, tx, s, recipe.Materials, recipe.Swaps, req.Qty, "hearth", recipe.ID, now); err != nil {
			return nil, err
		}
		output := recipe.Output
		output.Qty *= req.Qty
		def, ok := content.ItemFor(output.ID)
		maker := ""
		if ok && def.Marked {
			maker = s.AccountID
		}
		if err := packPut(ctx, tx, s.AccountID, output.ID, []makerQty{{Maker: maker, Qty: output.Qty}}, "hearth", recipe.ID, now); err != nil {
			return nil, err
		}
		if err := refreshItems(ctx, tx, s); err != nil {
			return nil, err
		}
		v, err := readWorkshop(ctx, tx, s, now)
		if err != nil {
			return nil, err
		}
		return struct {
			workshopView
			RecipeID string        `json:"recipeId"`
			Output   content.Asset `json:"output"`
		}{v, recipe.ID, output}, nil
	})
}

// deskCopy copies any recipe page the player holds using 1 fiber per copy,
// bearing the player's maker's mark.
func (a *Server) deskCopy(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		Key      string          `json:"key"`
		Progress json.RawMessage `json:"progress,omitempty"`
		PageID   string          `json:"pageId"`
		Qty      int             `json:"qty"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	return a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := settleHomes(ctx, tx, s.WorldID, now); err != nil {
			return nil, err
		}
		if _, err := writingDeskPlaced(ctx, tx, s); err != nil {
			return nil, err
		}
		if req.Qty < 1 || req.Qty > 100 {
			return nil, fail(400, "invalid-quantity")
		}
		def, ok := content.ItemFor(req.PageID)
		if !ok || def.Kind != "paper" {
			return nil, fail(400, "invalid-page")
		}
		held, err := stackTotal(ctx, tx, packOf(s.AccountID), req.PageID)
		if err != nil {
			return nil, err
		}
		if held <= 0 {
			return nil, fail(409, "page-not-held")
		}
		cost := map[string]int{"fiber": 1}
		if err := checkMaterials(ctx, tx, s.AccountID, scaled(cost, req.Qty)); err != nil {
			return nil, err
		}
		if err := debitMaterials(ctx, tx, s, cost, req.Qty, "desk", req.PageID, now); err != nil {
			return nil, err
		}
		// Maker's mark carries player's ID
		maker := s.AccountID
		if err := packPut(ctx, tx, s.AccountID, req.PageID, []makerQty{{Maker: maker, Qty: req.Qty}}, "desk", req.PageID, now); err != nil {
			return nil, err
		}
		if err := refreshItems(ctx, tx, s); err != nil {
			return nil, err
		}
		v, err := readWorkshop(ctx, tx, s, now)
		if err != nil {
			return nil, err
		}
		return struct {
			workshopView
			PageID string `json:"pageId"`
			Qty    int    `json:"qty"`
		}{v, req.PageID, req.Qty}, nil
	})
}

type woodpileStackView struct {
	ID          string `json:"id"`
	HomesteadID string `json:"homesteadId"`
	AccountID   string `json:"accountId"`
	Qty         int    `json:"qty"`
	StackedAt   int64  `json:"stackedAt"`
	Ready       bool   `json:"ready"`
	Remaining   int64  `json:"remaining"`
}

// woodpileCurrency is the ledger currency for timber on a woodpile: +n on
// the stacker's ledger, −n on the collector's, −n written off when the deed
// is lost — so the pile's timber is visible in the ledger the way the shared
// chest's storage:<kind>:<id> currencies are.
const woodpileCurrency = "woodpile:material:timber"

type woodpileView struct {
	HomesteadID string              `json:"homesteadId"`
	Placed      bool                `json:"placed"`
	Stacks      []woodpileStackView `json:"stacks"`
	ReadyCount  int                 `json:"readyCount"`
	TotalTimber int                 `json:"totalTimber"`
}

func readWoodpile(ctx context.Context, tx *sql.Tx, homeID string, now int64) (woodpileView, error) {
	v := woodpileView{HomesteadID: homeID, Stacks: []woodpileStackView{}}
	var placed bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM homestead_items WHERE homestead_id=? AND item_def='woodpile' AND location='placed')", homeID).Scan(&placed); err != nil {
		return v, err
	}
	v.Placed = placed
	rows, err := tx.QueryContext(ctx, "SELECT id, homestead_id, account_id, qty, stacked_at FROM woodpile_stacks WHERE homestead_id=? ORDER BY stacked_at ASC", homeID)
	if err != nil {
		return v, err
	}
	defer rows.Close()
	for rows.Next() {
		var st woodpileStackView
		if err := rows.Scan(&st.ID, &st.HomesteadID, &st.AccountID, &st.Qty, &st.StackedAt); err != nil {
			return v, err
		}
		rem := int64(86400) - (now - st.StackedAt)
		if rem <= 0 {
			st.Ready = true
			st.Remaining = 0
			v.ReadyCount += st.Qty
		} else {
			st.Ready = false
			st.Remaining = rem
		}
		v.TotalTimber += st.Qty
		v.Stacks = append(v.Stacks, st)
	}
	return v, rows.Err()
}

func (a *Server) woodpileRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := a.Config.Now().Unix()
	if err = settleHomes(r.Context(), tx, s.WorldID, now); err != nil {
		return err
	}
	homeID, ok, err := memberOf(r.Context(), tx, s.AccountID)
	if err != nil {
		return err
	}
	if !ok {
		return fail(409, "not-a-member")
	}
	wv, err := readWoodpile(r.Context(), tx, homeID, now)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Woodpile woodpileView `json:"woodpile"`
	}{s, wv})
}

func (a *Server) woodpileMutation(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		Key      string          `json:"key"`
		Progress json.RawMessage `json:"progress,omitempty"`
		Action   string          `json:"action"` // "stack" or "collect"
		Qty      int             `json:"qty,omitempty"`
		StackID  string          `json:"stackId,omitempty"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	return a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := settleHomes(ctx, tx, s.WorldID, now); err != nil {
			return nil, err
		}
		homeID, err := woodpilePlaced(ctx, tx, s)
		if err != nil {
			return nil, err
		}
		var collectedQty int
		switch req.Action {
		case "stack":
			if req.Qty < 1 || req.Qty > 1000 {
				return nil, fail(400, "invalid-quantity")
			}
			if err := checkMaterials(ctx, tx, s.AccountID, map[string]int{"timber": req.Qty}); err != nil {
				return nil, err
			}
			if err := debitMaterials(ctx, tx, s, map[string]int{"timber": 1}, req.Qty, "woodpile:stack", homeID, now); err != nil {
				return nil, err
			}
			id, err := store.Random()
			if err != nil {
				return nil, err
			}
			if _, err := tx.ExecContext(ctx, "INSERT INTO woodpile_stacks(id, homestead_id, account_id, qty, stacked_at) VALUES(?, ?, ?, ?, ?)", id, homeID, s.AccountID, req.Qty, now); err != nil {
				return nil, err
			}
			// The pile's own currency, so the ledger can see the timber on
			// it (as the shared chest's storage:<kind>:<id> does).
			if err := currency(ctx, tx, s.AccountID, woodpileCurrency, req.Qty, "woodpile:stack", homeID, now); err != nil {
				return nil, err
			}
		case "collect":
			var rows *sql.Rows
			if req.StackID != "" {
				rows, err = tx.QueryContext(ctx, "SELECT id, qty FROM woodpile_stacks WHERE homestead_id=? AND id=? AND (?-stacked_at) >= 86400", homeID, req.StackID, now)
			} else {
				rows, err = tx.QueryContext(ctx, "SELECT id, qty FROM woodpile_stacks WHERE homestead_id=? AND (?-stacked_at) >= 86400", homeID, now)
			}
			if err != nil {
				return nil, err
			}
			var ids []string
			for rows.Next() {
				var id string
				var q int
				if err := rows.Scan(&id, &q); err != nil {
					rows.Close()
					return nil, err
				}
				ids = append(ids, id)
				collectedQty += q
			}
			rows.Close()
			if len(ids) == 0 {
				return nil, fail(409, "nothing-ready")
			}
			for _, id := range ids {
				if _, err := tx.ExecContext(ctx, "DELETE FROM woodpile_stacks WHERE id=?", id); err != nil {
					return nil, err
				}
			}
			// Whatever stacks came out, the collector takes them off the pile.
			if err := currency(ctx, tx, s.AccountID, woodpileCurrency, -collectedQty, "woodpile:collect", homeID, now); err != nil {
				return nil, err
			}
			if err := packPut(ctx, tx, s.AccountID, "seasoned-timber", []makerQty{{Maker: "", Qty: collectedQty}}, "woodpile:collect", homeID, now); err != nil {
				return nil, err
			}
			if err := refreshItems(ctx, tx, s); err != nil {
				return nil, err
			}
		default:
			return nil, fail(400, "invalid-action")
		}
		wv, err := readWoodpile(ctx, tx, homeID, now)
		if err != nil {
			return nil, err
		}
		wv2, err := readWorkshop(ctx, tx, s, now)
		if err != nil {
			return nil, err
		}
		return struct {
			workshopView
			Woodpile     woodpileView `json:"woodpile"`
			Action       string       `json:"action"`
			CollectedQty int          `json:"collectedQty,omitempty"`
		}{wv2, wv, req.Action, collectedQty}, nil
	})
}
