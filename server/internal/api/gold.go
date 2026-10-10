package api

import (
	"errors"
	"glimway/content"
	"glimway/server/internal/itemmove"
	"glimway/server/internal/store"
)

// The gold purse, server side (docs/design/purse-and-wardrobe.md 3): gold
// moves between players by a shelf price, in a letter, or hand to hand, and
// every transfer writes both sides of the ledger in one transaction (3.5).
// The purse's two writes are lane B's — `store.CreditGold`, `store.DebitGold`
// and `store.GoldFor` (their EARLY.md) — and both sides of a transfer call
// them with the reason/ref shapes in its table, so both purse logs name the
// right things:
//
//   - shelf buy/sale: `<the other account>:<item_def>`, reason shelf-buy
//     (buyer, −) and shelf-sale (stocker, +);
//   - letters: the letter's id, reason mail-send / mail-claim / mail-return
//     / mail-recall, with the gold held between the sender's `gold` and
//     their `mail:gold:gold` location currency while it waits;
//   - gives: the other account's id, reason give (giver, −) / gift (+);
//   - a seller's goods: `<seller id>:<good item>`, reason market-buy (the
//     gold leaves play there, and nowhere else but a top-up's source).

// mailGoldCurrency is where a letter holds its gold while it waits: the
// sender's location currency, so their ledger lines sum the same throughout.
func mailGoldCurrency() string { return itemmove.LocationCurrency("mail", "gold", "gold") }

// goldAsset is a gold letter's or a gold gift's display-only asset. It never
// names something to take from a pack (validAsset refuses the "gold" kind).
func goldAsset(n int) *content.Asset { return &content.Asset{Kind: "gold", Id: "gold", Qty: int32(n)} }

// shelfTradeRef names the other player and the item in a shelf trade's rows.
func shelfTradeRef(other, item string) string { return other + ":" + item }

// insufficientGold is the one coded refusal store.DebitGold's value becomes
// (lane B's EARLY.md): `insufficient-gold` (wire code 222), nothing else.
func insufficientGold(err error) error {
	if errors.Is(err, store.ErrShortOfGold) {
		return fail(409, "insufficient-gold")
	}
	return err
}
