package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"glimway/server/internal/itemmove"
)

// The gold purse (docs/design/purse-and-wardrobe.md 2, 3.5): gold is the
// second balance beside embers, and the only rules that matter here are the
// ones every caller shares —
//
//   - No write replaces a balance. Every change is `gold = gold + ?` with
//     its ledger row, so a credit to another account can't be overwritten by
//     that account's own next write.
//   - A debit never takes the purse below zero (CHECK(gold>=0)); a debit the
//     purse can't cover is refused before anything is written.
//   - Every change is one ledger row with currency 'gold' and earned_delta 0
//     (gold is never "earned"), and the account's version moves so the next
//     answer carries the new balance.
//
// Credit hard-codes 'embers' and the XP split (store.go); gold gets its own
// credit and debit beside it, built on the typed currency constructors in
// itemmove (0.6 step 0, review finding 10).

// ErrShortOfGold is a debit the purse can't cover. The API turns it into the
// coded `insufficient-gold` refusal; nothing is written either way.
var ErrShortOfGold = errors.New("insufficient gold")

// CreditGold adds n gold to an account's purse (n > 0): the balance, the
// ledger row and the version move in the caller's transaction. A top-up
// settles this way (reason 'habitica-topup'); so does gold arriving from
// another player (their lane's reason).
func CreditGold(ctx context.Context, tx *sql.Tx, account string, n int, reason, ref string, now int64) error {
	if n <= 0 {
		return fmt.Errorf("gold credit must be positive")
	}
	if _, err := tx.ExecContext(ctx, "UPDATE balances SET gold=gold+? WHERE account_id=?", n, account); err != nil {
		return err
	}
	if err := itemmove.RecordCurrency(ctx, tx, account, itemmove.Gold(), n, reason, ref, now); err != nil {
		return err
	}
	_, err := BumpAccountVersion(ctx, tx, account)
	return err
}

// DebitGold takes n gold out of an account's purse (n > 0), refusing with
// ErrShortOfGold before anything is written when the purse can't cover it.
func DebitGold(ctx context.Context, tx *sql.Tx, account string, n int, reason, ref string, now int64) error {
	if n <= 0 {
		return fmt.Errorf("gold debit must be positive")
	}
	var held int
	if err := tx.QueryRowContext(ctx, "SELECT gold FROM balances WHERE account_id=?", account).Scan(&held); err != nil {
		return err
	}
	if held < n {
		return ErrShortOfGold
	}
	if _, err := tx.ExecContext(ctx, "UPDATE balances SET gold=gold-? WHERE account_id=?", n, account); err != nil {
		return err
	}
	if err := itemmove.RecordCurrency(ctx, tx, account, itemmove.Gold(), -n, reason, ref, now); err != nil {
		return err
	}
	_, err := BumpAccountVersion(ctx, tx, account)
	return err
}

// GoldFor reads one purse.
func GoldFor(ctx context.Context, tx *sql.Tx, account string) (int, error) {
	var gold int
	err := tx.QueryRowContext(ctx, "SELECT gold FROM balances WHERE account_id=?", account).Scan(&gold)
	return gold, err
}

// BumpAccountVersion moves an account's answer version without a snapshot:
// gold changes an account that is not the operation's own (a shelf sale, a
// gift), and its client re-reads state when the version moves. It answers
// the new version, so a state built right after carries it (finding 6).
func BumpAccountVersion(ctx context.Context, tx *sql.Tx, account string) (int64, error) {
	var v int64
	err := tx.QueryRowContext(ctx, "UPDATE players SET version=version+1 WHERE account_id=? RETURNING version", account).Scan(&v)
	return v, err
}
