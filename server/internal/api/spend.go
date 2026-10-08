package api

import (
	"encoding/json"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
	"slices"
)

func (a *Server) spend(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		Kind     string          `json:"kind"`
		Target   string          `json:"target,omitempty"`
		Progress json.RawMessage `json:"progress,omitempty"`
		Key      string          `json:"key"`
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
	now := a.Config.Now().Unix()
	if err = a.lease(ctx, tx, s, req.Mutation); err != nil {
		return err
	}
	hash, prior, err := idem(ctx, tx, s.AccountID, "spend", req.Key, req, now)
	if err != nil {
		return err
	}
	if prior != "" {
		return a.finish(w, r, tx, json.RawMessage(prior))
	}
	if err = revision(s, req.Mutation, true); err != nil {
		return err
	}
	var beats []string
	if len(req.Progress) > 0 && string(req.Progress) != "null" {
		if beats, err = upload(ctx, tx, &s, req.Progress, false, now); err != nil {
			return err
		}
	}
	if !slices.Contains([]string{"rest", "revive", "home-rest", "road-lantern", "chest"}, req.Kind) || req.Kind == "road-lantern" && !slices.Contains(rules.E.RoadLanterns, req.Target) {
		return fail(400, "invalid-spend")
	}
	if (req.Kind == "rest" || req.Kind == "revive") && s.State.Area != "village" {
		return fail(409, "not-at-safe-boundary")
	}
	if req.Kind == "revive" && s.State.HP > 0 {
		return fail(409, "not-defeated")
	}
	if req.Kind == "home-rest" {
		if err = checkHomeRest(ctx, tx, &s, now); err != nil {
			return err
		}
	}
	before := s.State
	after, err := rules.SpendEmbers(before, rules.Spend{Kind: req.Kind, ID: req.Target}, true)
	if err != nil {
		return fail(409, err.Error())
	}
	if err = store.Credit(ctx, tx, &s, after.Embers-before.Embers, after.XPEmbers-before.XPEmbers, "spend", req.Kind+":"+req.Target, nil, now); err != nil {
		return err
	}
	s.State = after
	outcome := ""
	switch req.Kind {
	case "road-lantern":
		outcome = "lit:" + req.Target
	case "chest":
		outcome = "opened:" + rules.E.ChestID
		if err = grantOnce(ctx, tx, s.AccountID, rules.E.CharmItem, "chest-charm", now); err != nil {
			return err
		}
	}
	if outcome != "" {
		if _, err = store.Outcome(ctx, tx, s.AccountID, outcome, "spend", now); err != nil {
			return err
		}
	}
	if err = store.Persist(ctx, tx, &s, now); err != nil {
		return err
	}
	v := struct {
		store.Snapshot
		Outcome string `json:"outcome"`
	}{s, outcome}
	if err = saveIdem(ctx, tx, s.AccountID, "spend", req.Key, hash, v, now); err != nil {
		return err
	}
	return a.finish(w, r, tx, v, a.witnessed(s, beats))
}
