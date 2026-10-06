package store

import (
	"context"
	"database/sql"
	"fmt"
	"time"
)

// Party worlds, for the operator (docs/home-server.md "Party worlds and world
// moves"): list them, close or reopen a party's admission, and adopt a
// person's world that an older link tied to a party as that party's world.

// PartyRecord is one party the server knows: its world (none when it's
// closed before one was made), who opened it, how many live there, and how
// many accounts came in through the party.
type PartyRecord struct {
	PartyID      string  `json:"partyId"`
	WorldID      *string `json:"worldId"`
	Members      int     `json:"members"`
	OpenedBy     *string `json:"openedBy"`
	OpenedByName *string `json:"openedByName"`
	CreatedAt    *int64  `json:"createdAt"`
	// Admitted: accounts let in through a party (allowlist added_by 'party')
	// whose last sign-in reported this one.
	Admitted int `json:"admitted"`
	// Held: accounts let in through this party who signed in but haven't
	// chosen a world yet (a live held sign-in, no player row). Closing the
	// party keeps them out of its world.
	Held     int    `json:"held"`
	ClosedAt *int64 `json:"closedAt"`
}

func (s *Store) Parties(ctx context.Context) ([]PartyRecord, error) {
	rows, err := s.DB.QueryContext(ctx, `SELECT p.party_id,w.id,(SELECT count(*) FROM players m WHERE m.world_id=w.id),w.opened_by,o.display_name,w.created_at,
 (SELECT count(*) FROM allowlist a JOIN players x USING(habitica_id) WHERE a.added_by='party' AND x.habitica_party_id=p.party_id),
 (SELECT count(DISTINCT h.habitica_id) FROM pending_sessions h JOIN allowlist a USING(habitica_id) WHERE a.added_by='party' AND h.habitica_party_id=p.party_id AND h.expires_at>? AND NOT EXISTS(SELECT 1 FROM players x WHERE x.habitica_id=h.habitica_id)),c.closed_at
 FROM (SELECT habitica_party_id AS party_id FROM worlds WHERE owner_id='' AND habitica_party_id IS NOT NULL UNION SELECT party_id FROM party_closures) p
 LEFT JOIN worlds w ON w.owner_id='' AND w.habitica_party_id=p.party_id
 LEFT JOIN players o ON o.habitica_id=w.opened_by
 LEFT JOIN party_closures c ON c.party_id=p.party_id
 ORDER BY w.created_at IS NULL,w.created_at,p.party_id`, time.Now().Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PartyRecord{}
	for rows.Next() {
		var v PartyRecord
		if err = rows.Scan(&v.PartyID, &v.WorldID, &v.Members, &v.OpenedBy, &v.OpenedByName, &v.CreatedAt, &v.Admitted, &v.Held, &v.ClosedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// SetPartyOpen closes a party (no one is admitted through it, and no world
// is made for it) or opens it again. Its world, and everyone already in, stay.
func (s *Store) SetPartyOpen(ctx context.Context, party string, open bool) error {
	if party == "" || len(party) > 128 {
		return fmt.Errorf("invalid party id")
	}
	if open {
		_, err := s.DB.ExecContext(ctx, "DELETE FROM party_closures WHERE party_id=?", party)
		return err
	}
	_, err := s.DB.ExecContext(ctx, "INSERT INTO party_closures VALUES(?,?) ON CONFLICT(party_id) DO NOTHING", party, time.Now().Unix())
	return err
}

// AdoptWorld makes a person's world, linked to a party before party worlds
// (migration 022), that party's world: owner_id '' and the party id kept, its
// former owner recorded as the one who opened it. Everyone living there
// stays. A party world already made for the party is set aside first when no
// one lives in it (it keeps its rows, but belongs to no party); one someone
// lives in is never replaced. Returns the party id.
func (s *Store) AdoptWorld(ctx context.Context, world string) (string, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return "", err
	}
	defer tx.Rollback()
	var owner string
	var party sql.NullString
	if err = tx.QueryRowContext(ctx, "SELECT owner_id,habitica_party_id FROM worlds WHERE id=?", world).Scan(&owner, &party); err == sql.ErrNoRows {
		return "", fmt.Errorf("world not found")
	} else if err != nil {
		return "", err
	}
	if owner == "" {
		return "", fmt.Errorf("already a party's world")
	}
	if !party.Valid || party.String == "" {
		return "", fmt.Errorf("world was never linked to a party")
	}
	var current string
	var members int
	err = tx.QueryRowContext(ctx, "SELECT id,(SELECT count(*) FROM players m WHERE m.world_id=w.id) FROM worlds w WHERE owner_id='' AND habitica_party_id=?", party.String).Scan(&current, &members)
	if err != nil && err != sql.ErrNoRows {
		return "", err
	}
	if current != "" {
		if members > 0 {
			return "", fmt.Errorf("party %s already has a world (%s) with %d living there", party.String, current, members)
		}
		if _, err = tx.ExecContext(ctx, "UPDATE worlds SET habitica_party_id=NULL WHERE id=?", current); err != nil {
			return "", err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM party_prompts WHERE world_id=?", current); err != nil {
			return "", err
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE worlds SET owner_id='',opened_by=? WHERE id=?", owner, world); err != nil {
		return "", err
	}
	return party.String, tx.Commit()
}
