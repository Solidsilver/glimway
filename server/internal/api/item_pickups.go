package api

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/store"
)

// pickUp takes a thing lying in the world, once per player, standing by it.
func pickUp(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest, now int64, out *itemResult) error {
	p, ok := content.PickupFor(req.Pickup)
	if !ok {
		return fail(404, "pickup-not-found")
	}
	if !nearTile(s, p.Area, p.TX, p.TY, 3) {
		return fail(409, "too-far-away")
	}
	added, err := store.Outcome(ctx, tx, s.HabiticaID, "pickup:"+p.ID, "pickup", now)
	if err != nil {
		return err
	}
	if !added {
		return fail(409, "already-picked-up")
	}
	def, _ := content.ItemFor(p.Item)
	out.Pickup = p.ID
	if def.Instanced() {
		condition := -1
		if p.UsesLeft > 0 {
			condition = p.UsesLeft * content.ItemsRules.Rules.Wear.PointsPerUse
		}
		id, err := newInstance(ctx, tx, def, instanceAt{"pack", s.HabiticaID}, "", condition, now)
		if err != nil {
			return err
		}
		out.Created = []string{id}
		return currency(ctx, tx, s.HabiticaID, content.StackCurrency(def.ID), 1, "pickup", p.ID, now)
	}
	return packPut(ctx, tx, s.HabiticaID, def.ID, []makerQty{{Maker: "", Qty: p.Qty}}, "pickup", p.ID, now)
}
