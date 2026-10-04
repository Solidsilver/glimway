package api

import (
	"context"
	"database/sql"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
	"strconv"
)

// Pending has its own retention clock. Neither death nor flagging confiscates
// held credit; expiry and verification are audited in the same transaction.
func expirePending(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (bool, error) {
	cutoff := now - int64(rules.E.PendingCreditDays)*86400
	var expired int
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(SUM(embers),0) FROM pending_credits WHERE habitica_id=? AND created_at<=?", s.HabiticaID, cutoff).Scan(&expired); err != nil {
		return false, err
	}
	if expired == 0 {
		return false, nil
	}
	if err := store.Credit(ctx, tx, s, 0, 0, "pending-expired", strconv.Itoa(expired), nil, now); err != nil {
		return false, err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM pending_credits WHERE habitica_id=? AND created_at<=?", s.HabiticaID, cutoff); err != nil {
		return false, err
	}
	s.Pending -= expired
	return true, nil
}
func checkpoint(ctx context.Context, tx *sql.Tx, s *store.Snapshot, p rules.Profile, now int64) error {
	verified := rules.LifetimeXP(p.Level, *p.Exp)
	changed, err := expirePending(ctx, tx, s, now)
	if err != nil {
		return err
	}
	if rules.IsRebirth(p, s.LossReference, s.VerifiedHighLevel) {
		if err = store.Credit(ctx, tx, s, 0, 0, "rebirth", "checkpoint", &verified, now); err != nil {
			return err
		}
	} else if rules.CheckpointForgery(p, s.LossReference, s.VerifiedHighLevel) && !s.Flagged {
		if _, err = tx.ExecContext(ctx, "UPDATE players SET flagged_at=? WHERE habitica_id=?", now, s.HabiticaID); err != nil {
			return err
		}
		if err = store.Credit(ctx, tx, s, 0, 0, "checkpoint-flag", "loss-reference", &verified, now); err != nil {
			return err
		}
		s.Flagged = true
		changed = true
	}
	var confirmed int
	if err = tx.QueryRowContext(ctx, "SELECT COALESCE(SUM(embers),0) FROM pending_credits WHERE habitica_id=? AND reported_xp<=?", s.HabiticaID, verified).Scan(&confirmed); err != nil {
		return err
	}
	if confirmed > 0 {
		if err = store.Credit(ctx, tx, s, confirmed, confirmed, "pending-settled", "checkpoint", &verified, now); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM pending_credits WHERE habitica_id=? AND reported_xp<=?", s.HabiticaID, verified); err != nil {
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
