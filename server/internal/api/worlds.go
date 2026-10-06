package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
	"net/http"
)

// Worlds and party links (docs/expansion-design.md "Worlds"). Being in the
// same Habitica party counts as an invite: a member may move into a world
// linked to their party, or back to a world they own. The party is read only
// at sign-in (players.habitica_party_id); leaving a party never moves anyone.

type worldRef struct {
	ID        string `json:"id"`
	OwnerID   string `json:"ownerId"`
	OwnerName string `json:"ownerName"`
	Members   int    `json:"members"`
	party     sql.NullString
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
}

type worldView struct {
	World worldRef `json:"world"`
	// IsOwner: the caller owns this world (and may link or unlink it).
	IsOwner bool `json:"isOwner"`
	// InParty: the caller's last sign-in reported a party.
	InParty bool `json:"inParty"`
	// Linked: this world is linked to a party; LinkedToMine: the caller's.
	Linked       bool `json:"linked"`
	LinkedToMine bool `json:"linkedToMine"`
	// PartyWorld: the caller's party's world, when that is somewhere else.
	PartyWorld *worldRef `json:"partyWorld"`
	// OwnWorld: a world the caller owns, when they live somewhere else.
	OwnWorld *worldRef `json:"ownWorld"`
	// Prompt: PartyWorld is set and its join prompt hasn't been shown.
	Prompt  bool        `json:"prompt"`
	Leaving leavingView `json:"leaving"`
}

func loadWorldRef(ctx context.Context, tx *sql.Tx, id string) (worldRef, error) {
	var w worldRef
	err := tx.QueryRowContext(ctx, `SELECT w.id,w.owner_id,COALESCE(p.display_name,''),(SELECT count(*) FROM players m WHERE m.world_id=w.id),w.habitica_party_id
 FROM worlds w LEFT JOIN players p ON p.habitica_id=w.owner_id WHERE w.id=?`, id).Scan(&w.ID, &w.OwnerID, &w.OwnerName, &w.Members, &w.party)
	return w, err
}

// partyWorld is the oldest world linked to a party ("" when none).
func partyWorld(ctx context.Context, tx *sql.Tx, party *string) (string, error) {
	if party == nil || *party == "" {
		return "", nil
	}
	var id string
	err := tx.QueryRowContext(ctx, "SELECT id FROM worlds WHERE habitica_party_id=? ORDER BY created_at,id LIMIT 1", *party).Scan(&id)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return id, err
}

func loadWorldView(ctx context.Context, tx *sql.Tx, s store.Snapshot) (worldView, error) {
	var v worldView
	var err error
	if v.World, err = loadWorldRef(ctx, tx, s.WorldID); err != nil {
		return v, err
	}
	party := s.HabiticaPartyID
	v.IsOwner = v.World.OwnerID == s.HabiticaID
	v.InParty = party != nil && *party != ""
	v.Linked = v.World.party.Valid
	v.LinkedToMine = v.InParty && v.World.party.String == *party
	pw, err := partyWorld(ctx, tx, party)
	if err != nil {
		return v, err
	}
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
	if own != "" && own != pw {
		ref, err := loadWorldRef(ctx, tx, own)
		if err != nil {
			return v, err
		}
		v.OwnWorld = &ref
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
	open := "world_id=? AND claimed_at IS NULL AND returned_at IS NULL AND kind!='thanks'"
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM mail WHERE from_id=? AND "+open, s.HabiticaID, s.WorldID).Scan(&l.Outgoing); err != nil {
		return l, err
	}
	err = tx.QueryRowContext(ctx, "SELECT count(*) FROM mail WHERE to_id=? AND "+open, s.HabiticaID, s.WorldID).Scan(&l.Incoming)
	return l, err
}

func (a *Server) worldRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	v, err := loadWorldView(r.Context(), tx, s)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, v)
}

// worldParty links the owner's world to the party their last sign-in
// reported, or unlinks it. A world setting, like invites: no play lease.
func (a *Server) worldParty(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Link *bool `json:"link"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	if req.Link == nil {
		return fail(400, "invalid-request")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	ref, err := loadWorldRef(ctx, tx, s.WorldID)
	if err != nil {
		return err
	}
	if ref.OwnerID != s.HabiticaID {
		return fail(403, "not-world-owner")
	}
	var party any
	if *req.Link {
		if s.HabiticaPartyID == nil || *s.HabiticaPartyID == "" {
			return fail(409, "no-party")
		}
		party = *s.HabiticaPartyID
	}
	if _, err = tx.ExecContext(ctx, "UPDATE worlds SET habitica_party_id=? WHERE id=?", party, s.WorldID); err != nil {
		return err
	}
	v, err := loadWorldView(ctx, tx, s)
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
	if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO party_prompts VALUES(?,?,?)", s.HabiticaID, req.WorldID, a.Config.Now().Unix()); err != nil {
		return err
	}
	v, err := loadWorldView(ctx, tx, s)
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
// go back to their senders; parcels they sent must be recalled first, since
// a recall can land things in the old homestead's storage.
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
		party := s.HabiticaPartyID
		inParty := party != nil && *party != "" && target.party.Valid && target.party.String == *party
		if !inParty && target.OwnerID != s.HabiticaID {
			return nil, fail(403, "world-access-denied")
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
		s.WorldID = target.ID
		if err = store.Credit(ctx, tx, s, 0, 0, "world-move", from+">"+target.ID, nil, now); err != nil {
			return nil, err
		}
		mover = s.HabiticaID
		v, err := loadWorldView(ctx, tx, *s)
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
