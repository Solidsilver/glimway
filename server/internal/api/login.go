package api

import (
	"database/sql"
	"errors"
	"glimway/server/internal/habitica"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"math"
	"net/http"
	"strconv"
	"time"
)

func (a *Server) login(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		UserID string `json:"userId"`
		Token  string `json:"token"`
		Invite string `json:"invite"`
		// Party: the party the client expects Habitica to report (from the
		// profile it read itself). Only lets a party-only sign-in past the
		// precheck; the verified party must match it.
		Party string `json:"party"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	if req.UserID == "" || len(req.UserID) > 128 || req.Token == "" || len(req.Token) > 512 || len(req.Invite) > 512 || len(req.Party) > 128 {
		return fail(400, "invalid-credentials")
	}
	req.Invite = store.NormalizeInvite(req.Invite)
	if len(req.Invite) > 128 {
		return fail(400, "invalid-credentials")
	}
	route, err := a.precheck(r.Context(), req.UserID, req.Invite, req.Party)
	if err != nil {
		return err
	}
	if route == "" {
		return fail(403, "access-denied")
	}
	// Sign-ins only a party could admit spend their own, smaller share of
	// the Habitica budget, never the one allowlisted and invited players use.
	budget := a.loginGlobal
	if route == "party" {
		budget = a.loginParty
	}
	if !a.loginLimit.allow(a.clientIP(r), a.Config.Now()) {
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(a.Config.LoginWindow.Seconds()))))
		return fail(429, "login-rate-limited")
	}
	finishProof, retry, ok := a.loginProofs.begin(req.UserID, a.Config.Now())
	if !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retry.Seconds()))))
		return fail(429, "login-user-rate-limited")
	}
	failedProof := false
	defer func() { finishProof(failedProof) }()
	select {
	case a.loginSlots <- struct{}{}:
		defer func() { <-a.loginSlots }()
	default:
		w.Header().Set("Retry-After", "1")
		return fail(429, "login-busy")
	}
	p, err := a.Habitica.VerifyLimited(r.Context(), req.UserID, req.Token, func() bool { return budget.allow("global", a.Config.Now()) })
	req.Token = ""
	if err != nil {
		var h *habitica.Error
		if errors.As(err, &h) {
			failedProof = h.Code == "habitica-auth"
			if h.Status == 429 {
				w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(h.RetryAfter.Seconds()))))
			}
			return fail(h.Status, h.Code)
		}
		return fail(502, "habitica-unavailable")
	}
	ctx := r.Context()
	tx, err := a.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := a.Config.Now().Unix()
	var allowed int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM allowlist WHERE habitica_id=?", p.ID).Scan(&allowed); err != nil {
		return err
	}
	var existing int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM players WHERE habitica_id=?", p.ID).Scan(&existing); err != nil {
		return err
	}
	// A party with an open world here counts as an invite: a verified member
	// may sign in with no code and no allowlist entry (and is allowlisted from
	// then on, added_by 'party'), unless the CLI removed them. The party comes
	// only from the identity check above, and must be the one the client said.
	admits, err := a.partyAdmits(ctx, tx, p.PartyID)
	if err != nil {
		return err
	}
	// A named invite decides a new player's world. An unnamed invite admits
	// them to the world-choice flow below, or a solo world if no choice is
	// offered. An allowlisted newcomer's valid code still counts. A code
	// naming a party's world admits no one.
	world := ""
	via := "invite"
	if allowed == 0 || existing == 0 && req.Invite != "" {
		var named sql.NullString
		err = tx.QueryRowContext(ctx, "SELECT world_id FROM invites WHERE (created_by='cli' OR NOT EXISTS(SELECT 1 FROM access_removals WHERE habitica_id=?)) AND code_hash=? AND "+inviteUsable, p.ID, store.Hash(req.Invite), now).Scan(&named)
		if err == sql.ErrNoRows && allowed == 0 {
			var removed int
			if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM access_removals WHERE habitica_id=?", p.ID).Scan(&removed); err != nil {
				return err
			}
			if admits == "" || removed > 0 || req.Party != *p.PartyID {
				return fail(403, "access-denied")
			}
			via = "party"
		} else if err != nil && err != sql.ErrNoRows {
			return err
		} else if err == nil {
			if named.Valid {
				world = named.String
			}
			res, err := tx.ExecContext(ctx, "UPDATE invites SET used_by=?,used_at=? WHERE code_hash=? AND "+inviteUsable, p.ID, now, store.Hash(req.Invite), now)
			if err != nil {
				return err
			}
			n, err := res.RowsAffected()
			if err != nil {
				return err
			}
			if n != 1 {
				return fail(403, "access-denied")
			}
		}
		if allowed == 0 {
			if _, err = tx.ExecContext(ctx, "INSERT INTO allowlist VALUES(?,?,?)", p.ID, via, now); err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, "DELETE FROM access_removals WHERE habitica_id=?", p.ID); err != nil {
				return err
			}
		}
	}
	// A newcomer whose party has a world here, or who may open one, is asked
	// where to live (POST /api/world/choose), unless a code named a world.
	// The sign-in is held until then: the session, but no player yet.
	var offer *worldChoiceView
	if existing == 0 && world == "" {
		v, err := a.loadWorldChoice(ctx, tx, p.ID, p.Name, p.PartyID)
		if err != nil {
			return err
		}
		if v.PartyWorld != nil || v.PartyCanOpen {
			offer = &v
		}
	}
	// The first operator-admitted member of a party to sign in makes the
	// party's world; one let in through a party never makes another. A
	// newcomer still choosing makes it only by choosing it.
	if offer == nil {
		why, err := a.mayOpenParty(ctx, tx, p.ID, p.PartyID)
		if err != nil {
			return err
		}
		if why == "" {
			if _, err = ensurePartyWorld(ctx, tx, p.PartyID, p.ID, now); err != nil {
				return err
			}
		}
	}
	verified := rules.LifetimeXP(p.Level, *p.Exp)
	movedOut := false
	if existing == 0 && offer == nil {
		if world == "" {
			own, err := ownWorld(ctx, tx, p.ID, now)
			if err != nil {
				return err
			}
			world = own.ID
		}
		if err = createPlayer(ctx, tx, p, world, now, now); err != nil {
			return err
		}
	} else if existing != 0 {
		s, err := store.Load(ctx, tx, p.ID)
		if err != nil {
			return err
		}
		if err = checkpoint(ctx, tx, &s, p, now); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE players SET display_name=?,last_seen_at=?,habitica_party_id=? WHERE habitica_id=?", p.Name, now, p.PartyID, p.ID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE sync_baselines SET verified_xp=?,checkpoint_json=?,checkpoint_at=?,verified_high_level=MAX(verified_high_level,?),checkpoint_ledger_id=COALESCE((SELECT MAX(id) FROM ledger WHERE habitica_id=?),0) WHERE habitica_id=?", verified, store.JSON(p), now, p.Level, p.ID, p.ID); err != nil {
			return err
		}
		// Left the party whose world they live in: warned now, moved out
		// once the grace period has passed.
		if movedOut, err = partyResidence(ctx, tx, &s, p.PartyID, now); err != nil {
			return err
		}
	}
	session, err := store.Random()
	if err != nil {
		return err
	}
	expires := time.Unix(now, 0).Add(SessionIdleTTL)
	for _, table := range []string{"sessions", "pending_sessions"} {
		if _, err = tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE expires_at<=? OR created_at<=?", now, now-int64(SessionTTL.Seconds())); err != nil {
			return err
		}
	}
	if offer != nil {
		if _, err = tx.ExecContext(ctx, "INSERT INTO pending_sessions VALUES(?,?,?,?,?,?,?,?)", store.Hash(session), p.ID, p.Name, p.PartyID, now, expires.Unix(), store.JSON(p), verified); err != nil {
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
		a.cookie(w, session, expires)
		write(w, 200, worldChoiceAnswer{*offer})
		return nil
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO sessions VALUES(?,?,?,?,?,?)", store.Hash(session), p.ID, now, expires.Unix(), store.JSON(p), verified); err != nil {
		return err
	}
	s, err := store.Load(ctx, tx, p.ID)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if movedOut {
		a.presenceChanged(p.ID)
	}
	a.cookie(w, session, expires)
	write(w, 200, s)
	return nil
}
