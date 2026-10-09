package api

import (
	"context"
	"database/sql"
	"glimway/content"
	contentv1 "glimway/gen/glimway/content/v1"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/proto"
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
	asset := assetOf(req.Asset)
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
				if d, ok := content.ItemFor(v.GetId()); ok && v.GetKind() != "decoration" && !content.ItemGiveable(d) {
					return nil, fail(409, "not-giveable")
				}
			}
			if chest.location == "personal" {
				c, err := chestCounts(ctx, tx, chest)
				if err != nil {
					return nil, err
				}
				if chestUnits(c)+int(v.GetQty()) > int(content.HomeRules.GetPersonalChest().GetMaxUnits()) {
					return nil, fail(409, "chest-full")
				}
			}
			got, err := takeAsset(ctx, tx, s, v, chest, "storage-deposit", req.Op.Key, now)
			if err != nil {
				return nil, err
			}
			if err = putStack(ctx, tx, chest.stackPlace(), v.GetId(), got.Makers); err != nil {
				return nil, err
			}
			if err = currency(ctx, tx, s.AccountID, ledger, int(v.GetQty()), "storage-deposit", req.Op.GetKey(), now); err != nil {
				return nil, err
			}
		case "withdraw":
			got := moved{Makers: []makerQty{}, IDs: []string{}}
			var err error
			switch v.GetKind() {
			case "decoration":
				got.IDs, err = decorationIDs(ctx, tx, chest, v.GetId(), int(v.GetQty()))
			case "instance":
				got.IDs = []string{v.GetInstance()}
			default:
				got.Makers, err = takeStack(ctx, tx, chest.stackPlace(), v.GetId(), v.Maker, int(v.GetQty()))
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
			if err = currency(ctx, tx, s.AccountID, ledger, -int(v.GetQty()), "storage-withdraw", req.Op.GetKey(), now); err != nil {
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
		if err := checkMaterialsAny(ctx, tx, s.AccountID, scaled32(recipe.GetMaterials(), int32(qty)), recipe.GetSwaps()); err != nil {
			return nil, err
		}
		if err := debitMaterialsAny(ctx, tx, s, recipe.GetMaterials(), recipe.GetSwaps(), qty, "craft", recipe.GetId(), now); err != nil {
			return nil, err
		}
		output := outputOf(recipe, qty)
		ids := []string{}
		switch output.GetKind() {
		case "item":
			def, _ := content.ItemFor(output.GetId())
			maker := ""
			if def.GetMarked() {
				maker = s.AccountID
			}
			if err := packPut(ctx, tx, s.AccountID, output.GetId(), []makerQty{{Maker: maker, Qty: int(output.GetQty())}}, "craft", recipe.GetId(), now); err != nil {
				return nil, err
			}
			if err := refreshItems(ctx, tx, s); err != nil {
				return nil, err
			}
		case "instance":
			def, _ := content.ItemFor(output.GetId())
			maker := ""
			if def.GetMarked() {
				maker = s.AccountID
			}
			for i := 0; i < int(output.GetQty()); i++ {
				id, err := newInstance(ctx, tx, def, instanceAt{"pack", s.AccountID}, maker, -1, now)
				if err != nil {
					return nil, err
				}
				ids = append(ids, id)
			}
			if err := currency(ctx, tx, s.AccountID, content.StackCurrency(output.GetId()), int(output.GetQty()), "craft", recipe.GetId(), now); err != nil {
				return nil, err
			}
		default:
			for i := 0; i < int(output.GetQty()); i++ {
				id, err := store.Random()
				if err != nil {
					return nil, err
				}
				if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_items(id,item_def,location,account_id) VALUES(?,?,'inventory',?)", id, output.GetId(), s.AccountID); err != nil {
					return nil, err
				}
				ids = append(ids, id)
			}
			if err := currency(ctx, tx, s.AccountID, "decoration:"+output.GetId(), int(output.GetQty()), "craft", recipe.GetId(), now); err != nil {
				return nil, err
			}
		}
		v, err := readWorkshop(ctx, tx, s, now)
		if err != nil {
			return nil, err
		}
		out := &contract.CraftResult{RecipeId: recipe.GetId(), Output: assetProto(output), InstanceIds: ids}
		fillWorkshop(out, v)
		return out, nil
	})
}

// scaled32 scales a recipe's bill by the batches crafted. outputOf copies
// the recipe's output with the quantity multiplied (recipes must not be
// mutated: they are pointers into the shared table).
func scaled32(costs map[string]int32, qty int32) map[string]int32 {
	out := map[string]int32{}
	for k, n := range costs {
		out[k] = n * qty
	}
	return out
}

func outputOf(recipe *content.Recipe, qty int) *contentv1.Asset {
	out := proto.Clone(recipe.GetOutput()).(*contentv1.Asset)
	out.Qty *= int32(qty)
	return out
}

func asFailure(err error, f **failure) bool {
	v, ok := err.(*failure)
	if ok {
		*f = v
	}
	return ok
}
