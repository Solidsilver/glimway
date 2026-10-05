package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/store"
	"net/http"
)

type workshopView struct {
	Home      homeView    `json:"home"`
	Inventory assetCounts `json:"inventory"`
	Storage   assetCounts `json:"storage"`
}

func readWorkshop(ctx context.Context, tx *sql.Tx, id string) (workshopView, error) {
	var v workshopView
	var err error
	v.Home, err = loadHome(ctx, tx, id)
	if err != nil {
		return v, err
	}
	v.Inventory, err = counts(ctx, tx, id, false)
	if err != nil {
		return v, err
	}
	v.Storage, err = counts(ctx, tx, id, true)
	return v, err
}
func (a *Server) storageRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if s.SaveOrigin == nil {
		return fail(409, "origin-required")
	}
	if err = workshop(r.Context(), tx, &s, a.Config.Now().Unix()); err != nil {
		return err
	}
	v, err := readWorkshop(r.Context(), tx, s.HabiticaID)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		workshopView
	}{s, v})
}
func (a *Server) storageMutation(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		Key       string          `json:"key"`
		Progress  json.RawMessage `json:"progress,omitempty"`
		Direction string          `json:"direction"`
		Asset     content.Asset   `json:"asset"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	return a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := workshop(ctx, tx, s, now); err != nil {
			return nil, err
		}
		v := req.Asset
		if err := validAsset(v); err != nil {
			return nil, err
		}
		switch req.Direction {
		case "deposit":
			if _, err := takeAsset(ctx, tx, s, v, "storage", "storage-deposit", req.Key, now); err != nil {
				return nil, err
			}
			if v.Kind != "decoration" {
				if _, err := tx.ExecContext(ctx, "INSERT INTO home_storage VALUES(?,?,?,?) ON CONFLICT(habitica_id,kind,item_def) DO UPDATE SET qty=qty+excluded.qty", s.HabiticaID, v.Kind, v.ID, v.Qty); err != nil {
					return nil, err
				}
			}
			if err := currency(ctx, tx, s.HabiticaID, "storage:"+v.Kind+":"+v.ID, v.Qty, "storage-deposit", req.Key, now); err != nil {
				return nil, err
			}
		case "withdraw":
			ids := []string{}
			if v.Kind == "decoration" {
				var err error
				ids, err = decorationIDs(ctx, tx, s.HabiticaID, v.ID, "storage", v.Qty)
				if err != nil {
					return nil, err
				}
			} else {
				var n int
				err := tx.QueryRowContext(ctx, "SELECT qty FROM home_storage WHERE habitica_id=? AND kind=? AND item_def=?", s.HabiticaID, v.Kind, v.ID).Scan(&n)
				if err != nil && err != sql.ErrNoRows {
					return nil, err
				}
				if n < v.Qty {
					return nil, fail(409, "insufficient-storage")
				}
				if n == v.Qty {
					_, err = tx.ExecContext(ctx, "DELETE FROM home_storage WHERE habitica_id=? AND kind=? AND item_def=?", s.HabiticaID, v.Kind, v.ID)
				} else {
					_, err = tx.ExecContext(ctx, "UPDATE home_storage SET qty=qty-? WHERE habitica_id=? AND kind=? AND item_def=?", v.Qty, s.HabiticaID, v.Kind, v.ID)
				}
				if err != nil {
					return nil, err
				}
			}
			if err := giveAsset(ctx, tx, s, v, ids, s.HabiticaID, "storage", "storage-withdraw", req.Key, now); err != nil {
				return nil, err
			}
			if err := currency(ctx, tx, s.HabiticaID, "storage:"+v.Kind+":"+v.ID, -v.Qty, "storage-withdraw", req.Key, now); err != nil {
				return nil, err
			}
		default:
			return nil, fail(400, "invalid-direction")
		}
		return readWorkshop(ctx, tx, s.HabiticaID)
	})
}
func (a *Server) craft(w http.ResponseWriter, r *http.Request) error {
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
		if err := workshop(ctx, tx, s, now); err != nil {
			return nil, err
		}
		recipe, ok := content.RecipeFor(req.RecipeID)
		if !ok {
			return nil, fail(400, "invalid-recipe")
		}
		if req.Qty < 1 || req.Qty > 100 {
			return nil, fail(400, "invalid-quantity")
		}
		if err := debitMaterials(ctx, tx, s, recipe.Materials, req.Qty, "craft", recipe.ID, now); err != nil {
			return nil, err
		}
		output := recipe.Output
		output.Qty *= req.Qty
		ids := []string{}
		if output.Kind == "item" {
			if err := itemChange(ctx, tx, s, output.ID, output.Qty, "craft", recipe.ID, now); err != nil {
				return nil, err
			}
		} else {
			for i := 0; i < output.Qty; i++ {
				id, err := store.Random()
				if err != nil {
					return nil, err
				}
				if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_items(id,habitica_id,item_def) VALUES(?,?,?)", id, s.HabiticaID, output.ID); err != nil {
					return nil, err
				}
				ids = append(ids, id)
			}
			if err := currency(ctx, tx, s.HabiticaID, "decoration:"+output.ID, output.Qty, "craft", recipe.ID, now); err != nil {
				return nil, err
			}
		}
		v, err := readWorkshop(ctx, tx, s.HabiticaID)
		if err != nil {
			return nil, err
		}
		return struct {
			workshopView
			RecipeID    string        `json:"recipeId"`
			Output      content.Asset `json:"output"`
			InstanceIDs []string      `json:"instanceIds"`
		}{v, recipe.ID, output, ids}, nil
	})
}
