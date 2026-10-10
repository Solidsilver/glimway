package api

import (
	"context"
	"database/sql"
	"encoding/json"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
	"time"
)

// The first sign-in's world choice (docs/home-server.md "Party worlds and
// world moves"). A newcomer whose verified party has a world here, or who
// may open one, is asked: join the party's world, or start one of their own.
// The token is used once at sign-in and never kept, so the sign-in itself is
// not repeated: login holds the session in pending_sessions (with the
// verified profile and party, no player row) and only the world waits. Until
// POST /api/world/choose every other call answers world-choice-required; a
// closed tab finds the same question on its next visit. A code that names a
// world still decides on its own (login never asks then).

// worldChoiceView is the question, as login and GET /api/world/choice ask it.
type worldChoiceView struct {
	HabiticaID  string `json:"habiticaId"`
	DisplayName string `json:"displayName"`
	// PartyWorld: the party's world here (Members: how many live there).
	PartyWorld *worldRef `json:"partyWorld"`
	// PartyCanOpen: the party has no world here yet and choosing it opens one.
	PartyCanOpen bool `json:"partyCanOpen"`
	// PartyAdmitted: let in through the party, so they make no invite codes
	// (createInvite), even from a world of their own.
	PartyAdmitted bool `json:"partyAdmitted"`
}

// worldChoiceAnswer wraps it, so a client tells it apart from a snapshot.
type worldChoiceAnswer struct {
	WorldChoice worldChoiceView `json:"worldChoice"`
}

type pendingRow struct {
	HabiticaID, Name, Profile string
	Party                     sql.NullString
	CreatedAt                 int64
	XP                        float64
}

// pendingSession: a live held sign-in (sql.ErrNoRows when there is none).
// Allowlist removal revokes it the way it revokes a session.
func pendingSession(ctx context.Context, tx *sql.Tx, hash string, now int64) (pendingRow, error) {
	var p pendingRow
	err := tx.QueryRowContext(ctx, "SELECT s.habitica_id,s.display_name,s.habitica_party_id,s.created_at,s.checkpoint_json,s.checkpoint_xp FROM pending_sessions s JOIN allowlist l USING(habitica_id) WHERE s.id_hash=? AND s.expires_at>? AND s.created_at>?", hash, now, now-int64(SessionTTL.Seconds())).Scan(&p.HabiticaID, &p.Name, &p.Party, &p.CreatedAt, &p.Profile, &p.XP)
	return p, err
}

// partyAdmitted: the account came in through a party (allowlist added_by
// 'party'), not by the operator's hand or a code.
func partyAdmitted(ctx context.Context, tx *sql.Tx, id string) (bool, error) {
	var n int
	err := tx.QueryRowContext(ctx, "SELECT count(*) FROM allowlist WHERE habitica_id=? AND added_by='party'", id).Scan(&n)
	return n > 0, err
}

// partyShut: no one comes in through the party now (party admission is off,
// or the operator closed it).
func (a *Server) partyShut(ctx context.Context, tx *sql.Tx, party string) (bool, error) {
	if a.Config.PartyAdmissionOff {
		return true, nil
	}
	return partyClosed(ctx, tx, party)
}

// partyWorldFor is the party's world as the newcomer may choose it: none
// for an account let in through the party once that party is shut (the
// operator's brake holds for sign-ins it already let in, too).
func (a *Server) partyWorldFor(ctx context.Context, tx *sql.Tx, id string, party *string, admitted bool) (string, error) {
	pw, err := partyWorld(ctx, tx, party)
	if pw == "" || err != nil || !admitted {
		return pw, err
	}
	if shut, err := a.partyShut(ctx, tx, *party); err != nil || shut {
		return "", err
	}
	return pw, nil
}

func (a *Server) loadWorldChoice(ctx context.Context, tx *sql.Tx, id, name string, party *string) (worldChoiceView, error) {
	v := worldChoiceView{HabiticaID: id, DisplayName: name}
	admitted, err := partyAdmitted(ctx, tx, id)
	if err != nil {
		return v, err
	}
	v.PartyAdmitted = admitted
	pw, err := a.partyWorldFor(ctx, tx, id, party, admitted)
	if err != nil {
		return v, err
	}
	if pw != "" {
		ref, err := loadWorldRef(ctx, tx, pw)
		if err != nil {
			return v, err
		}
		v.PartyWorld = &ref
		return v, nil
	}
	why, err := a.mayOpenParty(ctx, tx, id, party)
	v.PartyCanOpen = why == ""
	return v, err
}

