package api

import (
	"encoding/json"
	"errors"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/habitica"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/encoding/protojson"
	"math"
	"net/http"
	"strconv"
)

func (a *Server) profileReport(w http.ResponseWriter, r *http.Request) error {
	req := &contract.ProfileReport{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now().Unix()
	if err = a.requireLease(ctx, tx, s, req.Lease); err != nil {
		return err
	}
	refuse := func(e error) error {
		var f *failure
		if !errors.As(e, &f) {
			return e
		}
		state, err := a.Config.State.PlayerState(ctx, tx, s)
		if err != nil {
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
		writeRefusal(w, f.status, f.code, state)
		return nil
	}
	if err = requireReportBarrier(ctx, tx, s.AccountID, req.Report); err != nil {
		return refuse(err)
	}
	if req.Raw == nil {
		return refuse(fail(422, "implausible-profile"))
	}
	raw, err := protojson.Marshal(req.Raw)
	if err != nil {
		return err
	}
	payload, _ := json.Marshal(map[string]any{"success": true, "data": json.RawMessage(raw)})
	p, err := habitica.Map(payload)
	if err != nil || !rules.Plausible(p) {
		return refuse(fail(422, "implausible-profile"))
	}
	subject, err := store.HabiticaSubject(ctx, tx, s.AccountID)
	if err != nil {
		return err
	}
	if p.ID != subject {
		return refuse(fail(409, "account-switch"))
	}
	if !rules.IsSafeArea(s.State.Area) {
		return refuse(fail(409, "not-at-safe-boundary"))
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
	// Magic's marks (crafts.md 4.2): the level mark follows every verified
	// sync (it unlocks moves and remembers a rebirth's magic), and the class
	// mark is the last class one saw. The class mark keeps the game's own
	// spellings (warrior, mage, rogue, healer — Habitica's "wizard" reads as
	// "mage" at intake and here). A rebirth comes back classless and keeps
	// its craft through the class mark; a classless sync never overwrites it.
	// `verified_high_level` is left over: sign-ins alone raise the history
	// the rebirth and forgery checks trust (review finding 7).
	if c := rules.ClassMarkOf(&p); c != "" {
		s.ClassMark = c
	}
	// An account whose mark never got written (0.4 accounts, and anyone who
	// never synced a class) remembers the craft from the profile this sync is
	// about to overwrite: a rebirth's classless sync must not take the hero's
	// magic away (review finding 2). A classless sync keeps the mark as is.
	if s.ClassMark == "" {
		s.ClassMark = rules.ClassMarkOf(s.ImportedProfile)
	}
	s.LevelMark = math.Max(s.LevelMark, p.Level)
	if _, err = tx.ExecContext(ctx, "UPDATE sync_baselines SET level_mark=MAX(level_mark,?),class_mark=CASE WHEN ?!='' THEN ? ELSE class_mark END WHERE account_id=?", p.Level, s.ClassMark, s.ClassMark, s.AccountID); err != nil {
		return err
	}
	r0 := rules.Sync(rules.Save{State: s.State, VitalsSource: s.VitalsSource, ImportedProfile: s.ImportedProfile}, p, true)
	s.State = r0.Save.State
	s.ImportedProfile = r0.Save.ImportedProfile
	s.VitalsSource = r0.Save.VitalsSource
	credit := s.State.Glims - before.Glims
	// The checkpoint allowance grows by full days, never by request count.
	days := max(int64(0), (now-s.CheckpointAt)/86400)
	cap := int(rules.E.GetSyncCreditCap()) + int(min(days, int64(int(rules.E.GetSyncCreditMax()))))*int(rules.E.GetSyncCreditDailyGrowth())
	cap = min(cap, int(rules.E.GetSyncCreditMax()))
	payable := max(0, int(math.Floor(s.VerifiedXP/float64(int(rules.E.GetXpPerGlim()))))+cap-int(math.Floor(before.GlimXP/float64(int(rules.E.GetXpPerGlim())))))
	paid := min(credit, payable)
	s.State.Glims = before.Glims
	s.State.XPGlims = before.XPGlims
	s.Pending += credit - paid
	if paid > 0 {
		if err = store.Credit(ctx, tx, &s, paid, paid, "sync", "xp", &reported, now); err != nil {
			return err
		}
	}
	if credit > paid {
		if _, err = tx.ExecContext(ctx, "INSERT INTO pending_credits VALUES(?,?,?,?)", s.AccountID, reported, credit-paid, now); err != nil {
			return err
		}
		if err = store.Credit(ctx, tx, &s, 0, 0, "pending-held", strconv.Itoa(credit-paid), &reported, now); err != nil {
			return err
		}
	}
	welcomed, err := store.Outcome(ctx, tx, s.AccountID, rules.WelcomeMark, "welcome", now)
	if err != nil {
		return err
	}
	if welcomed {
		if err = store.Credit(ctx, tx, &s, int(rules.E.GetWelcomeGlims()), 0, "welcome", "first-sync", nil, now); err != nil {
			return err
		}
		s.State.Flags = rules.AddUnique(s.State.Flags, rules.WelcomeMark)
	}

	s.VitalsWritten = true
	s.VitalsAt = float64(a.Config.Now().UnixNano()) / 1e9
	if err = a.Config.State.Persist(ctx, tx, &s, now); err != nil {
		return err
	}
	state, err := a.Config.State.PlayerState(ctx, tx, s)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	return writeOpResult(w, state, &contract.ProfileResult{Status: r0.Status, Credit: float64(paid), Pending: float64(s.Pending), VitalsCredit: &contract.VitalsCredit{Hp: s.State.HP - before.HP, Mana: s.State.Mana - before.Mana}})
}
