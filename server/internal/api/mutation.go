package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"glimway/server/internal/itemmove"
	"glimway/server/internal/store"
	"net/http"
	"time"
)

func (a *Server) begin(r *http.Request) (*sql.Tx, store.Snapshot, string, error) {
	tx, err := a.Store.DB.BeginTx(r.Context(), nil)
	if err != nil {
		return nil, store.Snapshot{}, "", err
	}
	id, hash, err := a.auth(r.Context(), tx, r)
	if err != nil {
		tx.Rollback()
		return nil, store.Snapshot{}, "", err
	}
	if _, err = store.ReturnDueMailTx(r.Context(), tx, a.Config.Now().Unix(), id); err != nil {
		tx.Rollback()
		return nil, store.Snapshot{}, "", err
	}
	s, err := a.Config.State.Load(r.Context(), tx, id)
	if err != nil {
		tx.Rollback()
		return nil, s, "", err
	}
	return tx, s, hash, nil
}

func (a *Server) finish(w http.ResponseWriter, r *http.Request, tx *sql.Tx, v any, afterCommit ...func()) error {
	var cookie *http.Cookie
	var expiry int64
	if c, err := r.Cookie(CookieName); err == nil {
		cookie = c
		if err = tx.QueryRowContext(r.Context(), "SELECT expires_at FROM sessions WHERE id_hash=?", store.Hash(c.Value)).Scan(&expiry); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, notify := range afterCommit {
		notify()
	}
	if cookie != nil {
		a.cookie(w, cookie.Value, time.Unix(expiry, 0))
	}
	write(w, 200, v)
	return nil
}

func currency(ctx context.Context, tx *sql.Tx, id, currency string, delta int, reason, ref string, now int64) error {
	return itemmove.RecordCurrency(ctx, tx, id, currency, delta, reason, ref, now)
}
func debitEmbers(ctx context.Context, tx *sql.Tx, s *store.Snapshot, n int, reason, ref string, now int64) error {
	if s.State.Embers < n {
		return fail(409, "insufficient-embers")
	}
	earned := max(0, n-(s.State.Embers-s.State.XPEmbers))
	return store.Credit(ctx, tx, s, -n, -earned, reason, ref, nil, now)
}

// Domain reads carry the same current PlayerState as keyed answers; their
// independent home, storage and social data lives under result.
func (a *Server) finishRead(w http.ResponseWriter, r *http.Request, tx *sql.Tx, s store.Snapshot, result any) error {
	state, err := a.Config.State.PlayerState(r.Context(), tx, s)
	if err != nil {
		return err
	}
	raw, err := mixedBytes(state, result)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, json.RawMessage(raw))
}
