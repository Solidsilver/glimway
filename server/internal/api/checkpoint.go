package api

import (
	"context"
	"database/sql"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
)

// Checkpoints audit the latest accepted report. The paid mark is deliberately
// independent: a death/rebirth does not make regained XP payable a second time.
func checkpoint(ctx context.Context, tx *sql.Tx, s *store.Snapshot, p rules.Profile, now int64) error {
	verified := rules.LifetimeXP(p.Level, *p.Exp)
	prior := s.ImportedProfile
	if prior == nil {
		prior = &s.Checkpoint
	}
	plausible, rebirth := rules.ReportLoss(p, *prior, rules.E.CheckpointToleranceXP)
	changed := false
	if rebirth && s.Checkpoint.Level > 1 {
		if err := store.Credit(ctx, tx, s, 0, 0, "rebirth", "checkpoint", &verified, now); err != nil {
			return err
		}
	}
	if !plausible {
		if _, err := tx.ExecContext(ctx, "UPDATE players SET flagged_at=COALESCE(flagged_at,?) WHERE habitica_id=?", now, s.HabiticaID); err != nil {
			return err
		}
		changed = !s.Flagged || s.Pending > 0
		s.Flagged = true
		if s.Pending > 0 {
			if err := store.Credit(ctx, tx, s, 0, 0, "pending-dropped", "implausible-checkpoint", &verified, now); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "DELETE FROM pending_credits WHERE habitica_id=?", s.HabiticaID); err != nil {
				return err
			}
			s.Pending = 0
		}
	} else {
		var confirmed int
		if err := tx.QueryRowContext(ctx, "SELECT COALESCE(SUM(embers),0) FROM pending_credits WHERE habitica_id=? AND reported_xp<=?", s.HabiticaID, verified).Scan(&confirmed); err != nil {
			return err
		}
		if confirmed > 0 {
			if err := store.Credit(ctx, tx, s, confirmed, confirmed, "pending-settled", "checkpoint", &verified, now); err != nil {
				return err
			}
			if _, err := tx.ExecContext(ctx, "DELETE FROM pending_credits WHERE habitica_id=? AND reported_xp<=?", s.HabiticaID, verified); err != nil {
				return err
			}
			s.Pending -= confirmed
			changed = true
		}
	}
	if changed {
		return store.Persist(ctx, tx, s, now)
	}
	return nil
}
