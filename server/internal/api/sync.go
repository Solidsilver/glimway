package api

import (
	"encoding/json"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"math"
	"net/http"
	"strconv"
)

func (a *Server) sync(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		Profile  json.RawMessage `json:"profile"`
		Progress json.RawMessage `json:"progress"`
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
	if err = revision(s, req.Mutation, true); err != nil {
		return err
	}
	p, err := rules.DecodeProfile(req.Profile)
	if err != nil {
		return fail(422, "implausible-profile")
	}
	if p.ID != s.HabiticaID {
		return fail(409, "account-switch")
	}
	if !rules.Plausible(p) {
		return fail(422, "implausible-profile")
	}
	beats, err := upload(ctx, tx, &s, req.Progress, false, now)
	if err != nil {
		return err
	}
	if !rules.IsSafeArea(s.State.Area) {
		return fail(409, "not-at-safe-boundary")
	}
	p.MP = math.Min(p.MP, p.MaxMP)
	before := s.State
	reported := rules.LifetimeXP(p.Level, *p.Exp)
	if rules.IsRebirth(p, s.LossReference, s.VerifiedHighLevel) {
		if err = store.Credit(ctx, tx, &s, 0, 0, "rebirth", "sync", &reported, now); err != nil {
			return err
		}
	} else if s.LossReference.XP-reported > rules.DeathWindow(s.LossReference.Level) {
		if err = store.Credit(ctx, tx, &s, 0, 0, "xp-loss", "sync", &reported, now); err != nil {
			return err
		}
	}
	if _, err = expirePending(ctx, tx, &s, now); err != nil {
		return err
	}
	if err = store.SetLossReference(ctx, tx, &s, p, now); err != nil {
		return err
	}
	r0 := rules.Sync(rules.Save{State: s.State, VitalsSource: s.VitalsSource, ImportedProfile: s.ImportedProfile}, p, true)
	s.State = r0.Save.State
	s.ImportedProfile = r0.Save.ImportedProfile
	s.VitalsSource = r0.Save.VitalsSource
	credit := s.State.Embers - before.Embers
	// The checkpoint allowance grows by full days, never by request count.
	days := max(int64(0), (now-s.CheckpointAt)/86400)
	cap := rules.E.SyncCreditCap + int(min(days, int64(rules.E.SyncCreditMax)))*rules.E.SyncCreditDailyGrowth
	cap = min(cap, rules.E.SyncCreditMax)
	payable := max(0, int(math.Floor(s.VerifiedXP/float64(rules.E.XPPerEmber)))+cap-int(math.Floor(before.EmberXP/float64(rules.E.XPPerEmber))))
	paid := min(credit, payable)
	s.State.Embers = before.Embers
	s.State.XPEmbers = before.XPEmbers
	s.Pending += credit - paid
	if paid > 0 {
		if err = store.Credit(ctx, tx, &s, paid, paid, "sync", "xp", &reported, now); err != nil {
			return err
		}
	}
	if credit > paid {
		if _, err = tx.ExecContext(ctx, "INSERT INTO pending_credits VALUES(?,?,?,?)", s.HabiticaID, reported, credit-paid, now); err != nil {
			return err
		}
		if err = store.Credit(ctx, tx, &s, 0, 0, "pending-held", strconv.Itoa(credit-paid), &reported, now); err != nil {
			return err
		}
	}
	welcomed, err := store.Outcome(ctx, tx, s.HabiticaID, "embers:welcome", "welcome", now)
	if err != nil {
		return err
	}
	if welcomed {
		if err = store.Credit(ctx, tx, &s, rules.E.WelcomeEmbers, 0, "welcome", "first-sync", nil, now); err != nil {
			return err
		}
		s.State.Flags = rules.AddUnique(s.State.Flags, "embers:welcome")
	}
	if err = store.Persist(ctx, tx, &s, now); err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Status       string             `json:"status"`
		VitalsCredit map[string]float64 `json:"vitalsCredit"`
	}{s, r0.Status, map[string]float64{"hp": s.State.HP - before.HP, "mana": s.State.Mana - before.Mana}}, a.witnessed(s, beats))
}
