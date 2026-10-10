package api

import (
	"context"
	"database/sql"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"math"
	"net/http"
)

// boundReport consumes the persistent budgets (crafts.md 4.4): the signature
// on cast_ready_at, each combat move on player_ability_ready, one mana pool
// across them in table order, and the ward credit other healers left. Pure
// rules live in rules.BoundReport.
func boundReport(s store.Snapshot, hp, mana, casts float64, abilityCasts map[string]float64, at, ready float64, abilityReady map[string]float64, now, allyCredit float64) rules.AbilityBudget {
	return rules.BoundReport(rules.ReportInput{
		State: s.State, Profile: s.ImportedProfile, LevelMark: s.LevelMark, ClassMark: s.ClassMark,
		HP: hp, Mana: mana, Casts: casts, AbilityCasts: abilityCasts,
		At: at, Ready: ready, AbilityReady: abilityReady, Now: now, AllyCredit: allyCredit,
	})
}

func (a *Server) report(w http.ResponseWriter, r *http.Request) error {
	req := &contract.ReportRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now()
	at := float64(now.UnixNano()) / 1e9
	if err = a.requireLease(ctx, tx, s, req.Lease); err != nil {
		return err
	}
	refuse := func(code string) error {
		state, e := a.Config.State.PlayerState(ctx, tx, s)
		if e != nil {
			return e
		}
		if e = tx.Commit(); e != nil {
			return e
		}
		writeRefusal(w, 409, code, state)
		return nil
	}
	var client, generation string
	var seq, basis, setVersion, vitalsAt, ready, placeVersion float64
	var reportAt sql.NullInt64
	err = tx.QueryRowContext(ctx, "SELECT report_client,report_generation,report_seq,report_basis,vitals_set_version,vitals_at,cast_ready_at,report_at FROM player_vitals WHERE account_id=?", s.AccountID).Scan(&client, &generation, &seq, &basis, &setVersion, &vitalsAt, &ready, &reportAt)
	if err != nil {
		return err
	}
	if req.Client != client || req.Generation != generation {
		return fail(409, "superseded")
	}
	if req.Seq < 1 || req.Basis > float64(s.Version) {
		return refuse("invalid-revision")
	}
	if req.Place == nil || !validArea(req.Place.Area) || !finiteWhere(req.Place) {
		return refuse("invalid-position")
	}
	out := &contract.ReportResult{Client: client, Generation: generation, Seq: req.Seq, Basis: basis, PlaceIgnored: true, AbilityCasts: map[string]float64{}}
	for id := range req.AbilityCasts {
		out.AbilityCasts[id] = 0
	}
	// The ward credit is reserved under the hub's lock before the budget
	// reads it (review finding 11), never peeked: two reports in one ward
	// window spend one credit once. It settles right after the commit, before
	// the response is written (review finding 1) — the store's connection is
	// free again at the commit, and a second report must find a settled pool,
	// never an open reservation whose leftovers nobody returns. The defer
	// only covers the error paths, where the report never landed.
	var reserveSeq float64
	reserved, settled := false, false
	defer func() {
		if reserved && !settled {
			a.settleWardCredit(s.AccountID, reserveSeq, 0)
		}
	}()
	if req.Seq > seq {
		if err = tx.QueryRowContext(ctx, "SELECT place_set_version FROM player_place WHERE account_id=?", s.AccountID).Scan(&placeVersion); err != nil {
			return err
		}
		out.StaleBasis = req.Basis < setVersion
		if out.StaleBasis {
			_, err = tx.ExecContext(ctx, "UPDATE player_vitals SET report_seq=? WHERE account_id=?", req.Seq, s.AccountID)
		} else {
			out.Accepted = true
			out.Basis = req.Basis
			out.PlaceIgnored = req.Basis < placeVersion
			var abilityReady map[string]float64
			if abilityReady, err = store.AbilityReady(ctx, tx, s.AccountID); err != nil {
				return err
			}
			// The ward credit is reserved for this report (review finding
			// 11): a second report in the same window sees none of it.
			reserved, reserveSeq = true, req.Seq
			budget := boundReport(s, req.Hp, req.Mana, req.Casts, req.AbilityCasts, vitalsAt, ready, abilityReady, at, a.reserveWardCredit(s.AccountID, req.Seq))
			s.State.HP, s.State.Mana = budget.HP, budget.Mana
			out.Casts, out.AbilityCasts, out.AllyHeal, ready = budget.Casts, budget.AbilityCasts, budget.AllyHeal, budget.Ready
			if reportAt.Valid {
				s.State.PlaySeconds += math.Min(content.VitalsRules.ReportGapCap, math.Max(0, float64(now.Unix()-reportAt.Int64)))
			}
			if !out.PlaceIgnored {
				s.State.Area = req.Place.Area
				s.State.Position = rulesPosition(req.Place)
				if a.Config.Placement != nil {
					if err = a.Config.Placement.Record(ctx, tx, &s, req.Place, now.Unix()); err != nil {
						return err
					}
				}
			}
			_, err = tx.ExecContext(ctx, "UPDATE player_vitals SET hp=?,mana=?,vitals_at=?,cast_ready_at=?,report_seq=?,report_basis=?,report_at=? WHERE account_id=?", s.State.HP, s.State.Mana, at, ready, req.Seq, req.Basis, now.Unix(), s.AccountID)
			if err != nil {
				return err
			}
			// Each move's cooldown debt (4.4), the same persistence rule as
			// the signature's. A report that applied nothing leaves the rows.
			for id, next := range budget.AbilityReady {
				if _, err = tx.ExecContext(ctx, "INSERT INTO player_ability_ready(account_id,ability,ready_at) VALUES(?,?,?) ON CONFLICT(account_id,ability) DO UPDATE SET ready_at=excluded.ready_at", s.AccountID, id, next); err != nil {
					return err
				}
			}
		}
		if err != nil {
			return err
		}
		if err = a.Config.State.Persist(ctx, tx, &s, now.Unix()); err != nil {
			return err
		}
	}
	state, err := a.Config.State.PlayerState(ctx, tx, s)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	// The report landed: spend what its HP took and return the rest now
	// (review finding 1), before the response is written.
	settled = true
	a.settleWardCredit(s.AccountID, reserveSeq, out.AllyHeal)
	return writeOpResult(w, state, out)
}

// Required barriers are checked in the callback, after replay has already returned.
func barrier(ctx context.Context, tx *sql.Tx, s *store.Snapshot, op *contract.OpHeader) error {
	if op == nil {
		return fail(409, "report-required")
	}
	return requireReportBarrier(ctx, tx, s.AccountID, op.Report)
}
