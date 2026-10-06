package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/store"
	"net/http"
)

// workshopView: the caller's pack, their personal chest (always theirs,
// wherever they live: it goes with them when they leave a deed), and, when
// they belong to a homestead with a Workshop, that home and its shared chest.
// Without one, Home and Storage are null and Shared says why.
type workshopView struct {
	Home      *homeView    `json:"home"`
	Inventory assetCounts  `json:"inventory"`
	Storage   *assetCounts `json:"storage"`
	Personal  assetCounts  `json:"personal"`
	Shared    string       `json:"shared"`
}

func readWorkshop(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (workshopView, error) {
	v := workshopView{Shared: "open"}
	var err error
	home, err := workshop(ctx, tx, s)
	var f *failure
	if err != nil && !asFailure(err, &f) {
		return v, err
	}
	if err == nil {
		h, err := loadHome(ctx, tx, home, s.HabiticaID, now)
		if err != nil {
			return v, err
		}
		v.Home = &h
		c, err := chestCounts(ctx, tx, holder{"storage", "", home})
		if err != nil {
			return v, err
		}
		v.Storage = &c
	} else {
		v.Shared = f.code
	}
	v.Inventory, err = packCounts(ctx, tx, s.HabiticaID)
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
	v, err := readWorkshop(r.Context(), tx, &s, now)
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
	n := len(c.Instances)
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
		var chest holder
		ledger := "storage:"
		switch req.Chest {
		case "", "shared":
			home, err := workshop(ctx, tx, s)
			if err != nil {
				return nil, err
			}
			chest = holder{"storage", "", home}
		case "personal":
			// Your own chest: take things out from anywhere; put things in
			// from any home you belong to, at any tier.
			if req.Direction == "deposit" {
				if _, ok, err := memberOf(ctx, tx, s.HabiticaID); err != nil {
					return nil, err
				} else if !ok {
					return nil, fail(409, "not-a-member")
				}
			}
			chest = holder{"personal", s.HabiticaID, ""}
			ledger = "personal:"
		default:
			return nil, fail(400, "invalid-chest")
		}
		v := req.Asset
		if err := validAsset(v); err != nil {
			return nil, err
		}
		ledger += ledgerKind(v)
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
			got, err := takeAsset(ctx, tx, s, v, chest, "storage-deposit", req.Key, now)
			if err != nil {
				return nil, err
			}
			if err = putStack(ctx, tx, chest.stackPlace(), v.ID, got.Makers); err != nil {
				return nil, err
			}
			if err = currency(ctx, tx, s.HabiticaID, ledger, v.Qty, "storage-deposit", req.Key, now); err != nil {
				return nil, err
			}
		case "withdraw":
			got := moved{Makers: []makerQty{}, IDs: []string{}}
			var err error
			switch v.Kind {
			case "decoration":
				got.IDs, err = decorationIDs(ctx, tx, chest, v.ID, v.Qty)
			case "instance":
				got.IDs = []string{v.Instance}
			default:
				got.Makers, err = takeStack(ctx, tx, chest.stackPlace(), v.ID, v.Maker, v.Qty)
				var f *failure
				if err != nil && asFailure(err, &f) {
					err = fail(409, "insufficient-storage")
				}
			}
			if err != nil {
				return nil, err
			}
			if err = giveAsset(ctx, tx, s, v, got, chest, "storage-withdraw", req.Key, now); err != nil {
				return nil, err
			}
			if err = currency(ctx, tx, s.HabiticaID, ledger, -v.Qty, "storage-withdraw", req.Key, now); err != nil {
				return nil, err
			}
		default:
			return nil, fail(400, "invalid-direction")
		}
		return readWorkshop(ctx, tx, s, now)
	})
}

// craft makes things at the Workshop bench. Made things carry the maker's
// mark when their definition says so ("marked").
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
		if _, err := workshop(ctx, tx, s); err != nil {
			return nil, err
		}
		recipe, ok := content.RecipeFor(req.RecipeID)
		if !ok {
			return nil, fail(400, "invalid-recipe")
		}
		if req.Qty < 1 || req.Qty > 100 {
			return nil, fail(400, "invalid-quantity")
		}
		if err := checkMaterials(ctx, tx, s.HabiticaID, scaled(recipe.Materials, req.Qty)); err != nil {
			return nil, err
		}
		if err := debitMaterials(ctx, tx, s, recipe.Materials, req.Qty, "craft", recipe.ID, now); err != nil {
			return nil, err
		}
		output := recipe.Output
		output.Qty *= req.Qty
		ids := []string{}
		switch output.Kind {
		case "item":
			def, _ := content.ItemFor(output.ID)
			maker := ""
			if def.Marked {
				maker = s.HabiticaID
			}
			if err := packPut(ctx, tx, s.HabiticaID, output.ID, []makerQty{{maker, output.Qty}}, "craft", recipe.ID, now); err != nil {
				return nil, err
			}
			if err := refreshItems(ctx, tx, s); err != nil {
				return nil, err
			}
		case "instance":
			def, _ := content.ItemFor(output.ID)
			maker := ""
			if def.Marked {
				maker = s.HabiticaID
			}
			for i := 0; i < output.Qty; i++ {
				id, err := newInstance(ctx, tx, def, instanceAt{"pack", s.HabiticaID}, maker, -1, now)
				if err != nil {
					return nil, err
				}
				ids = append(ids, id)
			}
			if err := currency(ctx, tx, s.HabiticaID, content.StackCurrency(output.ID), output.Qty, "craft", recipe.ID, now); err != nil {
				return nil, err
			}
		default:
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
		v, err := readWorkshop(ctx, tx, s, now)
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

func scaled(costs map[string]int, qty int) map[string]int {
	out := map[string]int{}
	for k, n := range costs {
		out[k] = n * qty
	}
	return out
}

func asFailure(err error, f **failure) bool {
	v, ok := err.(*failure)
	if ok {
		*f = v
	}
	return ok
}
