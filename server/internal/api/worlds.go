package api

import (
	"context"
	"database/sql"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
)

// Worlds and party worlds (docs/home-server.md "Party worlds and world
// moves"). A party's world belongs to the party, not a person: owner_id is
// empty and habitica_party_id names the party, one world per party. It is for
// that party only: no invite code leads into it. Only an account the operator
// let in (the CLI allowlist or an invite code) opens one; an account let in
// through a party only ever joins its own party's world. The party is read
// only at sign-in (players.habitica_party_id). A resident whose sign-in finds
// them outside the party is moved out after PartyGrace, or sooner if they
// choose. Otherwise a member may move into their party's world or back to a
// world they own, at most once a day (MoveCooldown).

// MoveCooldown: seconds between one world move and the next.
const MoveCooldown = 24 * 3600

// PartyGrace: seconds a resident of a party's world who has left the party
// keeps living there, counted from the sign-in that first saw it.
const PartyGrace = 3 * 24 * 3600

type worldRef struct {
	ID string `json:"id"`
	// OwnerID, OwnerName: empty for a party's world.
	OwnerID   string `json:"ownerId"`
	OwnerName string `json:"ownerName"`
	Members   int    `json:"members"`
	// OwnerHere: the owner lives in this world.
	OwnerHere bool `json:"ownerHere"`
	// Party: a party's world, owned by no one.
	Party bool `json:"party"`
	party sql.NullString
}

// leavingView is what a move would leave behind, for the confirmation screen.
type leavingView struct {
	// Gate of the caller's homestead (-1: none); Last: they are its only member.
	Gate int  `json:"gate"`
	Last bool `json:"last"`
	// Outgoing parcels still on the road block a move (recall them first);
	// incoming ones go back to their senders.
	Outgoing int `json:"outgoing"`
	Incoming int `json:"incoming"`
	// WardenTools: warden-set tools resting in the homestead's shared chest,
	// which stays behind (take them first).
	WardenTools int `json:"wardenTools"`
	// DeedCost: embers a deed costs in the next world (the first is free).
	DeedCost int `json:"deedCost"`
}

// leaverView: the caller lives in a party's world but has left that party.
type leaverView struct {
	// LeftAt: the sign-in that first saw it; MoveOutAt: when the next sign-in
	// moves them out; MoveOutIn: seconds until then, by the server's clock.
	LeftAt    int64 `json:"leftAt"`
	MoveOutAt int64 `json:"moveOutAt"`
	MoveOutIn int64 `json:"moveOutIn"`
	// HasOwn: they own a world to go to (otherwise one is made for them).
	HasOwn bool `json:"hasOwn"`
}

type worldView struct {
	World worldRef `json:"world"`
	// IsOwner: the caller owns this world.
	IsOwner bool `json:"isOwner"`
	// InParty: the caller's last sign-in reported a party.
	InParty bool `json:"inParty"`
	// PartyHome: this world is the caller's party's world.
	PartyHome bool `json:"partyHome"`
	// PartyWorld: the caller's party's world, when they live somewhere else.
	PartyWorld *worldRef `json:"partyWorld"`
	// PartyCanOpen: the caller's party has no world here and they may open it.
	PartyCanOpen bool `json:"partyCanOpen"`
	// OwnWorld: a world the caller owns, when they live somewhere else.
	OwnWorld *worldRef `json:"ownWorld"`
	// Prompt: PartyWorld is set and its join prompt hasn't been shown.
	Prompt  bool        `json:"prompt"`
	Leaving leavingView `json:"leaving"`
	// MoveOpensAt: when the next move is allowed (unix seconds); 0: now.
	// MoveOpensIn: seconds until then, by the server's clock (the device
	// counts down from it on its own clock).
	MoveOpensAt int64 `json:"moveOpensAt"`
	MoveOpensIn int64 `json:"moveOpensIn"`
	// Leaver: they live in a party's world and have left that party.
	Leaver *leaverView `json:"leaver"`
	// MovedOutAt: when the server moved them out of a party's world they had
	// left (0: it didn't), until POST /api/world/notice.
	MovedOutAt int64 `json:"movedOutAt"`
}

