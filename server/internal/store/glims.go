package store

import (
	"context"
	"database/sql"
	"errors"
	"glimway/server/internal/itemmove"
)

// Glims (docs/design/silas-yard.md 1.4) move on one path. The rules every
// caller shares —
//
//   - Nothing ever writes a balance. The caller's own glims change on its
//     snapshot, and Persist writes the change since Load as a delta
//     (`glims = glims + ?`), never the balance. Any other account changes by
//     a column delta at once. So a write that reached the same account
//     earlier in the transaction is never overwritten, whichever way it came.
//   - Every change is one ledger row with currency 'glims', and the rows of
//     an account sum to its balance.
//   - Glims from XP are the only earned ones (1.4 rule 4): only Credit takes
//     an earned share, and only the XP sync and its checkpoint pass one.
//     Everything MoveGlims credits — a top-up, a shelf sale, a letter, a
//     give — is never XP-earned, so nobody can pass a 0-HP rest to a friend.
//   - A debit spends the other glims first and the XP-earned ones last, and
//     one the balance can't cover is refused before anything is written.

// ErrShortOfGlims is a debit the balance can't cover. Nothing is written.
var ErrShortOfGlims = errors.New("insufficient glims")

// Credit changes the caller's own glims on its snapshot by n, earned of them
// from XP, with its ledger row (reported_xp is the sync's, when there is
// one). Persist writes the change. A zero n is a ledger mark only (a
// rebirth, a world move). Glims moving from or to anywhere but the XP sync
// go through MoveGlims, which never credits an earned share.
func Credit(ctx context.Context, tx *sql.Tx, s *Snapshot, n, earned int, reason, ref string, xp *float64, now int64) error {
	s.State.Glims += n
	s.State.XPGlims += earned
	_, err := tx.ExecContext(ctx, "INSERT INTO ledger(account_id,currency,delta,earned_delta,reason,ref,reported_xp,created_at) VALUES(?,'glims',?,?,?,?,?,?)", s.AccountID, n, earned, reason, ref, xp, now)
	return err
}

// MoveGlims is every glim change that isn't from XP: n > 0 credits, n < 0
// spends. s is the operation's own snapshot, or nil when there is none (the
// top-up worker, the owner's settle, the mail sweep). When the account is
// s's, the change goes on the snapshot (Credit) and Persist writes it, so
// the answer shows it; any other account changes in the database at once,
// and its version moves so its next answer carries the new balance.
//
// A credit is never XP-earned. A debit spends XP-earned glims last and is
// refused with ErrShortOfGlims, writing nothing, when the balance is short.
//
// A zero change is a free price, not an error: on the caller's own account it
// writes the zero-delta ledger mark Credit writes (as 0.6's ember debit did),
// and on any other account it writes nothing.
func MoveGlims(ctx context.Context, tx *sql.Tx, s *Snapshot, account string, n int, reason, ref string, now int64) error {
	own := s != nil && s.AccountID == account
	if n == 0 {
		if own {
			return Credit(ctx, tx, s, 0, 0, reason, ref, nil, now)
		}
		return nil
	}
	var held, earned int
	if own {
		held, earned = s.State.Glims, s.State.XPGlims
	} else if err := tx.QueryRowContext(ctx, "SELECT glims,xp_glims FROM balances WHERE account_id=?", account).Scan(&held, &earned); err != nil {
		return err
	}
	earnedDelta := 0
	if n < 0 {
		if held < -n {
			return ErrShortOfGlims
		}
		earnedDelta = -max(0, -n-(held-earned))
	}
	if own {
		return Credit(ctx, tx, s, n, earnedDelta, reason, ref, nil, now)
	}
	if _, err := tx.ExecContext(ctx, "UPDATE balances SET glims=glims+?,xp_glims=xp_glims+? WHERE account_id=?", n, earnedDelta, account); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO ledger(account_id,currency,delta,earned_delta,reason,ref,created_at) VALUES(?,?,?,?,?,?,?)", account, itemmove.Glims(), n, earnedDelta, reason, ref, now); err != nil {
		return err
	}
	_, err := BumpAccountVersion(ctx, tx, account)
	return err
}

// persistGlims writes the snapshot's own glim change since Load (or since
// the last Persist) as a delta, never the balance: see the rules above.
func persistGlims(ctx context.Context, tx *sql.Tx, s *Snapshot) error {
	dGlims, dEarned := s.State.Glims-s.heldGlims, s.State.XPGlims-s.heldXPGlims
	if dGlims != 0 || dEarned != 0 {
		if _, err := tx.ExecContext(ctx, "UPDATE balances SET glims=glims+?,xp_glims=xp_glims+? WHERE account_id=?", dGlims, dEarned, s.AccountID); err != nil {
			return err
		}
	}
	s.heldGlims, s.heldXPGlims = s.State.Glims, s.State.XPGlims
	return nil
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
