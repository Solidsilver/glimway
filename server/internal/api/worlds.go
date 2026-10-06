package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
	"net/http"
)

// Worlds and party worlds (docs/home-server.md "Party worlds and world
// moves"). A party's world belongs to the party, not a person: owner_id is
// empty and habitica_party_id names the party, one world per party. The
// party is read only at sign-in (players.habitica_party_id); leaving a party
// never moves or removes anyone. A member may move into their party's world
// or back to a world they own, at most once a day (MoveCooldown).

// MoveCooldown: seconds between one world move and the next.
const MoveCooldown = 24 * 3600

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
	// OwnWorld: a world the caller owns, when they live somewhere else.
	OwnWorld *worldRef `json:"ownWorld"`
	// Prompt: PartyWorld is set and its join prompt hasn't been shown.
	Prompt  bool        `json:"prompt"`
	Leaving leavingView `json:"leaving"`
	// MoveOpensAt: when the next move is allowed (unix seconds); 0: now.
	MoveOpensAt int64 `json:"moveOpensAt"`
}

func loadWorldRef(ctx context.Context, tx *sql.Tx, id string) (worldRef, error) {
	var w worldRef
	err := tx.QueryRowContext(ctx, `SELECT w.id,w.owner_id,COALESCE(p.display_name,''),(SELECT count(*) FROM players m WHERE m.world_id=w.id),COALESCE(p.world_id=w.id,0),w.habitica_party_id
 FROM worlds w LEFT JOIN players p ON p.habitica_id=w.owner_id WHERE w.id=?`, id).Scan(&w.ID, &w.OwnerID, &w.OwnerName, &w.Members, &w.OwnerHere, &w.party)
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

// ensurePartyWorld returns the party's world, making it first when the
// party has none (two members signing in at once still make one: the
// unique index on habitica_party_id keeps the first).
func ensurePartyWorld(ctx context.Context, tx *sql.Tx, party *string, now int64) (string, error) {
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
	if _, err = tx.ExecContext(ctx, "INSERT INTO worlds(id,owner_id,seed,habitica_party_id,created_at) VALUES(?,'',?,?,?) ON CONFLICT(habitica_party_id) WHERE owner_id='' AND habitica_party_id IS NOT NULL DO NOTHING", id, seed, *party, now); err != nil {
		return "", err
	}
	return partyWorld(ctx, tx, party)
}

// moveOpensAt is when the player may next move (0: now).
func moveOpensAt(ctx context.Context, tx *sql.Tx, id string, now int64) (int64, error) {
	var last int64
	if err := tx.QueryRowContext(ctx, "SELECT COALESCE(MAX(created_at),0) FROM ledger WHERE habitica_id=? AND reason='world-move'", id).Scan(&last); err != nil {
		return 0, err
	}
	if last == 0 || now >= last+MoveCooldown {
		return 0, nil
	}
	return last + MoveCooldown, nil
}

func loadWorldView(ctx context.Context, tx *sql.Tx, s store.Snapshot, now int64) (worldView, error) {
	var v worldView
	var err error
	if v.World, err = loadWorldRef(ctx, tx, s.WorldID); err != nil {
		return v, err
	}
	party := s.HabiticaPartyID
	v.IsOwner = v.World.OwnerID == s.HabiticaID
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
		if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM party_prompts WHERE habitica_id=? AND world_id=?", s.HabiticaID, pw).Scan(&seen); err != nil {
			return v, err
		}
		v.Prompt = seen == 0
	}
	var own string
	err = tx.QueryRowContext(ctx, "SELECT id FROM worlds WHERE owner_id=? AND id!=? ORDER BY created_at,id LIMIT 1", s.HabiticaID, s.WorldID).Scan(&own)
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
	if v.MoveOpensAt, err = moveOpensAt(ctx, tx, s.HabiticaID, now); err != nil {
		return v, err
	}
	v.Leaving, err = leaving(ctx, tx, s)
	return v, err
}

func leaving(ctx context.Context, tx *sql.Tx, s store.Snapshot) (leavingView, error) {
	l := leavingView{Gate: -1}
	var members int
	err := tx.QueryRowContext(ctx, "SELECT h.gate,(SELECT count(*) FROM homestead_members o WHERE o.homestead_id=h.id) FROM homestead_members m JOIN homesteads h ON h.id=m.homestead_id WHERE m.habitica_id=?", s.HabiticaID).Scan(&l.Gate, &members)
	if err != nil && err != sql.ErrNoRows {
		return l, err
	}
	l.Last = l.Gate >= 0 && members <= 1
	if l.Gate >= 0 {
		if err = tx.QueryRowContext(ctx, `SELECT count(*) FROM item_instances t JOIN homestead_members m ON m.homestead_id=t.owner WHERE m.habitica_id=? AND t.location='storage'
 AND EXISTS(SELECT 1 FROM item_instances f WHERE f.location='fitted' AND f.owner=t.id AND f.item_def IN (`+wardenDefs()+`))`, s.HabiticaID).Scan(&l.WardenTools); err != nil {
			return l, err
		}
	}
	open := "world_id=? AND claimed_at IS NULL AND returned_at IS NULL AND kind!='thanks'"
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM mail WHERE from_id=? AND "+open, s.HabiticaID, s.WorldID).Scan(&l.Outgoing); err != nil {
		return l, err
	}
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM mail WHERE to_id=? AND "+open, s.HabiticaID, s.WorldID).Scan(&l.Incoming); err != nil {
		return l, err
	}
	var deeds int
	if err = tx.QueryRowContext(ctx, "SELECT COALESCE((SELECT deeds FROM player_deeds WHERE habitica_id=?),0)", s.HabiticaID).Scan(&deeds); err != nil {
		return l, err
	}
	if !content.HomeRules.Deeds.FirstFree || deeds > 0 {
		l.DeedCost = content.HomeRules.Deeds.Embers
	}
	return l, nil
}

