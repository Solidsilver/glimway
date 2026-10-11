package api

import (
	"context"
	"database/sql"
	"errors"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"time"
)

func (a *Server) requestTime(ctx context.Context) time.Time {
	if now, ok := chunks.ReadTime(ctx); ok {
		return now
	}
	return a.Config.Now()
}

// maintainState is an explicit write phase, before loading/projecting a response.
// It never performs upstream work. Lazy recovery skips live reservations.
func (a *Server) maintainState(ctx context.Context, tx *sql.Tx, s store.Snapshot, now time.Time) (bool, error) {
	if s.AccountID == "" {
		return false, nil
	}
	version, err := store.SettleStaleTopUps(ctx, tx, s.AccountID, now.Unix(), a.topUpLive)
	if err != nil {
		return false, err
	}
	var before, after int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM fishing_casts WHERE account_id=? AND state='open'", s.AccountID).Scan(&before); err != nil {
		return false, err
	}
	if err = sweepCasts(ctx, fishingLogf(a.Config.Logger), tx, float64(now.UnixNano())/1e9, now.Unix(), "account_id=?", s.AccountID); err != nil {
		return false, err
	}
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM fishing_casts WHERE account_id=? AND state='open'", s.AccountID).Scan(&after); err != nil {
		return false, err
	}
	if before != after {
		if _, err = store.BumpAccountVersion(ctx, tx, s.AccountID); err != nil {
			return false, err
		}
	}
	// Epoch creation is maintenance too; the rumour decorator only reads Current.
	if a.Config.WildsGenerator != nil && a.Config.Epochs != nil && s.WorldID != "" {
		_, err = chunks.Epoch(ctx, tx, a.Config.Epochs, s.WorldID, store.EpochWick, now.Unix())
		if err != nil && !errors.Is(err, store.ErrGeneratorUnavailable) && !errors.Is(err, chunks.ErrUnavailable) && !errors.Is(err, chunks.ErrEpochEnded) && !errors.Is(err, sql.ErrNoRows) {
			return false, err
		}
	}
	return version != 0 || before != after, nil
}

// maintainAndProjectState refreshes any changed
// snapshot, then runs the read-only decorators with the same timestamp.
func (a *Server) maintainAndProjectState(ctx context.Context, tx *sql.Tx, s store.Snapshot, now time.Time) (*contract.PlayerState, error) {
	changed, err := a.maintainState(ctx, tx, s, now)
	if err != nil {
		return nil, err
	}
	if changed {
		if s, err = a.Config.State.Load(ctx, tx, s.AccountID); err != nil {
			return nil, err
		}
	}
	return a.Config.State.PlayerState(ctx, tx, s, now)
}
