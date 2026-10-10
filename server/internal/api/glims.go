package api

import (
	"context"
	"database/sql"
	"errors"
	"glimway/content"
	"glimway/server/internal/itemmove"
	"glimway/server/internal/store"
)

// Glims, server side (docs/design/silas-yard.md 1.4, purse-and-wardrobe.md
// 3): every glim that isn't from XP moves through store.MoveGlims, the
// caller's own and another player's alike, so a transfer writes both sides
// of the ledger in one transaction (3.5) and nothing it credits is ever
// XP-earned (1.4 rule 4). Both sides use the reason/ref shapes below, so
// both logs name the right things:
//
//   - shelf buy/sale: `<the other account>:<item_def>`, reason shelf-buy
//     (buyer, −) and shelf-sale (stocker, +);
//   - letters: the letter's id, reason mail-send / mail-claim / mail-return
//     / mail-recall, with the glims held between the sender's `glims` and
//     their `mail:glims:glims` location currency while it waits;
//   - gives: the other account's id, reason give (giver, −) / gift (+);
//   - a seller's goods: `<seller id>:<good item>`, reason market-buy (the
//     glims leave play there).

// debitGlims spends n of the caller's own glims, the XP-earned ones last;
// short is `insufficient-glims`.
func debitGlims(ctx context.Context, tx *sql.Tx, s *store.Snapshot, n int, reason, ref string, now int64) error {
	return insufficientGlims(store.MoveGlims(ctx, tx, s, s.AccountID, -n, reason, ref, now))
}

// insufficientGlims is the one coded refusal store.ErrShortOfGlims becomes:
// `insufficient-glims`, nothing else.
func insufficientGlims(err error) error {
	if errors.Is(err, store.ErrShortOfGlims) {
		return fail(409, "insufficient-glims")
	}
	return err
}

// mailGlimsCurrency is where a letter holds its glims while it waits: the
// sender's location currency, so their ledger lines sum the same throughout.
func mailGlimsCurrency() string { return itemmove.LocationCurrency("mail", "glims", "glims") }

// glimsAsset is a glim letter's or a glim gift's display-only asset. It
// never names something to take from a pack (validAsset refuses the "glims"
// kind).
func glimsAsset(n int) *content.Asset {
	return &content.Asset{Kind: "glims", Id: "glims", Qty: int32(n)}
}

// shelfTradeRef names the other player and the item in a shelf trade's rows.
func shelfTradeRef(other, item string) string { return other + ":" + item }

// glimsPhrase is an amount of glims in words: "1 glim", "12 glims".
func glimsPhrase(n int) string {
	if n == 1 {
		return "1 glim"
	}
	return itoa(n) + " glims"
}
