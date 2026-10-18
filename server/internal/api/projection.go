package api

import (
	"context"
	"database/sql"
	"errors"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"net/http"
	"sync"
	"time"
)

func (a *Server) requestTime(ctx context.Context) time.Time {
	if now, ok := chunks.ReadTime(ctx); ok {
		return now
	}
	return a.Config.Now()
}

// txClock is a request's operation clock. It samples on first use and is
// cleared by every beginTx, so each transaction's time is taken after it
// holds the store's one write connection, never before an upstream wait.
type txClock struct {
	mu  sync.Mutex
	now func() time.Time
	at  time.Time
	set bool
}

func (c *txClock) read() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.set {
		c.at, c.set = c.now(), true
	}
	return c.at
}

type txClockKey struct{}

// withTxClock binds a fresh operation clock to r (ServeHTTP, DevGrant).
func (a *Server) withTxClock(r *http.Request) (*http.Request, func() time.Time) {
	c := &txClock{now: a.Config.Now}
	ctx := context.WithValue(r.Context(), txClockKey{}, c)
	return r.WithContext(chunks.WithReadClock(ctx, c.read)), c.read
}

// beginTx opens a transaction and restarts the request's clock: the next
// requestTime reads after the store's lock is held.
func (a *Server) beginTx(ctx context.Context) (*sql.Tx, error) {
	tx, err := a.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	if c, ok := ctx.Value(txClockKey{}).(*txClock); ok {
		c.mu.Lock()
		c.set = false
		c.mu.Unlock()
	}
	return tx, nil
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
	// A turning may have shrunk the reach around where they stand.
	moved, err := a.settleReach(ctx, tx, s, now.Unix())
	if err != nil {
		return false, err
	}
	return version != 0 || before != after || moved, nil
}

// maintainAndProjectState owns response-time maintenance on success, refusal,
// replay and GET. It refreshes a changed snapshot, then runs read-only decorators
// with the same timestamp. Begin-time top-up settlement must not be substituted
// for this phase: domain work may have changed eligible rows in the transaction.
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
