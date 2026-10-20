package api

import (
	"context"
	"database/sql"
	"fmt"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

// ------------------------------------------------------- the Wick Tree's sap

// tapWickSap taps the Wick Tree in Hearthwick (lamps.md 2.5): once a
// calendar wick, anyone standing by it takes the wick's sap, lantern or no
// lantern. The wick's outcome row (wick-sap:<wick start>) is the one-a-wick
// check: a second tap in the same wick is refused, and a missed wick is
// gone, not saved up. A replayed request answers from the keyed op.
func (a *Server) tapWickSap(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64, out *contract.ItemsResult) error {
	r := content.HomeRules.GetWickSap()
	if !nearTile(s, r.GetArea(), int(r.GetTx()), int(r.GetTy()), int(r.GetReach())) {
		return fail(409, "too-far-away")
	}
	var before int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM outcomes WHERE account_id=? AND reason='wick-sap'", s.AccountID).Scan(&before); err != nil {
		return err
	}
	ok, err := store.Outcome(ctx, tx, s.AccountID, fmt.Sprintf("wick-sap:%d", store.WickStart(now)), "wick-sap", now)
	if err != nil {
		return err
	}
	if !ok {
		return fail(409, "already-tapped")
	}
	if err := packPut(ctx, tx, s.AccountID, r.GetItem(), []makerQty{{Qty: int(r.GetQty())}}, "wick-sap", "wick-tree", now); err != nil {
		return err
	}
	out.Tapped = &contract.Stack{ItemDef: r.GetItem(), Qty: r.GetQty()}
	out.FirstTap = before == 0
	return nil
}

// refineWickSap: the chandler refines one sap into hearth oil, free. Oil
// beyond the sap is still bought from the chandler (market.go).
func (a *Server) refineWickSap(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64, out *contract.ItemsResult) error {
	r := content.HomeRules.GetWickSap()
	seller, ok := content.SellerFor(r.GetRefiner())
	if !ok {
		return fail(400, "invalid-seller")
	}
	if !atSeller(s, seller, now) {
		return fail(409, "too-far-away")
	}
	have, err := stackTotal(ctx, tx, packOf(s.AccountID), r.GetItem())
	if err != nil {
		return err
	}
	if have < 1 {
		return fail(409, "insufficient-items")
	}
	if _, err := packTake(ctx, tx, s.AccountID, r.GetItem(), nil, 1, "sap-refine", seller.GetId(), now); err != nil {
		return err
	}
	if err := packPut(ctx, tx, s.AccountID, r.GetOil(), []makerQty{{Qty: int(r.GetOilQty())}}, "sap-refine", seller.GetId(), now); err != nil {
		return err
	}
	out.Used = r.GetItem()
	out.Refined = &contract.Stack{ItemDef: r.GetOil(), Qty: r.GetOilQty()}
	return nil
}