// createPlayer makes a newcomer's rows in the world given, from the profile
// verified at sign-in (verifiedAt), and turns any held sign-ins of theirs
// into sessions.
func createPlayer(ctx context.Context, tx *sql.Tx, id string, p rules.Profile, world string, verifiedAt, now int64) error {
	verified := rules.LifetimeXP(p.Level, *p.Exp)
	if _, err := tx.ExecContext(ctx, "INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,habitica_party_id,profile_source) VALUES(?,?,?,?,?,?,'habitica')", id, p.Name, world, now, now, p.PartyID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO sign_ins(account_id,method,subject,created_at) VALUES(?,'habitica',?,?)", id, p.ID, now); err != nil {
		return err
	}
	state := rules.NewState()
	state.HP = min(p.HP, p.MaxHP)
	state.Mana = min(p.MP, p.MaxMP)

	if _, err := tx.ExecContext(ctx, "INSERT INTO balances VALUES(?,0,0)", id); err != nil {
		return err
	}
	// Account creation writes the class mark too (crafts.md 4.2, review
	// finding 2): the craft is remembered from the first sign-in on.
	if _, err := tx.ExecContext(ctx, "INSERT INTO sync_baselines(account_id,profile_json,xp_mark,verified_xp,checkpoint_json,checkpoint_at,updated_at,loss_level,loss_xp,loss_at,verified_high_level,level_mark,class_mark) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)", id, store.JSON(p), verified, verified, store.JSON(p), verifiedAt, now, p.Level, verified, verifiedAt, p.Level, p.Level, rules.ClassMarkOf(&p)); err != nil {
		return err
	}
	// B replaces the document row above after 028; these initial rows are already
	// suitable for reports and the new state loader.
	if _, err := tx.ExecContext(ctx, "INSERT INTO player_vitals(account_id,hp,mana,vitals_at,vitals_set_version) VALUES(?,?,?,?,0)", id, state.HP, state.Mana, now); err != nil {
		return err
	}
	for _, item := range state.Inventory {
		if _, err := tx.ExecContext(ctx, "INSERT INTO story_marks VALUES(?,?,'quest-item',?)", id, item, now); err != nil {
			return err
		}
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO player_place(account_id,area,x,y) VALUES(?,?,?,?)", id, state.Area, state.Position.X, state.Position.Y); err != nil {
		return err
	}
	expires := now + int64(SessionIdleTTL.Seconds())
	if _, err := tx.ExecContext(ctx, "INSERT INTO sessions SELECT id_hash,?,created_at,MIN(?,created_at+?),checkpoint_json,checkpoint_xp FROM pending_sessions WHERE habitica_id=? AND expires_at>? AND created_at>?", id, expires, int64(SessionTTL.Seconds()), p.ID, now, now-int64(SessionTTL.Seconds())); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "DELETE FROM pending_sessions WHERE habitica_id=?", p.ID)
	return err
}

// heldSignIn reads the request's held sign-in. A session that already has a
// world answers world-chosen; anything else is unauthorized.
func (a *Server) heldSignIn(ctx context.Context, tx *sql.Tx, r *http.Request, now int64) (pendingRow, string, error) {
	c, err := r.Cookie(CookieName)
	if err != nil || len(c.Value) != 64 {
		return pendingRow{}, "", fail(401, "unauthorized")
	}
	hash := store.Hash(c.Value)
	p, err := pendingSession(ctx, tx, hash, now)
	if err == sql.ErrNoRows {
		if _, _, err = a.auth(ctx, tx, r); err != nil {
			return p, "", err
		}
		return p, "", fail(409, "world-chosen")
	}
	return p, hash, err
}

