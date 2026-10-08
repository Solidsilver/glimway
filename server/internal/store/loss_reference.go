package store

import (
	"context"
	"database/sql"
	"glimway/server/internal/rules"
)

func SetLossReference(ctx context.Context, tx *sql.Tx, s *Snapshot, p rules.Profile, now int64) error {
	s.LossReference = rules.LossReference{Level: p.Level, XP: rules.LifetimeXP(p.Level, *p.Exp)}
	s.LossAt = now
	_, err := tx.ExecContext(ctx, "UPDATE sync_baselines SET loss_level=?,loss_xp=?,loss_at=? WHERE habitica_id=?", s.LossReference.Level, s.LossReference.XP, now, s.HabiticaID)
	return err
}
