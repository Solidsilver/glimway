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
	Personal  assetCounts `json:"personal"`
}

func readWorkshop(ctx context.Context, tx *sql.Tx, s *store.Snapshot, home string, now int64) (workshopView, error) {
	var v workshopView
	var err error
	v.Home, err = loadHome(ctx, tx, home, s.HabiticaID, now)
	if err != nil {
		return v, err
	}
	v.Inventory, err = packCounts(ctx, tx, s.HabiticaID)
	if err != nil {
		return v, err
	}
	v.Storage, err = chestCounts(ctx, tx, holder{"storage", "", home})
	if err != nil {
		return v, err
	}
	v.Personal, err = chestCounts(ctx, tx, holder{"personal", s.HabiticaID, ""})
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
	now := a.Config.Now().Unix()
	if err = settleHomes(r.Context(), tx, s.WorldID, now); err != nil {
		return err
	}
	home, err := workshop(r.Context(), tx, &s)
	if err != nil {
		return err
	}
	v, err := readWorkshop(r.Context(), tx, &s, home, now)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		workshopView
	}{s, v})
}

// chestUnits is everything in a chest, counted in units (the personal cap).
func chestUnits(c assetCounts) int {
	n := 0
	for _, m := range []map[string]int{c.Materials, c.Items, c.Decorations} {
		for _, q := range m {
			n += q
		}
	}
	return n
}
func (a *Server) storageMutation(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		Key       string          `json:"key"`
		Progress  json.RawMessage `json:"progress,omitempty"`
		Direction string          `json:"direction"`
		Chest     string          `json:"chest,omitempty"`
		Asset     content.Asset   `json:"asset"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	return a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := settleHomes(ctx, tx, s.WorldID, now); err != nil {
			return nil, err
		}
		home, err := workshop(ctx, tx, s)
		if err != nil {
			return nil, err
		}
		chest := holder{"storage", "", home}
		table, key, owner := "home_storage", "homestead_id", home
		switch req.Chest {
		case "", "shared":
		case "personal":
			chest = holder{"personal", s.HabiticaID, ""}
			table, key, owner = "personal_storage", "habitica_id", s.HabiticaID
		default:
			return nil, fail(400, "invalid-chest")
		}
		v := req.Asset
		if err := validAsset(v); err != nil {
			return nil, err
		}
		ledger := "storage:" + v.Kind + ":" + v.ID
		if chest.location == "personal" {
			ledger = "personal:" + v.Kind + ":" + v.ID
		}
		switch req.Direction {
		case "deposit":
			if chest.location == "personal" {
				c, err := chestCounts(ctx, tx, chest)
				if err != nil {
					return nil, err
				}
				if chestUnits(c)+v.Qty > content.HomeRules.PersonalChest.MaxUnits {
					return nil, fail(409, "chest-full")
				}
			}
			if _, err := takeAsset(ctx, tx, s, v, chest, "storage-deposit", req.Key, now); err != nil {
				return nil, err
			}
			if v.Kind != "decoration" {
				if _, err := tx.ExecContext(ctx, "INSERT INTO "+table+"("+key+",kind,item_def,qty) VALUES(?,?,?,?) ON CONFLICT("+key+",kind,item_def) DO UPDATE SET qty=qty+excluded.qty", owner, v.Kind, v.ID, v.Qty); err != nil {
					return nil, err
				}
			}
			if err := currency(ctx, tx, s.HabiticaID, ledger, v.Qty, "storage-deposit", req.Key, now); err != nil {
				return nil, err
			}
		case "withdraw":
			ids := []string{}
			if v.Kind == "decoration" {
				ids, err = decorationIDs(ctx, tx, chest, v.ID, v.Qty)
				if err != nil {
					return nil, err
				}
			} else {
				var n int
				err := tx.QueryRowContext(ctx, "SELECT qty FROM "+table+" WHERE "+key+"=? AND kind=? AND item_def=?", owner, v.Kind, v.ID).Scan(&n)
				if err != nil && err != sql.ErrNoRows {
					return nil, err
				}
				if n < v.Qty {
					return nil, fail(409, "insufficient-storage")
				}
				if n == v.Qty {
					_, err = tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE "+key+"=? AND kind=? AND item_def=?", owner, v.Kind, v.ID)
				} else {
					_, err = tx.ExecContext(ctx, "UPDATE "+table+" SET qty=qty-? WHERE "+key+"=? AND kind=? AND item_def=?", v.Qty, owner, v.Kind, v.ID)
				}
				if err != nil {
					return nil, err
				}
			}
			if err := giveAsset(ctx, tx, s, v, ids, chest, "storage-withdraw", req.Key, now); err != nil {
				return nil, err
			}
			if err := currency(ctx, tx, s.HabiticaID, ledger, -v.Qty, "storage-withdraw", req.Key, now); err != nil {
				return nil, err
			}
		default:
			return nil, fail(400, "invalid-direction")
		}
		return readWorkshop(ctx, tx, s, home, now)
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
		if err := settleHomes(ctx, tx, s.WorldID, now); err != nil {
			return nil, err
		}
		home, err := workshop(ctx, tx, s)
		if err != nil {
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
				if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_items(id,item_def,location,habitica_id) VALUES(?,?,'inventory',?)", id, output.ID, s.HabiticaID); err != nil {
					return nil, err
				}
				ids = append(ids, id)
			}
			if err := currency(ctx, tx, s.HabiticaID, "decoration:"+output.ID, output.Qty, "craft", recipe.ID, now); err != nil {
				return nil, err
			}
		}
		v, err := readWorkshop(ctx, tx, s, home, now)
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
