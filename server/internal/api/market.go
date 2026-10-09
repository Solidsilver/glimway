package api

import (
	"context"
	"database/sql"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

// ------------------------------------------------------------- the sellers

// marketBuy buys a good from a seller: a named resident (Hazel's kitchen,
// Finn's mill door) or a stall that stands on its festival day only (the
// Carting Day market). You stand by them; the embers leave the pack; the
// server's own calendar decides whether the seller is there at all
// (docs/items/crafting-and-repair.md, "Seasonal materials"). Capped goods
// keep their day's count in the ledger (one row a buy, reason market-buy).
func (a *Server) marketBuy(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.ItemsRequest, now int64, out *contract.ItemsResult) error {
	seller, ok := content.SellerFor(req.Seller)
	if !ok {
		return fail(400, "invalid-seller")
	}
	var good *content.ItemGood
	for i := range seller.Goods {
		if seller.Goods[i].Item == req.Good {
			good = &seller.Goods[i]
			break
		}
	}
	if good == nil {
		return fail(400, "invalid-good")
	}
	if seller.With != "" && !nearResident(s, seller.With, now, seller.RadiusTiles) || seller.With == "" && !nearTile(s, seller.Area, seller.TX, seller.TY, seller.RadiusTiles) {
		return fail(409, "too-far-away")
	}
	day := content.CalendarAt(content.CalendarRules, now)
	if seller.Festival != "" && (day.Festival == nil || *day.Festival != seller.Festival) {
		return fail(409, "not-in-season")
	}
	ref := seller.ID + ":" + good.Item
	if good.Cap > 0 {
		dayStart := (now / 86400) * 86400
		var n int
		err := tx.QueryRowContext(ctx, "SELECT count(*) FROM ledger WHERE account_id=? AND currency=? AND reason='market-buy' AND ref=? AND created_at>=?", s.AccountID, content.StackCurrency(good.Item), ref, dayStart).Scan(&n)
		if err != nil {
			return err
		}
		if n >= good.Cap {
			return fail(409, "sold-out")
		}
	}
	if err := debitEmbers(ctx, tx, s, good.Embers, "market-buy", ref, now); err != nil {
		return err
	}
	if err := packPut(ctx, tx, s.AccountID, good.Item, []makerQty{{Maker: "", Qty: good.Qty}}, "market-buy", ref, now); err != nil {
		return err
	}
	out.Bought = &contract.Bought{Seller: seller.ID, ItemDef: good.Item, Qty: int32(good.Qty), Embers: int32(good.Embers)}
	return refreshItems(ctx, tx, s)
}
