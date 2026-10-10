package api

import (
	"errors"
	"glimway/content"
	"glimway/server/internal/itemmove"
	"glimway/server/internal/store"
)

// Glims between players, server side (docs/design/purse-and-wardrobe.md 3,
// silas-yard.md 1.4 rule 3): glims move between players by a shelf price,
// in a letter, or hand to hand, and every transfer writes both sides of the
// ledger in one transaction (3.5). The caller's own side moves on its
// snapshot (debitEmbers, store.Credit), because Persist writes the
// snapshot's glims; the other player's side is store.CreditGold, a column
// write. Both sides use the reason/ref shapes below, so both logs name the
// right things:
//
//   - shelf buy/sale: `<the other account>:<item_def>`, reason shelf-buy
//     (buyer, −) and shelf-sale (stocker, +);
//   - letters: the letter's id, reason mail-send / mail-claim / mail-return
//     / mail-recall, with the glims held between the sender's `glims` and
//     their `mail:glims:glims` location currency while it waits;
//   - gives: the other account's id, reason give (giver, −) / gift (+);
//   - a seller's goods: `<seller id>:<good item>`, reason market-buy (the
//     glims leave play there).
//
// G-B: one credit/debit path for glims (silas-yard.md 1.10) replaces this
// split; glims that arrive by shelf sale, letter or hand stay non-earned.

// mailGoldCurrency is where a letter holds its glims while it waits: the
// sender's location currency, so their ledger lines sum the same throughout.
func mailGoldCurrency() string { return itemmove.LocationCurrency("mail", "glims", "glims") }

// goldAsset is a glim letter's or a glim gift's display-only asset. It never
// names something to take from a pack (validAsset refuses the "glims" kind).
func goldAsset(n int) *content.Asset {
	return &content.Asset{Kind: "glims", Id: "glims", Qty: int32(n)}
}

// shelfTradeRef names the other player and the item in a shelf trade's rows.
func shelfTradeRef(other, item string) string { return other + ":" + item }

// insufficientGold is the one coded refusal store.ErrShortOfGold becomes:
// `insufficient-glims`, nothing else.
func insufficientGold(err error) error {
	if errors.Is(err, store.ErrShortOfGold) {
		return fail(409, "insufficient-glims")
	}
	return err
}

// mirrorOwnCredit carries a column credit that reached the caller's own
// account (store.ReturnMail's glims on a recall) into the snapshot, so
// Persist's write keeps it. The ledger row is already written.
func mirrorOwnCredit(s *store.Snapshot, n int) { s.State.Embers += n }