func loadWorldRef(ctx context.Context, tx *sql.Tx, id string) (worldRef, error) {
	var w worldRef
	err := tx.QueryRowContext(ctx, `SELECT w.id,w.owner_id,COALESCE(p.display_name,''),(SELECT count(*) FROM players m WHERE m.world_id=w.id),COALESCE(p.world_id=w.id,0),w.habitica_party_id
 FROM worlds w LEFT JOIN players p ON p.account_id=w.owner_id WHERE w.id=?`, id).Scan(&w.ID, &w.OwnerID, &w.OwnerName, &w.Members, &w.OwnerHere, &w.party)
	w.Party = w.OwnerID == "" && w.party.Valid
	return w, err
}

// partyWorld is the party's world ("" when it has none, or no party).
func partyWorld(ctx context.Context, tx *sql.Tx, party *string) (string, error) {
	if party == nil || *party == "" {
		return "", nil
	}
	var id string
	err := tx.QueryRowContext(ctx, "SELECT id FROM worlds WHERE habitica_party_id=? AND owner_id=''", *party).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return id, err
}

func partyClosed(ctx context.Context, tx *sql.Tx, party string) (bool, error) {
	var n int
	err := tx.QueryRowContext(ctx, "SELECT count(*) FROM party_closures WHERE party_id=?", party).Scan(&n)
	return n > 0, err
}

// partyAdmits is the party's world when its members may sign in through it
// ("" otherwise): party admission is on, the party isn't closed, and it has
// a world.
func (a *Server) partyAdmits(ctx context.Context, tx *sql.Tx, party *string) (string, error) {
	if a.Config.PartyAdmissionOff || party == nil || *party == "" {
		return "", nil
	}
	if closed, err := partyClosed(ctx, tx, *party); err != nil || closed {
		return "", err
	}
	return partyWorld(ctx, tx, party)
}

// mayOpenParty: the account may open its party's world. Only accounts the
// operator let in (allowlist added_by other than 'party') open one, so
// admission through a party never opens another; and not while party
// admission is off or the party is closed. "" when it may.
func (a *Server) mayOpenParty(ctx context.Context, tx *sql.Tx, id string, party *string) (string, error) {
	if party == nil || *party == "" {
		return "no-party", nil
	}
	if a.Config.PartyAdmissionOff {
		return "party-closed", nil
	}
	if closed, err := partyClosed(ctx, tx, *party); err != nil || closed {
		return "party-closed", err
	}
	var by string
	err := tx.QueryRowContext(ctx, "SELECT added_by FROM allowlist WHERE habitica_id=?", id).Scan(&by)
	if err == sql.ErrNoRows || by == "party" {
		return "party-open-denied", nil
	}
	return "", err
}

// ensurePartyWorld returns the party's world, making it first (opened by
// the given account) when the party has none. Two members signing in at
// once still make one: the unique index keeps the first.
func ensurePartyWorld(ctx context.Context, tx *sql.Tx, party *string, opener string, now int64) (string, error) {
	id, err := partyWorld(ctx, tx, party)
	if id != "" || err != nil || party == nil || *party == "" {
		return id, err
	}
	if id, err = store.Random(); err != nil {
		return "", err
	}
	seed, err := store.Random()
	if err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO worlds(id,owner_id,seed,habitica_party_id,created_at,opened_by) VALUES(?,'',?,?,?,?) ON CONFLICT(habitica_party_id) WHERE owner_id='' AND habitica_party_id IS NOT NULL DO NOTHING", id, seed, *party, now, opener); err != nil {
		return "", err
	}
	return partyWorld(ctx, tx, party)
}

// ownWorld is the oldest world the player owns, made when they have none.
func ownWorld(ctx context.Context, tx *sql.Tx, id string, now int64) (worldRef, error) {
	var own string
	err := tx.QueryRowContext(ctx, "SELECT id FROM worlds WHERE owner_id=? ORDER BY created_at,id LIMIT 1", id).Scan(&own)
	if err == sql.ErrNoRows {
		if own, err = store.Random(); err != nil {
			return worldRef{}, err
		}
		seed, err := store.Random()
		if err != nil {
			return worldRef{}, err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO worlds(id,owner_id,seed,created_at) VALUES(?,?,?,?)", own, id, seed, now); err != nil {
			return worldRef{}, err
		}
	} else if err != nil {
		return worldRef{}, err
	}
	return loadWorldRef(ctx, tx, own)
}

// leaverOf: the player lives in a party's world but their last sign-in
// reported another party, or none.
func leaverOf(w worldRef, party *string) bool {
	return w.Party && (party == nil || *party != w.party.String)
}

