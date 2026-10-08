package api

import (
	"context"
	"database/sql"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/content"
	"glimway/server/internal/store"
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
	if err := healWardens(ctx, tx, s.AccountID, now); err != nil {
		return workshopView{}, err
	}
	v := workshopView{Shared: "open"}
	var err error
	home, err := workshop(ctx, tx, s)
	var f *failure
	if err != nil && !asFailure(err, &f) {
		return v, err
	}
	if err == nil {
		h, err := loadHome(ctx, tx, home, s.AccountID, now)
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
	v.Inventory, err = packCounts(ctx, tx, s.AccountID)
	if err != nil {
		return v, err
	}
	v.Personal, err = chestCounts(ctx, tx, holder{"personal", s.AccountID, ""})
	return v, err
}
func (a *Server) storageRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := a.Config.Now().Unix()
	if err = settleHomes(r.Context(), tx, s.WorldID, now); err != nil {
		return err
	}
	v, err := readWorkshop(r.Context(), tx, &s, now)
	if err != nil {
		return err
	}
	return a.finishRead(w, r, tx, s, workshopProto(v))
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
	var req contract.StorageMoveRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	asset := assetFromProto(req.Asset)
	return a.keyedOp(w, r, req.Op, req.Where, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
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
				if _, ok, err := memberOf(ctx, tx, s.AccountID); err != nil {
					return nil, err
				} else if !ok {
					return nil, fail(409, "not-a-member")
				}
			}
			chest = holder{"personal", s.AccountID, ""}
			ledger = "personal:"
		default:
			return nil, fail(400, "invalid-chest")
		}
		v := asset
		if err := validAsset(v); err != nil {
			return nil, err
		}
		ledger += ledgerKind(v)
		switch req.Direction {
		case "deposit":
			if chest.location != "personal" {
				if d, ok := content.ItemFor(v.ID); ok && v.Kind != "decoration" && !d.Giveable() {
					return nil, fail(409, "not-giveable")
				}
			}
			if chest.location == "personal" {
				c, err := chestCounts(ctx, tx, chest)
				if err != nil {
					return nil, err
				}
				if chestUnits(c)+v.Qty > content.HomeRules.PersonalChest.MaxUnits {
					return nil, fail(409, "chest-full")
				}
			}
			got, err := takeAsset(ctx, tx, s, v, chest, "storage-deposit", req.Op.Key, now)
			if err != nil {
				return nil, err
			}
			if err = putStack(ctx, tx, chest.stackPlace(), v.ID, got.Makers); err != nil {
				return nil, err
			}
			if err = currency(ctx, tx, s.AccountID, ledger, v.Qty, "storage-deposit", req.Op.GetKey(), now); err != nil {
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
			if err = giveAsset(ctx, tx, s, v, got, chest, "storage-withdraw", req.Op.Key, now); err != nil {
				return nil, err
			}
			if err = currency(ctx, tx, s.AccountID, ledger, -v.Qty, "storage-withdraw", req.Op.GetKey(), now); err != nil {
				return nil, err
			}
		default:
			return nil, fail(400, "invalid-direction")
		}
		v2, err := readWorkshop(ctx, tx, s, now)
		if err != nil {
			return nil, err
		}
		return workshopProto(v2), nil
	})
}

// craft makes things at the Workshop bench. Made things carry the maker's
// mark when their definition says so ("marked").
func (a *Server) craft(w http.ResponseWriter, r *http.Request) error {
	var req contract.CraftRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := settleHomes(ctx, tx, s.WorldID, now); err != nil {
			return nil, err
		}
		if _, err := workshop(ctx, tx, s); err != nil {
			return nil, err
		}
		recipe, ok := content.RecipeFor(req.RecipeId)
		if !ok {
			return nil, fail(400, "invalid-recipe")
		}
		if req.Qty < 1 || req.Qty > 100 {
			return nil, fail(400, "invalid-quantity")
		}
		// Bloom flowers in the pack dry once their wick has turned, so a
		// recipe's bill is checked against what it truly is.
		if err := dryFlowers(ctx, tx, s, now); err != nil {
			return nil, err
		}
		qty := int(req.Qty)
		if err := checkMaterialsAny(ctx, tx, s.AccountID, scaled(recipe.Materials, qty), recipe.Swaps); err != nil {
			return nil, err
		}
		if err := debitMaterialsAny(ctx, tx, s, recipe.Materials, recipe.Swaps, qty, "craft", recipe.ID, now); err != nil {
			return nil, err
		}
		output := recipe.Output
		output.Qty *= qty
		ids := []string{}
		switch output.Kind {
		case "item":
			def, _ := content.ItemFor(output.ID)
			maker := ""
			if def.Marked {
				maker = s.AccountID
			}
			if err := packPut(ctx, tx, s.AccountID, output.ID, []makerQty{{Maker: maker, Qty: output.Qty}}, "craft", recipe.ID, now); err != nil {
				return nil, err
			}
			if err := refreshItems(ctx, tx, s); err != nil {
				return nil, err
			}
		case "instance":
			def, _ := content.ItemFor(output.ID)
			maker := ""
			if def.Marked {
				maker = s.AccountID
			}
			for i := 0; i < output.Qty; i++ {
				id, err := newInstance(ctx, tx, def, instanceAt{"pack", s.AccountID}, maker, -1, now)
				if err != nil {
					return nil, err
				}
				ids = append(ids, id)
			}
			if err := currency(ctx, tx, s.AccountID, content.StackCurrency(output.ID), output.Qty, "craft", recipe.ID, now); err != nil {
				return nil, err
			}
		default:
			for i := 0; i < output.Qty; i++ {
				id, err := store.Random()
				if err != nil {
					return nil, err
				}
				if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_items(id,item_def,location,account_id) VALUES(?,?,'inventory',?)", id, output.ID, s.AccountID); err != nil {
					return nil, err
				}
				ids = append(ids, id)
			}
			if err := currency(ctx, tx, s.AccountID, "decoration:"+output.ID, output.Qty, "craft", recipe.ID, now); err != nil {
				return nil, err
			}
		}
		v, err := readWorkshop(ctx, tx, s, now)
		if err != nil {
			return nil, err
		}
		out := &contract.CraftResult{RecipeId: recipe.ID, Output: assetProto(output), InstanceIds: ids}
		fillWorkshop(out, v)
		return out, nil
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
