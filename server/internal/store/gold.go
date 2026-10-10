package store

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"glimway/server/internal/itemmove"
)

// Glims moved outside the caller's snapshot (docs/design/silas-yard.md 1.4,
// purse-and-wardrobe.md 3.5): a top-up the worker settles, a shelf sale to
// the stocker, glims given to another player, a letter coming back. The
// rules every caller shares —
//
//   - No write replaces a balance. Every change is `glims = glims + ?` with
//     its ledger row, so a credit to another account can't be overwritten by
//     that account's own next write.
//   - A debit never takes the balance below zero; a debit the balance can't
//     cover is refused before anything is written. Glims from XP go last
//     (1.4 rule 4), so xp_glims falls only when the rest can't cover it.
//   - Every change is one ledger row with currency 'glims' and earned_delta
//     0 (these glims never come from XP), and the account's version moves so
//     the next answer carries the new balance.
//
// Never use these for the caller's own account inside an operation: Persist
// writes the snapshot's glims over the column. The caller's own glims move
// through Credit (store.go) on the snapshot.
//
// G-B: store.Credit and CreditGold become one credit path (silas-yard.md
// 1.10); the gold names go with it.

// ErrShortOfGold is a debit the balance can't cover. Nothing is written.
var ErrShortOfGold = errors.New("insufficient glims")

// CreditGold adds n glims, never XP-earned, to an account that isn't the
// caller's snapshot (n > 0): the balance, the ledger row and the version move
// in the caller's transaction.
func CreditGold(ctx context.Context, tx *sql.Tx, account string, n int, reason, ref string, now int64) error {
	if n <= 0 {
		return fmt.Errorf("glim credit must be positive")
	}
	if _, err := tx.ExecContext(ctx, "UPDATE balances SET glims=glims+? WHERE account_id=?", n, account); err != nil {
		return err
	}
	if err := itemmove.RecordCurrency(ctx, tx, account, itemmove.Glims(), n, reason, ref, now); err != nil {
		return err
	}
	_, err := BumpAccountVersion(ctx, tx, account)
	return err
}

// DebitGold takes n glims from an account that isn't the caller's snapshot
// (n > 0), refusing with ErrShortOfGold before anything is written when the
// balance can't cover it. Glims from XP go last.
func DebitGold(ctx context.Context, tx *sql.Tx, account string, n int, reason, ref string, now int64) error {
	if n <= 0 {
		return fmt.Errorf("glim debit must be positive")
	}
	var held, earned int
	if err := tx.QueryRowContext(ctx, "SELECT glims,xp_glims FROM balances WHERE account_id=?", account).Scan(&held, &earned); err != nil {
		return err
	}
	if held < n {
		return ErrShortOfGold
	}
	spentEarned := max(0, n-(held-earned))
	if _, err := tx.ExecContext(ctx, "UPDATE balances SET glims=glims-?,xp_glims=xp_glims-? WHERE account_id=?", n, spentEarned, account); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO ledger(account_id,currency,delta,earned_delta,reason,ref,created_at) VALUES(?,?,?,?,?,?,?)", account, itemmove.Glims(), -n, -spentEarned, reason, ref, now); err != nil {
		return err
	}
	_, err := BumpAccountVersion(ctx, tx, account)
	return err
}

// RefreshGlims re-reads the balance into a snapshot after a column write
// reached its own account (a stale top-up settled while it looked). Only for
// a snapshot whose own glims haven't moved yet in this transaction.
func RefreshGlims(ctx context.Context, tx *sql.Tx, s *Snapshot) error {
	return tx.QueryRowContext(ctx, "SELECT glims,xp_glims FROM balances WHERE account_id=?", s.AccountID).Scan(&s.State.Embers, &s.State.XPEmbers)
}

// BumpAccountVersion moves an account's answer version without a snapshot:
// glims change an account that is not the operation's own (a shelf sale, a
// gift), and its client re-reads state when the version moves. It answers
// the new version, so a state built right after carries it (finding 6).
func BumpAccountVersion(ctx context.Context, tx *sql.Tx, account string) (int64, error) {
	var v int64
	err := tx.QueryRowContext(ctx, "UPDATE players SET version=version+1 WHERE account_id=? RETURNING version", account).Scan(&v)
	return v, err
}
