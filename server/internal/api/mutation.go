package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"glimway/server/internal/itemmove"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
	"slices"
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
	s, err := store.Load(r.Context(), tx, id)
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

type Mutation struct {
	Lease   string `json:"lease"`
	BaseRev *int64 `json:"baseRev"`
}

func (a *Server) lease(ctx context.Context, tx *sql.Tx, s store.Snapshot, m Mutation) error {
	if !s.LeaseID.Valid || m.Lease == "" || m.Lease != s.LeaseID.String {
		return fail(409, "superseded")
	}
	if s.SaveOrigin == nil {
		return fail(409, "origin-required")
	}
	_, err := tx.ExecContext(ctx, "UPDATE players SET lease_seen_at=? WHERE habitica_id=?", a.Config.Now().Unix(), s.HabiticaID)
	return err
}

func revision(s store.Snapshot, m Mutation, current bool) error {
	if m.BaseRev == nil || *m.BaseRev < 0 || *m.BaseRev > s.Rev {
		return fail(409, "invalid-revision")
	}
	if current && *m.BaseRev != s.Rev {
		return fail(409, "stale-revision")
	}
	return nil
}

// upload merges a progress document. It reports the story beats the merge
// added (witness.go), none for a stale one: that is another device's
// catching up, not a moment anyone stands beside.
func upload(ctx context.Context, tx *sql.Tx, s *store.Snapshot, raw json.RawMessage, stale bool, now int64) ([]string, error) {
	maxHP, maxMana := s.State.MaxHP, s.State.MaxMana
	if stale {
		maxHP = 1e6
		maxMana = 1e6
	}
	p, err := rules.DecodeProgress(raw, maxHP, maxMana)
	if err != nil {
		return nil, fail(400, "invalid-progress")
	}
	if !stale && s.VitalsSource == "imported" && s.ImportedProfile != nil && s.State.HP <= 0 && s.ImportedProfile.HP <= 0 && p.HP != 0 {
		return nil, fail(400, "invalid-progress")
	}
	before := s.State
	s.State = rules.Merge(s.State, p, stale)
	if !rules.ValidMerged(s.State) {
		return nil, fail(400, "invalid-progress")
	}
	var beats []string
	if !stale {
		beats = storyBeats(before, s.State)
	}
	return beats, gifts(ctx, tx, s, now)
}

func gifts(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) error {
	for _, g := range []struct{ event, stage string }{{"defeat-guardian", "guardian-defeated"}, {"return-village", "complete"}} {
		if slices.Index(rules.Stages, s.State.Quest) < slices.Index(rules.Stages, g.stage) {
			continue
		}
		added, err := store.Outcome(ctx, tx, s.HabiticaID, "quest-gift:"+g.event, "quest", now)
		if err != nil {
			return err
		}
		if added {
			if err = store.Credit(ctx, tx, s, rules.E.QuestEmbers[g.event], 0, "quest", g.event, nil, now); err != nil {
				return err
			}
		}
	}
	// Settling the Warden is a story beat only: no warden-stone sliver. Slivers
	// come from the deep Tangle and the Whitequiet (maybeGrantWardenSliver).
	return nil
}

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
	return itemmove.RecordCurrency(ctx, tx, id, currency, delta, reason, ref, now)
}
func debitEmbers(ctx context.Context, tx *sql.Tx, s *store.Snapshot, n int, reason, ref string, now int64) error {
	if s.State.Embers < n {
		return fail(409, "insufficient-embers")
	}
	earned := max(0, n-(s.State.Embers-s.State.XPEmbers))
	return store.Credit(ctx, tx, s, -n, -earned, reason, ref, nil, now)
}
