package api

import (
	"context"
	"database/sql"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
	"slices"
)

func (a *Server) spendOp(w http.ResponseWriter, r *http.Request) error {
	req := &contract.SpendRequest{}
	if e := decodeOp(w, r, req); e != nil {
		return e
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if !slices.Contains([]string{"rest", "home-rest", "road-lantern", "chest"}, req.Kind) || req.Kind == "road-lantern" && !slices.Contains(rules.E.RoadLanterns, req.Target) {
			return nil, fail(400, "invalid-spend")
		}
		if req.Kind == "rest" || req.Kind == "home-rest" {
			if e := barrier(ctx, tx, s, req.Op); e != nil {
				return nil, e
			}
			s.VitalsWritten = true
		}
		if req.Kind == "rest" && content.RootArea(s.State.Area) != "village" {
			return nil, fail(409, "not-at-safe-boundary")
		}
		if req.Kind == "home-rest" {
			if e := checkHomeRest(ctx, tx, s, now); e != nil {
				return nil, e
			}
		}
		if req.Kind == "road-lantern" && s.State.Area != "woodland" || req.Kind == "chest" && s.State.Area != "ruin" {
			return nil, fail(409, "wrong-area")
		}
		before := s.State
		after, e := rules.SpendEmbers(before, rules.Spend{Kind: req.Kind, ID: req.Target}, true)
		if e != nil {
			return nil, fail(409, e.Error())
		}
		if e = store.Credit(ctx, tx, s, after.Embers-before.Embers, after.XPEmbers-before.XPEmbers, "spend", req.Kind+":"+req.Target, nil, now); e != nil {
			return nil, e
		}
		s.State = after
		outcome := ""
		if req.Kind == "road-lantern" {
			outcome = "lit:" + req.Target
		}
		if req.Kind == "chest" {
			outcome = "opened:" + rules.E.ChestID
			if e = grantOnce(ctx, tx, s.AccountID, rules.E.CharmItem, "chest-charm", now); e != nil {
				return nil, e
			}
		}
		if outcome != "" {
			if _, e = store.Outcome(ctx, tx, s.AccountID, outcome, "spend", now); e != nil {
				return nil, e
			}
		}
		return &contract.SpendResult{Outcome: outcome}, nil
	})
}
