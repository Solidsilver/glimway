package api

import (
	"encoding/json"
	"glimway/server/internal/store"
	"net/http"
)

func (a *Server) progress(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		Doc json.RawMessage `json:"doc"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	if err = a.lease(ctx, tx, s, req.Mutation); err != nil {
		return err
	}
	if err = revision(s, req.Mutation, false); err != nil {
		return err
	}
	stale := *req.BaseRev < s.Rev
	status := "current"
	if stale {
		status = "stale"
	}
	beats, err := upload(ctx, tx, &s, req.Doc, stale, a.Config.Now().Unix())
	if err != nil {
		return err
	}
	if err = store.Persist(ctx, tx, &s, a.Config.Now().Unix()); err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Status string `json:"status"`
	}{s, status}, a.witnessed(s, beats))
}
