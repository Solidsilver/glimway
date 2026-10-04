package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/store"
	"net/http"
)

// keyedMutation shares the phase-2 commit boundary: lease, replay, revision,
// optional progress, gameplay, persistence, response cache, commit.
func (a *Server) keyedMutation(w http.ResponseWriter, r *http.Request, m Mutation, key string, request any, progress json.RawMessage, apply func(context.Context, *sql.Tx, *store.Snapshot, int64) (any, error)) error {
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
	if len(progress) > 0 && string(progress) != "null" {
		if err = upload(ctx, tx, &s, progress, false, now); err != nil {
			return err
		}
	}
	extra, err := apply(ctx, tx, &s, now)
	if err != nil {
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
	return a.finish(w, r, tx, v)
}
func currency(ctx context.Context, tx *sql.Tx, id, currency string, delta int, reason, ref string, now int64) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO ledger(habitica_id,currency,delta,earned_delta,reason,ref,created_at) VALUES(?,?,?,0,?,?,?)", id, currency, delta, reason, ref, now)
	return err
}
func materialChange(ctx context.Context, tx *sql.Tx, id, material string, delta int, reason, ref string, now int64) error {
	// Negative changes must check the balance before touching any currency.
	var err error
	if delta < 0 {
		var res sql.Result
		res, err = tx.ExecContext(ctx, "UPDATE materials SET qty=qty+? WHERE habitica_id=? AND material=? AND qty>=?", delta, id, material, -delta)
		if err == nil {
			var n int64
			n, err = res.RowsAffected()
			if err == nil && n != 1 {
				return fail(409, "insufficient-materials")
			}
		}
	} else {
		_, err = tx.ExecContext(ctx, `INSERT INTO materials VALUES(?,?,?) ON CONFLICT(habitica_id,material) DO UPDATE SET qty=qty+excluded.qty`, id, material, delta)
	}
	if err != nil {
		return err
	}
	return currency(ctx, tx, id, "material:"+material, delta, reason, ref, now)
}
func materials(ctx context.Context, tx *sql.Tx, id string) (map[string]int, error) {
	out := map[string]int{}
	for _, m := range content.WildsRules.Materials {
		out[m] = 0
	}
	rows, err := tx.QueryContext(ctx, "SELECT material,qty FROM materials WHERE habitica_id=?", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var m string
		var n int
		if err = rows.Scan(&m, &n); err != nil {
			return nil, err
		}
		out[m] = n
	}
	return out, rows.Err()
}
func debitEmbers(ctx context.Context, tx *sql.Tx, s *store.Snapshot, n int, reason, ref string, now int64) error {
	if s.State.Embers < n {
		return fail(409, "insufficient-embers")
	}
	earned := max(0, n-(s.State.Embers-s.State.XPEmbers))
	return store.Credit(ctx, tx, s, -n, -earned, reason, ref, nil, now)
}
