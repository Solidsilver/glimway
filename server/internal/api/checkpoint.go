package api

import (
	"context"
	"database/sql"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"strconv"
)

// Pending has its own retention clock. Neither death nor flagging confiscates
// held credit; expiry and verification are audited in the same transaction.
func expirePending(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (bool, error) {
	cutoff := now - int64(int(rules.E.GetPendingCreditDays()))*86400
	var expired int
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(SUM(glims),0) FROM pending_credits WHERE account_id=? AND created_at<=?", s.AccountID, cutoff).Scan(&expired); err != nil {
		return false, err
	}
	if expired == 0 {
		return false, nil
	}
	if err := store.Credit(ctx, tx, s, 0, 0, "pending-expired", strconv.Itoa(expired), nil, now); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM pending_credits WHERE account_id=? AND created_at<=?", s.AccountID, cutoff); err != nil {
		return false, err
	}
	s.Pending -= expired
	return true, nil
}
func checkpoint(ctx context.Context, tx *sql.Tx, s *store.Snapshot, p rules.Profile, now int64) error {
	verified := rules.LifetimeXP(p.Level, *p.Exp)
	high, highAt, err := highestCredit(ctx, tx, s)
	if err != nil {
		return err
	}
	changed, err := expirePending(ctx, tx, s, now)
	if err != nil {
		return err
	}
	if rules.IsRebirth(p, s.LossReference, s.VerifiedHighLevel) {
		if err = store.Credit(ctx, tx, s, 0, 0, "rebirth", "checkpoint", &verified, now); err != nil {
			return err
		}
	} else if rules.CheckpointForgery(p, s.LossReference, s.VerifiedHighLevel, rules.CreditReference(high), now-highAt) && !s.Flagged {
		if _, err = tx.ExecContext(ctx, "UPDATE players SET flagged_at=? WHERE account_id=?", now, s.AccountID); err != nil {
			return err
		}
		if err = store.Credit(ctx, tx, s, 0, 0, "checkpoint-flag", "highest-credit", &verified, now); err != nil {
			return err
		}
		s.Flagged = true
		changed = true
	}
	var confirmed int
	if err = tx.QueryRowContext(ctx, "SELECT COALESCE(SUM(glims),0) FROM pending_credits WHERE account_id=? AND reported_xp<=?", s.AccountID, verified).Scan(&confirmed); err != nil {
		return err
	}
	if confirmed > 0 {
		if err = store.Credit(ctx, tx, s, confirmed, confirmed, "pending-settled", "checkpoint", &verified, now); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM pending_credits WHERE account_id=? AND reported_xp<=?", s.AccountID, verified); err != nil {
			return err
		}
		s.Pending -= confirmed
		changed = true
	}
	if err = store.SetLossReference(ctx, tx, s, p, now); err != nil {
		return err
	}
	if changed {
		return store.Persist(ctx, tx, s, now)
	}
	return nil
}

// The cursor excludes reports already reviewed at a checkpoint, even when
// several syncs/logins share a Unix second. Pending rows also cover legacy
// held credit without a corresponding modern ledger entry.
func highestCredit(ctx context.Context, tx *sql.Tx, s *store.Snapshot) (float64, int64, error) {
	var xp float64
	var at int64
	err := tx.QueryRowContext(ctx, `SELECT reported_xp,created_at FROM (
 SELECT reported_xp,created_at FROM ledger WHERE account_id=? AND id>?
 AND reason IN ('sync','pending-held') AND reported_xp IS NOT NULL
 UNION ALL
 SELECT reported_xp,created_at FROM pending_credits WHERE account_id=? AND created_at>?
 ) ORDER BY reported_xp DESC,created_at ASC LIMIT 1`, s.AccountID, s.CheckpointLedgerID, s.AccountID, s.CheckpointAt).Scan(&xp, &at)
	if err == sql.ErrNoRows {
		return 0, 0, nil
	}
	return xp, at, err
}
