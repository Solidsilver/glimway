package api

import (
	"context"
	"database/sql"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"math"
	"net/http"
)

// BoundReport consumes a persistent signature budget; reporting never refills it.
func boundReport(s store.Snapshot, hp, mana, casts, at, ready, now float64) (float64, float64, float64, float64) {
	elapsed := math.Max(0, now-at)
	ready = math.Max(ready, at)
	allowed := float64(0)
	cost, heal := float64(0), float64(0)
	if p := s.ImportedProfile; p != nil && p.Class != nil && s.State.HP > 0 {
		if c, ok := content.CombatRules.GetClasses()[*p.Class]; ok {
			cost = c.GetCastCost()
			slots := math.Max(0, 1+math.Floor((now-ready)/content.CombatRules.GetSignatureCooldownSeconds()))
			allowed = math.Min(casts, math.Min(slots, math.Floor((s.State.Mana+content.VitalsRules.GetRegenCap()*elapsed)/cost)))
			if *p.Class == "healer" {
				h := content.CombatRules.GetHeal()
				scale := math.Pow10(int(h.GetDecimalPlaces()))
				heal = math.Floor((h.GetBase()+h.GetMaximumBonus()*p.Stats.Int/(p.Stats.Int+h.GetHalfway()))*scale+.5) / scale
			}
		}
	}
	hp = math.Min(hp, math.Min(s.State.MaxHP, s.State.HP+allowed*heal))
	mana = math.Min(mana, math.Max(0, math.Min(s.State.MaxMana, s.State.Mana+content.VitalsRules.GetRegenCap()*elapsed-allowed*cost)))
	return hp, mana, allowed, math.Max(now, ready+allowed*content.CombatRules.GetSignatureCooldownSeconds())
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
	out := &contract.ReportResult{Client: client, Generation: generation, Seq: req.Seq, Basis: basis, PlaceIgnored: true}
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
			s.State.HP, s.State.Mana, out.Casts, ready = boundReport(s, req.Hp, req.Mana, req.Casts, vitalsAt, ready, at)
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
	return writeOpResult(w, state, out)
}

// Required barriers are checked in the callback, after replay has already returned.
func barrier(ctx context.Context, tx *sql.Tx, s *store.Snapshot, op *contract.OpHeader) error {
	if op == nil {
		return fail(409, "report-required")
	}
	return requireReportBarrier(ctx, tx, s.AccountID, op.Report)
}
