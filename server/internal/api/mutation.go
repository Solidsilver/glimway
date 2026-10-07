package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"glimway/server/internal/store"
	"net/http"
)

// keyedMutation shares the gameplay commit boundary: lease, replay, revision,
// optional progress, gameplay, persistence, response cache, commit.
func (a *Server) keyedMutation(w http.ResponseWriter, r *http.Request, m Mutation, key string, request any, progress json.RawMessage, apply func(context.Context, *sql.Tx, *store.Snapshot, int64) (any, error), afterCommit ...func()) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now().Unix()
	op := r.URL.Path
	if err = a.lease(ctx, tx, s, m); err != nil {
		return err
	}
	hash, prior, err := idem(ctx, tx, s.HabiticaID, op, key, request, now)
	if err != nil {
		return err
	}
	if prior != "" {
		return a.finish(w, r, tx, json.RawMessage(prior))
	}
	if err = revision(s, m, true); err != nil {
		return err
	}
	var beats []string
	if len(progress) > 0 && string(progress) != "null" {
		if beats, err = upload(ctx, tx, &s, progress, false, now); err != nil {
			return err
		}
	}
	extra, err := apply(ctx, tx, &s, now)
	if err != nil {
		return err
	}
	// Pockets and the off hand only point at what is still carried.
	if err = settleSlots(ctx, tx, &s); err != nil {
		return err
	}
	if err = store.Persist(ctx, tx, &s, now); err != nil {
		return err
	}
	// The existing snapshot remains top-level. New endpoint data is under result.
	v := struct {
		store.Snapshot
		Result any `json:"result"`
	}{s, extra}
	if err = saveIdem(ctx, tx, s.HabiticaID, op, key, hash, v, now); err != nil {
		return err
	}
	return a.finish(w, r, tx, v, append(afterCommit, a.witnessed(s, beats))...)
}
func currency(ctx context.Context, tx *sql.Tx, id, currency string, delta int, reason, ref string, now int64) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO ledger(habitica_id,currency,delta,earned_delta,reason,ref,created_at) VALUES(?,?,?,0,?,?,?)", id, currency, delta, reason, ref, now)
	return err
}
func debitEmbers(ctx context.Context, tx *sql.Tx, s *store.Snapshot, n int, reason, ref string, now int64) error {
	if s.State.Embers < n {
		return fail(409, "insufficient-embers")
	}
	earned := max(0, n-(s.State.Embers-s.State.XPEmbers))
	return store.Credit(ctx, tx, s, -n, -earned, reason, ref, nil, now)
}