func (a *Server) worldRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	v, err := loadWorldView(r.Context(), tx, s, a.Config.Now().Unix())
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, v)
}

// worldParty makes the party's world for the party the caller's last
// sign-in reported, when it has none yet (sign-in makes it too; this is for
// a session older than that). It moves no one. Session only, no play lease.
func (a *Server) worldParty(w http.ResponseWriter, r *http.Request) error {
	var req struct{}
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
	if s.HabiticaPartyID == nil || *s.HabiticaPartyID == "" {
		return fail(409, "no-party")
	}
	if _, err = ensurePartyWorld(ctx, tx, s.HabiticaPartyID, now); err != nil {
		return err
	}
	v, err := loadWorldView(ctx, tx, s, now)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, v)
}

// worldPrompt records that the party world's join prompt was shown.
func (a *Server) worldPrompt(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		WorldID string `json:"worldId"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	if req.WorldID == "" || len(req.WorldID) > 128 {
		return fail(400, "invalid-request")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	var exists int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM worlds WHERE id=?", req.WorldID).Scan(&exists); err != nil {
		return err
	}
	if exists == 0 {
		return fail(404, "world-not-found")
	}
	now := a.Config.Now().Unix()
	if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO party_prompts VALUES(?,?,?)", s.HabiticaID, req.WorldID, now); err != nil {
		return err
	}
	v, err := loadWorldView(ctx, tx, s, now)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, v)
}

// worldMove moves the caller to another world in one keyed transaction.
// With them go their character, story, embers, pack and personal chest (all
// keyed by player, not world). Their homestead membership ends exactly as a
// "leave" does; furniture, the shared chest, shelf stock, Wilds claims and
// project contributions stay with the old world. Parcels waiting for them
// go back to their senders; parcels they sent must be recalled first (a move
// never takes back a gift on its own). Their unused invite codes now admit
// friends to the new world.
func (a *Server) worldMove(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		Key      string          `json:"key"`
		Progress json.RawMessage `json:"progress,omitempty"`
		WorldID  string          `json:"worldId"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	if req.WorldID == "" || len(req.WorldID) > 128 {
		return fail(400, "invalid-request")
	}
	mover := ""
	return a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if !rules.SafeAreas[s.State.Area] {
			return nil, fail(409, "not-at-safe-boundary")
		}
		from := s.WorldID
		if req.WorldID == from {
			return nil, fail(409, "already-in-world")
		}
		target, err := loadWorldRef(ctx, tx, req.WorldID)
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
		if target.ID != pw && target.OwnerID != s.HabiticaID {
			return nil, fail(403, "world-access-denied")
		}
		if opens, err := moveOpensAt(ctx, tx, s.HabiticaID, now); err != nil {
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
		if err = settleHomes(ctx, tx, from, now); err != nil {
			return nil, err
		}
		homeID, member, err := memberOf(ctx, tx, s.HabiticaID)
		if err != nil {
			return nil, err
		}
		if member {
			h, err := loadHome(ctx, tx, homeID, s.HabiticaID, now)
			if err != nil {
				return nil, err
			}
			if err = leave(ctx, tx, s, h, now); err != nil {
				return nil, err
			}
		}
		// Deed invitations to them belong to the old world's lane.
		if _, err = tx.ExecContext(ctx, "DELETE FROM homestead_invites WHERE to_id=?", s.HabiticaID); err != nil {
			return nil, err
		}
		rows, err := tx.QueryContext(ctx, "SELECT id FROM mail WHERE to_id=? AND world_id=? AND claimed_at IS NULL AND returned_at IS NULL AND kind!='thanks' ORDER BY sent_at,id", s.HabiticaID, from)
		if err != nil {
			return nil, err
		}
		incoming := []string{}
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				rows.Close()
				return nil, err
			}
			incoming = append(incoming, id)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
		for _, id := range incoming {
			if _, err = store.ReturnMail(ctx, tx, id, "recipient-removed", now, true); err != nil {
				return nil, err
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE players SET world_id=? WHERE habitica_id=?", target.ID, s.HabiticaID); err != nil {
			return nil, err
		}
		// Codes they handed out follow them: a friend joins them, not the world they left.
		if _, err = tx.ExecContext(ctx, "UPDATE invites SET world_id=? WHERE created_by=? AND world_id=? AND used_by IS NULL AND revoked_at IS NULL AND expires_at>?", target.ID, s.HabiticaID, from, now); err != nil {
			return nil, err
		}
		s.WorldID = target.ID
		if err = store.Credit(ctx, tx, s, 0, 0, "world-move", from+">"+target.ID, nil, now); err != nil {
			return nil, err
		}
		mover = s.HabiticaID
		v, err := loadWorldView(ctx, tx, *s, now)
		if err != nil {
			return nil, err
		}
		return struct {
			World    worldView `json:"world"`
			From     string    `json:"from"`
			LeftHome bool      `json:"leftHome"`
			Returned int       `json:"returned"`
		}{v, from, member, len(incoming)}, nil
	}, func() {
		// Presence follows: the live socket moves to the new world's rooms.
		if mover != "" {
			a.presenceChanged(mover)
		}
	})
}
