package api

import (
	"context"
	"database/sql"
	"errors"
	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/ports"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/proto"
	"math"
	"net/http"
	"slices"
	"strings"
)

const maxStoryMarks = 4096

func (a *Server) questStep(w http.ResponseWriter, r *http.Request) error {
	req := &contract.QuestStepRequest{}
	if e := decodeOp(w, r, req); e != nil {
		return e
	}
	var relay func()
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if req.Quest != "lantern-road" {
			return nil, fail(409, "not-next-step")
		}
		idx := content.QuestIndex(s.State.Quest) + 1
		if idx < 0 || idx >= len(content.QuestRules[0].Steps) {
			return nil, fail(409, "not-next-step")
		}
		step := content.QuestRules[0].Steps[idx]
		if step.ID != req.To {
			return nil, fail(409, "not-next-step")
		}
		if s.State.Area != step.At {
			return nil, fail(409, "wrong-area")
		}
		s.State.Quest = step.ID
		s.State.Inventory = rules.AddUnique(s.State.Inventory, step.Items...)
		for _, m := range step.Marks {
			switch {
			case strings.HasPrefix(m, "found:"):
				s.State.Discoveries = rules.AddUnique(s.State.Discoveries, strings.TrimPrefix(m, "found:"))
			case strings.HasPrefix(m, "defeated:"):
				s.State.DefeatedEnemies = rules.AddUnique(s.State.DefeatedEnemies, strings.TrimPrefix(m, "defeated:"))
			default:
				s.State.Flags = rules.AddUnique(s.State.Flags, m)
			}
		}
		for _, p := range step.Papers {
			if _, e := a.Config.Story.Grant(ctx, tx, s, p, now); e != nil {
				return nil, e
			}
		}
		paid := 0
		if step.Embers > 0 {
			outcome := "quest-gift:" + req.Quest + ":" + step.ID
			added, e := store.Outcome(ctx, tx, s.AccountID, outcome, "quest", now)
			if e != nil {
				return nil, e
			}
			if added {
				paid = step.Embers
				if e = store.Credit(ctx, tx, s, paid, 0, "quest", outcome, nil, now); e != nil {
					return nil, e
				}
			}
		}
		if step.Witness != "" {
			relay = a.witnessed(*s, []string{step.Witness})
		}
		return &contract.QuestStepResult{Quest: req.Quest, Step: step.ID, Items: step.Items, Marks: step.Marks, Papers: step.Papers, Embers: float64(paid)}, nil
	}, func() {
		if relay != nil {
			relay()
		}
	})
}
func (a *Server) mark(w http.ResponseWriter, r *http.Request) error {
	req := &contract.MarkRequest{}
	if e := decodeOp(w, r, req); e != nil {
		return e
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		writer := content.MarkWriter(req.Mark)
		if writer == "server" {
			return nil, fail(409, "server-mark")
		}
		if writer == "" {
			return nil, fail(409, "unknown-mark")
		}
		for prefix, ids := range content.StoryRules.IDs {
			if strings.HasPrefix(req.Mark, prefix) {
				area, ok := ids[strings.TrimPrefix(req.Mark, prefix)]
				if !ok {
					return nil, fail(409, "unknown-mark")
				}
				if s.State.Area != area {
					return nil, fail(409, "wrong-area")
				}
			}
		}
		if area := content.StoryRules.Areas[req.Mark]; area != "" && !(area == "home" && rules.HomeGate(s.State.Area) >= 0) && s.State.Area != area {
			return nil, fail(409, "wrong-area")
		}
		added := false
		switch {
		case strings.HasPrefix(req.Mark, "found:"):
			id := strings.TrimPrefix(req.Mark, "found:")
			added = !slices.Contains(s.State.Discoveries, id)
			s.State.Discoveries = rules.AddUnique(s.State.Discoveries, id)
		case strings.HasPrefix(req.Mark, "defeated:"):
			id := strings.TrimPrefix(req.Mark, "defeated:")
			added = !slices.Contains(s.State.DefeatedEnemies, id)
			s.State.DefeatedEnemies = rules.AddUnique(s.State.DefeatedEnemies, id)
		default:
			added = !slices.Contains(s.State.Flags, req.Mark)
			s.State.Flags = rules.AddUnique(s.State.Flags, req.Mark)
		}
		// Match 0.2 MaxMergedItems: economy outcomes are outside the story cap.
		storyCount := 0
		for _, f := range s.State.Flags {
			if !rules.EconomyFlag(f) {
				storyCount++
			}
		}
		if storyCount > maxStoryMarks || len(s.State.Discoveries) > maxStoryMarks || len(s.State.DefeatedEnemies) > maxStoryMarks {
			return nil, fail(409, "unknown-mark")
		}
		return &contract.MarkResult{Mark: req.Mark, Added: added}, nil
	})
}
func (a *Server) takePaper(w http.ResponseWriter, r *http.Request) error {
	req := &contract.TakePaperRequest{}
	if e := decodeOp(w, r, req); e != nil {
		return e
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		due, e := a.Config.Story.Eligible(ctx, tx, *s, ports.PaperInput{Paper: req.Paper, Epoch: req.Epoch, Site: req.Site, Where: req.Where})
		if e != nil {
			return nil, e
		}
		if !due {
			return nil, fail(409, "paper-not-due")
		}
		g, e := a.Config.Story.Grant(ctx, tx, s, req.Paper, now)
		return &contract.TakePaperResult{Paper: req.Paper, Added: g.Added}, e
	})
}
func (a *Server) fall(w http.ResponseWriter, r *http.Request) error {
	req := &contract.FallRequest{}
	if e := decodeOp(w, r, req); e != nil {
		return e
	}
	return a.keyedOpFinalized(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		hp, mp := s.State.MaxHP, s.State.MaxMana
		if p := s.ImportedProfile; p != nil {
			hp, mp = p.HP, p.MP
		}
		s.State.HP = math.Min(hp, math.Ceil(s.State.MaxHP*content.VitalsRules.FallHPFraction))
		s.State.Mana = math.Min(mp, math.Ceil(s.State.MaxMana*content.VitalsRules.FallManaFraction))
		s.VitalsWritten = true
		s.State.Area = "village"
		s.State.Position = rules.NewState().Position
		out := &contract.FallResult{Vitals: &contract.Vitals{Hp: s.State.HP, Mana: s.State.Mana, MaxHp: s.State.MaxHP, MaxMana: s.State.MaxMana}, Place: &contract.Place{Area: s.State.Area, X: s.State.Position.X, Y: s.State.Position.Y}, Lantern: "none", Reason: "not-wilds"}
		if region, ok := strings.CutPrefix(req.Where.Area, "wilds:"); ok {
			out.Reason = "epoch-missing"
			if a.Config.Epochs != nil && a.Config.Lanterns != nil {
				epoch, e := a.Config.Epochs.Current(ctx, tx, s.WorldID, region, now)
				if e == nil {
					g, e := a.Config.Lanterns.PlaceFallen(ctx, tx, s, epoch, req.Where, now)
					if errors.Is(e, chunks.ErrUnavailable) || errors.Is(e, store.ErrGeneratorUnavailable) {
						out.Reason = "generator-unavailable"
						return out, nil
					}
					if e != nil {
						return nil, e
					}
					out.Lantern, out.Reason, out.LanternId, out.Epoch = g.Lantern, g.Reason, g.ID, g.Epoch
				} else if errors.Is(e, chunks.ErrUnavailable) || errors.Is(e, store.ErrGeneratorUnavailable) {
					out.Reason = "generator-unavailable"
				} else if !errors.Is(e, sql.ErrNoRows) && !errors.Is(e, chunks.ErrEpochEnded) {
					return nil, e
				}
			}
		}
		return out, nil
	}, func(state *contract.PlayerState, result any) {
		out := result.(*contract.FallResult)
		out.Vitals = proto.Clone(state.Vitals).(*contract.Vitals)
		out.Place = proto.Clone(state.Place).(*contract.Place)
	})
}