// moveOpensAt is when the player may next move (0: now).
func moveOpensAt(ctx context.Context, tx *sql.Tx, id string, now int64) (int64, error) {
	var last int64
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(created_at),0) FROM ledger WHERE account_id=? AND reason='world-move'", id).Scan(&last); err != nil {
		return 0, err
	}
	if last == 0 || now >= last+MoveCooldown {
		return 0, nil
	}
	return last + MoveCooldown, nil
}

func (a *Server) loadWorldView(ctx context.Context, tx *sql.Tx, s store.Snapshot, now int64) (worldView, error) {
	var v worldView
	var err error
	if v.World, err = loadWorldRef(ctx, tx, s.WorldID); err != nil {
		return v, err
	}
	party := s.HabiticaPartyID
	v.IsOwner = v.World.OwnerID == s.AccountID
	v.InParty = party != nil && *party != ""
	pw, err := partyWorld(ctx, tx, party)
	if err != nil {
		return v, err
	}
	v.PartyHome = pw != "" && pw == s.WorldID
	if pw != "" && pw != s.WorldID {
		ref, err := loadWorldRef(ctx, tx, pw)
		if err != nil {
			return v, err
		}
		v.PartyWorld = &ref
		var seen int
		if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM party_prompts WHERE account_id=? AND world_id=?", s.AccountID, pw).Scan(&seen); err != nil {
			return v, err
		}
		// Not while they live in a world an older link tied to their party:
		// that group moves over together, when the operator adopts it.
		oldLink := !v.World.Party && v.World.party.Valid && v.InParty && v.World.party.String == *party
		v.Prompt = seen == 0 && !oldLink
	}
	if pw == "" && v.InParty {
		subject, err := store.HabiticaSubject(ctx, tx, s.AccountID)
		if err != nil {
			return v, err
		}
		why, err := a.mayOpenParty(ctx, tx, subject, party)
		if err != nil {
			return v, err
		}
		v.PartyCanOpen = why == ""
	}
	var own string
	err = tx.QueryRowContext(ctx, "SELECT id FROM worlds WHERE owner_id=? AND id!=? ORDER BY created_at,id LIMIT 1", s.AccountID, s.WorldID).Scan(&own)
	if err != nil && err != sql.ErrNoRows {
		return v, err
	}
	if own != "" {
		ref, err := loadWorldRef(ctx, tx, own)
		if err != nil {
			return v, err
		}
		v.OwnWorld = &ref
	}
	if v.MoveOpensAt, err = moveOpensAt(ctx, tx, s.AccountID, now); err != nil {
		return v, err
	}
	if v.MoveOpensAt > 0 {
		v.MoveOpensIn = v.MoveOpensAt - now
	}
	var left, movedOut sql.NullInt64
	if err = tx.QueryRowContext(ctx, "SELECT party_left_at,party_moved_out_at FROM players WHERE account_id=?", s.AccountID).Scan(&left, &movedOut); err != nil {
		return v, err
	}
	if leaverOf(v.World, party) {
		l := &leaverView{LeftAt: now, HasOwn: v.OwnWorld != nil}
		if left.Valid {
			l.LeftAt = left.Int64
		}
		l.MoveOutAt = l.LeftAt + PartyGrace
		l.MoveOutIn = max(0, l.MoveOutAt-now)
		v.Leaver = l
	}
	v.MovedOutAt = movedOut.Int64
	v.Leaving, err = leaving(ctx, tx, s)
	return v, err
}