// worldChoiceRead (GET /api/world/choice) asks again: a reload, or a tab
// closed mid-choice. Reading slides the held sign-in like any session. When
// there is nothing left to ask, it settles them in a world of their own and
// answers world-chosen (read the state next).
func (a *Server) worldChoiceRead(w http.ResponseWriter, r *http.Request) error {
	ctx := r.Context()
	tx, err := a.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := a.Config.Now().Unix()
	p, hash, err := a.heldSignIn(ctx, tx, r, now)
	if err != nil {
		return err
	}
	var party *string
	if p.Party.Valid {
		party = &p.Party.String
	}
	v, err := a.loadWorldChoice(ctx, tx, p.HabiticaID, p.Name, party)
	if err != nil {
		return err
	}
	if v.PartyWorld == nil && !v.PartyCanOpen {
		// Nothing left to ask (the party shut, or its world can't be opened
		// any more): a world of their own, as sign-in would have made, and
		// the answer every chosen sign-in gets.
		if _, err = a.settleChoice(ctx, tx, p, "own", now); err != nil {
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
		return fail(409, "world-chosen")
	}
	var expires int64
	if err = tx.QueryRowContext(ctx, "UPDATE pending_sessions SET expires_at=MIN(?,created_at+?) WHERE id_hash=? RETURNING expires_at", now+int64(SessionIdleTTL.Seconds()), int64(SessionTTL.Seconds()), hash).Scan(&expires); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	c, _ := r.Cookie(CookieName)
	a.cookie(w, c.Value, time.Unix(expires, 0))
	writeProto(w, 200, &contract.SessionResponse{Answer: &contract.SessionResponse_WorldChoice{WorldChoice: worldChoiceProto(v)}})
	return nil
}

// worldChoose (POST /api/world/choose {"choice":"party"|"own"}) makes the
// player in the world chosen, once (settleChoice).
func (a *Server) worldChoose(w http.ResponseWriter, r *http.Request) error {
	var req contract.WorldChooseRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	if req.Choice != "party" && req.Choice != "own" {
		return fail(400, "invalid-choice")
	}
	ctx := r.Context()
	tx, err := a.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := a.Config.Now().Unix()
	held, _, err := a.heldSignIn(ctx, tx, r, now)
	if err != nil {
		return err
	}
	s, err := a.settleChoice(ctx, tx, held, req.Choice, now)
	if err != nil {
		return err
	}
	state, err := a.Config.State.PlayerState(ctx, tx, s)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, &contract.SessionResponse{Answer: &contract.SessionResponse_State{State: state}})
}

// settleChoice makes the held newcomer's player: "party" joins the party's
// world (opening it, when it has none and they may; an account let in
// through the party is refused once the party is shut), "own" makes a world
// theirs alone. The choice isn't a move: the first move after it is open at
// once, and the cooldown counts from that. Choosing their own world records
// the party's offer as shown (the Menu keeps it).
func (a *Server) settleChoice(ctx context.Context, tx *sql.Tx, held pendingRow, choice string, now int64) (store.Snapshot, error) {
	var p rules.Profile
	if err := json.Unmarshal([]byte(held.Profile), &p); err != nil || p.Exp == nil || p.ID != held.HabiticaID {
		return store.Snapshot{}, fail(500, "internal")
	}
	if held.Party.Valid {
		p.PartyID = &held.Party.String
	}
	id, err := store.Random()
	if err != nil {
		return store.Snapshot{}, err
	}
	var world string
	if choice == "party" {
		admitted, err := partyAdmitted(ctx, tx, p.ID)
		if err != nil {
			return store.Snapshot{}, err
		}
		if world, err = a.partyWorldFor(ctx, tx, p.ID, p.PartyID, admitted); err != nil {
			return store.Snapshot{}, err
		}
		if world == "" {
			if pw, err := partyWorld(ctx, tx, p.PartyID); err != nil {
				return store.Snapshot{}, err
			} else if pw != "" {
				return store.Snapshot{}, fail(409, "party-closed")
			}
			switch why, err := a.mayOpenParty(ctx, tx, p.ID, p.PartyID); {
			case err != nil:
				return store.Snapshot{}, err
			case why != "":
				return store.Snapshot{}, fail(409, why)
			}
			if world, err = ensurePartyWorld(ctx, tx, p.PartyID, id, now); err != nil {
				return store.Snapshot{}, err
			}
		}
	} else {
		own, err := ownWorld(ctx, tx, id, now)
		if err != nil {
			return store.Snapshot{}, err
		}
		world = own.ID
	}
	if err := createPlayer(ctx, tx, id, p, world, held.CreatedAt, now); err != nil {
		return store.Snapshot{}, err
	}
	if choice == "own" {
		if pw, err := partyWorld(ctx, tx, p.PartyID); err != nil {
			return store.Snapshot{}, err
		} else if pw != "" {
			if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO party_prompts VALUES(?,?,?)", id, pw, now); err != nil {
				return store.Snapshot{}, err
			}
		}
	}
	return store.Load(ctx, tx, id)
}
