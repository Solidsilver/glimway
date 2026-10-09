package api

import (
	"context"
	"database/sql"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

// pickUp takes a thing lying in the world, once per player, standing by it.
func pickUp(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.ItemsRequest, now int64, out *contract.ItemsResult) error {
	p, ok := content.PickupFor(req.Pickup)
	if !ok {
		return fail(404, "pickup-not-found")
	}
	if !nearTile(s, p.GetArea(), int(p.GetTx()), int(p.GetTy()), 3) {
		return fail(409, "too-far-away")
	}
	added, err := store.Outcome(ctx, tx, s.AccountID, "pickup:"+p.GetId(), "pickup", now)
	if err != nil {
		return err
	}
	if !added {
		return fail(409, "already-picked-up")
	}
	def, _ := content.ItemFor(p.GetItem())
	out.Pickup = p.GetId()
	if content.ItemInstanced(def) {
		condition := -1
		if p.GetUsesLeft() > 0 {
			condition = int(p.GetUsesLeft()) * int(content.ItemsRules.Rules.Wear.GetPointsPerUse())
		}
		id, err := newInstance(ctx, tx, def, instanceAt{"pack", s.AccountID}, "", condition, now)
		if err != nil {
			return err
		}
		out.Created = []string{id}
		return currency(ctx, tx, s.AccountID, content.StackCurrency(def.GetId()), 1, "pickup", p.GetId(), now)
	}
	return packPut(ctx, tx, s.AccountID, def.GetId(), []makerQty{{Maker: "", Qty: int(p.GetQty())}}, "pickup", p.GetId(), now)
}
