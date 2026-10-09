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
	for _, g := range seller.GetGoods() {
		if g.GetItem() == req.Good {
			good = g
			break
		}
	}
	if good == nil {
		return fail(400, "invalid-good")
	}
	if seller.GetWith() != "" && !nearResident(s, seller.GetWith(), now, int(seller.GetRadiusTiles())) || seller.GetWith() == "" && !nearTile(s, seller.GetArea(), int(seller.GetTx()), int(seller.GetTy()), int(seller.GetRadiusTiles())) {
		return fail(409, "too-far-away")
	}
	day := content.CalendarAt(content.CalendarRules, now)
	if seller.GetFestival() != "" && (day.Festival == nil || *day.Festival != seller.GetFestival()) {
		return fail(409, "not-in-season")
	}
	ref := seller.GetId() + ":" + good.GetItem()
	if good.GetCap() > 0 {
		dayStart := (now / 86400) * 86400
		var n int
		err := tx.QueryRowContext(ctx, "SELECT count(*) FROM ledger WHERE account_id=? AND currency=? AND reason='market-buy' AND ref=? AND created_at>=?", s.AccountID, content.StackCurrency(good.GetItem()), ref, dayStart).Scan(&n)
		if err != nil {
			return err
		}
		if n >= int(good.GetCap()) {
			return fail(409, "sold-out")
		}
	}
	if err := debitEmbers(ctx, tx, s, int(good.GetEmbers()), "market-buy", ref, now); err != nil {
		return err
	}
	// A seller hands over stacks, or one instance at a time (the willow rod
	// Finn sells): a tool at full condition, as the bench makes one. A
	// bought thing carries no maker's mark.
	if def, exists := content.ItemFor(good.Item); exists && content.ItemInstanced(def) {
		for i := 0; i < int(good.GetQty()); i++ {
			if _, err := newInstance(ctx, tx, def, instanceAt{"pack", s.AccountID}, "", -1, now); err != nil {
				return err
			}
		}
		if err := currency(ctx, tx, s.AccountID, content.StackCurrency(good.Item), int(good.GetQty()), "market-buy", ref, now); err != nil {
			return err
		}
	} else if err := packPut(ctx, tx, s.AccountID, good.Item, []makerQty{{Maker: "", Qty: int(good.GetQty())}}, "market-buy", ref, now); err != nil {
		return err
	}
	out.Bought = &contract.Bought{Seller: seller.GetId(), ItemDef: good.Item, Qty: int32(int(good.GetQty())), Embers: int32(int(good.GetEmbers()))}
	return refreshItems(ctx, tx, s)
}