func leaving(ctx context.Context, tx *sql.Tx, s store.Snapshot) (leavingView, error) {
	l := leavingView{Gate: -1}
	var members int
	err := tx.QueryRowContext(ctx, "SELECT h.gate,(SELECT count(*) FROM homestead_members o WHERE o.homestead_id=h.id) FROM homestead_members m JOIN homesteads h ON h.id=m.homestead_id WHERE m.account_id=?", s.AccountID).Scan(&l.Gate, &members)
	if err != nil && err != sql.ErrNoRows {
		return l, err
	}
	l.Last = l.Gate >= 0 && members <= 1
	if l.Gate >= 0 {
		if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM item_instances t JOIN homestead_members m ON m.homestead_id=t.owner WHERE m.account_id=? AND t.location='storage'
 AND EXISTS(SELECT 1 FROM item_instances f WHERE f.location='fitted' AND f.owner=t.id AND f.item_def IN (`+wardenDefs()+`))`, s.AccountID).Scan(&l.WardenTools); err != nil {
			return l, err
		}
	}
	open := "world_id=? AND claimed_at IS NULL AND returned_at IS NULL AND kind!='thanks'"
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM mail WHERE from_id=? AND "+open, s.AccountID, s.WorldID).Scan(&l.Outgoing); err != nil {
		return l, err
	}
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM mail WHERE to_id=? AND "+open, s.AccountID, s.WorldID).Scan(&l.Incoming); err != nil {
		return l, err
	}
	var deeds int
	if err = tx.QueryRowContext(ctx, "SELECT COALESCE((SELECT deeds FROM player_deeds WHERE account_id=?),0)", s.AccountID).Scan(&deeds); err != nil {
		return l, err
	}
	if !content.HomeRules.GetDeeds().GetFirstFree() || deeds > 0 {
		l.DeedCost = int(content.HomeRules.GetDeeds().GetEmbers())
	}
	return l, nil
}

func (a *Server) worldRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	v, err := a.loadWorldView(r.Context(), tx, s, a.Config.Now().Unix())
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, worldViewProto(v))
}

// worldParty makes the party's world for the party the caller's last
// sign-in reported, when it has none yet (sign-in makes it too; this is for
// a session older than that, or a party reopened since). Only an account the
// operator let in may (mayOpenParty). It moves no one. Session only, no lease.
func (a *Server) worldParty(w http.ResponseWriter, r *http.Request) error {
	var req contract.WorldPartyRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now().Unix()
	subject, err := store.HabiticaSubject(ctx, tx, s.AccountID)
	if err != nil {
		return err
	}
	switch why, err := a.mayOpenParty(ctx, tx, subject, s.HabiticaPartyID); {
	case err != nil:
		return err
	case why == "party-open-denied":
		return fail(403, why)
	case why != "":
		return fail(409, why)
	}
	if _, err = ensurePartyWorld(ctx, tx, s.HabiticaPartyID, s.AccountID, now); err != nil {
		return err
	}
	v, err := a.loadWorldView(ctx, tx, s, now)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, worldViewProto(v))
}

// worldPrompt records that the party world's join prompt was shown.
func (a *Server) worldPrompt(w http.ResponseWriter, r *http.Request) error {
	var req contract.WorldPromptRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	if req.WorldId == "" || len(req.WorldId) > 128 {
		return fail(400, "invalid-request")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	var exists int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM worlds WHERE id=?", req.WorldId).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return fail(404, "world-not-found")
	}
	now := a.Config.Now().Unix()
	if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO party_prompts VALUES(?,?,?)", s.AccountID, req.WorldId, now); err != nil {
		return err
	}
	v, err := a.loadWorldView(ctx, tx, s, now)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, worldViewProto(v))
}

// relocate moves the player to target, the move's one shared step. With
// them go their character, story, embers, pack and personal chest (all keyed
// by player, not world). Their homestead membership ends exactly as a
// "leave" does; furniture, the shared chest, shelf stock, Wilds claims and
// project contributions stay with the old world. Parcels waiting for them
// go back to their senders. Their unused invite codes now admit friends to
// the new world, unless it is a party's (those take no codes). A warning
// about having left a party ends with the move. `at` is the operation's
// sub-second clock: 5.3's fishing times are fractional.
func relocate(ctx context.Context, tx *sql.Tx, s *store.Snapshot, target worldRef, now int64, at float64) (bool, int, error) {
	from := s.WorldID
	// A world move pulls the line in (design 5.4): a hold already past its
	// hold_until is recorded lapsed first, the rest close as cancelled, and
	// every fish goes back to the water it was reserved from.
	if err := lapseCasts(ctx, tx, at, now, "account_id=?", s.AccountID); err != nil {
		return false, 0, err
	}
	if err := closeOpenCasts(ctx, tx, s.AccountID, at, now); err != nil {
		return false, 0, err
	}
	if err := settleHomes(ctx, tx, from, now); err != nil {
		return false, 0, err
	}
	homeID, member, err := memberOf(ctx, tx, s.AccountID)
	if err != nil {
		return false, 0, err
	}
	if member {
		h, err := loadHome(ctx, tx, homeID, s.AccountID, now)
		if err != nil {
			return false, 0, err
		}
		if err = leave(ctx, tx, s, h, now); err != nil {
			return false, 0, err
		}
	}
	// Deed invitations to them belong to the old world's lane.
	if _, err = tx.ExecContext(ctx, "DELETE FROM homestead_invites WHERE to_id=?", s.AccountID); err != nil {
		return false, 0, err
	}
	rows, err := tx.QueryContext(ctx, "SELECT id FROM mail WHERE to_id=? AND world_id=? AND claimed_at IS NULL AND returned_at IS NULL AND kind!='thanks' ORDER BY sent_at,id", s.AccountID, from)
	if err != nil {
		return false, 0, err
	}
	incoming := []string{}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return false, 0, err
		}
		incoming = append(incoming, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return false, 0, err
	}
	for _, id := range incoming {
		if _, err = store.ReturnMail(ctx, tx, id, "recipient-removed", now, true); err != nil {
			return false, 0, err
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE players SET world_id=?,party_left_at=NULL WHERE account_id=?", target.ID, s.AccountID); err != nil {
		return false, 0, err
	}
	// A world move sends the mount that is out home (docs/design/crafts.md
	// 3.3): each world's stable holds its own mounts.
	if err = store.SendMountHome(ctx, tx, s.AccountID); err != nil {
		return false, 0, err
	}
	// Codes they handed out follow them: a friend joins them, not the world
	// they left. A party's world takes no codes: theirs keep naming the old one.
	if !target.Party {
		if _, err = tx.ExecContext(ctx, "UPDATE invites SET world_id=? WHERE created_by=? AND world_id=? AND used_by IS NULL AND revoked_at IS NULL AND expires_at>?", target.ID, s.AccountID, from, now); err != nil {
			return false, 0, err
		}
	}
	s.WorldID = target.ID
	if err = store.Credit(ctx, tx, s, 0, 0, "world-move", from+">"+target.ID, nil, now); err != nil {
		return false, 0, err
	}
	return member, len(incoming), nil
}

// moveResult is a move's answer under the Envelope's result (world.proto:
// contract.WorldMoveResult, built by moveResultProto).

func moveResultProto(world worldView, from string, leftHome bool, returned int) *contract.WorldMoveResult {
	return &contract.WorldMoveResult{World: worldViewProto(world), From: from, LeftHome: leftHome, Returned: int32(returned)}
}

// worldMove moves the caller to their party's world or to one they own, in
// one keyed transaction (relocate), from the village or the Commons, at most
// once a day, and only once parcels they sent are home (a move never takes
// back a gift on its own).
func (a *Server) worldMove(w http.ResponseWriter, r *http.Request) error {
	var req contract.WorldMoveRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	if req.WorldId == "" || len(req.WorldId) > 128 {
		return fail(400, "invalid-request")
	}
	mover := ""
	return a.keyedOp(w, r, req.Op, req.Where, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if !rules.SafeAreas[content.RootArea(s.State.Area)] {
			return nil, fail(409, "not-at-safe-boundary")
		}
		from := s.WorldID
		if req.WorldId == from {
			return nil, fail(409, "already-in-world")
		}
		target, err := loadWorldRef(ctx, tx, req.WorldId)
		if err == sql.ErrNoRows {
			return nil, fail(404, "world-not-found")
		}
		if err != nil {
			return nil, err
		}
		// Your party's world, or a world you own (always yours to go back to).
		pw, err := partyWorld(ctx, tx, s.HabiticaPartyID)
		if err != nil {
			return nil, err
		}
		if target.ID != pw && target.OwnerID != s.AccountID {
			return nil, fail(403, "world-access-denied")
		}
		if opens, err := moveOpensAt(ctx, tx, s.AccountID, now); err != nil {
			return nil, err
		} else if opens > 0 {
			return nil, fail(409, "move-cooldown")
		}
		before, err := leaving(ctx, tx, *s)
		if err != nil {
			return nil, err
		}
		if before.Outgoing > 0 {
			return nil, fail(409, "mail-in-flight")
		}
		left, returned, err := relocate(ctx, tx, s, target, now, fractionalNow(a))
		if err != nil {
			return nil, err
		}
		mover = s.AccountID
		v, err := a.loadWorldView(ctx, tx, *s, now)
		if err != nil {
			return nil, err
		}
		return moveResultProto(v, from, left, returned), nil
	}, func() {
		// Presence follows: the live socket moves to the new world's rooms.
		if mover != "" {
			a.presenceChanged(mover)
		}
	})
}

// worldLeave ("Leave now") moves someone who has left the party whose world
// they live in to a world of their own (made when they have none) straight
// away, without waiting out the grace period or the move cooldown. The
// other move rules hold: from the village or the Commons, parcels home first.
func (a *Server) worldLeave(w http.ResponseWriter, r *http.Request) error {
	var req contract.WorldLeaveRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	mover := ""
	return a.keyedOp(w, r, req.Op, req.Where, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		here, err := loadWorldRef(ctx, tx, s.WorldID)
		if err != nil {
			return nil, err
		}
		if !leaverOf(here, s.HabiticaPartyID) {
			return nil, fail(409, "still-in-party")
		}
		if !rules.SafeAreas[content.RootArea(s.State.Area)] {
			return nil, fail(409, "not-at-safe-boundary")
		}
		before, err := leaving(ctx, tx, *s)
		if err != nil {
			return nil, err
		}
		if before.Outgoing > 0 {
			return nil, fail(409, "mail-in-flight")
		}
		target, err := ownWorld(ctx, tx, s.AccountID, now)
		if err != nil {
			return nil, err
		}
		from := s.WorldID
		left, returned, err := relocate(ctx, tx, s, target, now, fractionalNow(a))
		if err != nil {
			return nil, err
		}
		mover = s.AccountID
		v, err := a.loadWorldView(ctx, tx, *s, now)
		if err != nil {
			return nil, err
		}
		out := moveResultProto(v, from, left, returned)
		return &contract.WorldLeaveResult{World: out.World, From: out.From, LeftHome: out.LeftHome, Returned: out.Returned}, nil
	}, func() {
		if mover != "" {
			a.presenceChanged(mover)
		}
	})
}

// partyResidence runs at sign-in, with the party just verified: a resident
// of a party's world who is back in that party is no longer warned; one who
// isn't is warned from now (party_left_at), and once PartyGrace has passed
// is moved out to a world of their own (relocate), wherever they stood: off
// the safe paths they arrive in the village, and parcels they sent stay on
// the road (their recipients can still take them). Reports a move.
func partyResidence(ctx context.Context, tx *sql.Tx, s *store.Snapshot, party *string, now int64, at float64) (bool, error) {
	here, err := loadWorldRef(ctx, tx, s.WorldID)
	if err != nil || !here.Party {
		return false, err
	}
	if !leaverOf(here, party) {
		_, err = tx.ExecContext(ctx, "UPDATE players SET party_left_at=NULL WHERE account_id=?", s.AccountID)
		return false, err
	}
	var left sql.NullInt64
	if err = tx.QueryRowContext(ctx, "SELECT party_left_at FROM players WHERE account_id=?", s.AccountID).Scan(&left); err != nil {
		return false, err
	}
	if !left.Valid {
		_, err = tx.ExecContext(ctx, "UPDATE players SET party_left_at=? WHERE account_id=?", now, s.AccountID)
		return false, err
	}
	if now < left.Int64+PartyGrace {
		return false, nil
	}
	target, err := ownWorld(ctx, tx, s.AccountID, now)
	if err != nil {
		return false, err
	}
	if !rules.SafeAreas[content.RootArea(s.State.Area)] {
		start := rules.NewState()
		s.State.Area, s.State.Position = start.Area, start.Position
	}
	if _, _, err = relocate(ctx, tx, s, target, now, at); err != nil {
		return false, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE players SET party_moved_out_at=? WHERE account_id=?", now, s.AccountID); err != nil {
		return false, err
	}
	if err = settleSlots(ctx, tx, s); err != nil {
		return false, err
	}
	return true, store.Persist(ctx, tx, s, now)
}

// worldNotice records that the "you were moved out" notice was shown.
func (a *Server) worldNotice(w http.ResponseWriter, r *http.Request) error {
	var req contract.WorldNoticeRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	if _, err = tx.ExecContext(ctx, "UPDATE players SET party_moved_out_at=NULL WHERE account_id=?", s.AccountID); err != nil {
		return err
	}
	v, err := a.loadWorldView(ctx, tx, s, a.Config.Now().Unix())
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, worldViewProto(v))
}
