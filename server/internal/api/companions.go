// Companions (docs/design/crafts.md 2.2–2.4): which pet walks with the hero
// and which live at home. Every key is resolved against the account's latest
// owned list when someone looks — a lapsed key reads as its fallback and the
// stored row waits, unchanged, for a pet that comes back. The stable and its
// mounts are in stable.go.
package api

import (
	"context"
	"database/sql"
	contract "glimway/server/internal/gen/glimway/v1"
	profiles "glimway/server/internal/profile"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
	"slices"
)

// A yard holds three spots per member (2.2; migration 030's slot range).
const maxYardPets = 3

// deedHere is the account's homestead when it stands in the account's current
// world: without one the choices are gated away, waiting unchanged (2.2).
func deedHere(ctx context.Context, tx *sql.Tx, s *store.Snapshot) (string, bool, error) {
	id, ok, err := memberOf(ctx, tx, s.AccountID)
	if err != nil || !ok {
		return "", false, err
	}
	var world string
	if err = tx.QueryRowContext(ctx, "SELECT world_id FROM homesteads WHERE id=?", id).Scan(&world); err != nil {
		return "", false, err
	}
	return id, world == s.WorldID, nil
}

// companions chooses the follower and the yard (6.2, `POST /api/companions`):
// profile source habitica, a deed in this world, each key owned (the
// follower may also be '' or store.NoFollower), at most
// three yard pets and no repeats. It writes the rows and the room hears an
// avatar change.
func (a *Server) companions(w http.ResponseWriter, r *http.Request) error {
	req := &contract.CompanionsRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	var account string
	var avatar *presenceAvatarMsg
	err := a.keyedOpStay(w, r, req.Op, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if s.ProfileSource != "habitica" {
			return nil, fail(409, "needs-habitica")
		}
		if _, ok, err := deedHere(ctx, tx, s); err != nil {
			return nil, err
		} else if !ok {
			return nil, fail(404, "homestead-not-found")
		}
		p := s.ImportedProfile
		if p == nil {
			return nil, fail(409, "needs-habitica")
		}
		// '' is Habitica's current pet and NoFollower is No pet: neither
		// names a key to own.
		follow := req.GetFollowPet()
		if follow != "" && follow != store.NoFollower && !slices.Contains(p.Pets, follow) {
			return nil, fail(409, "companion-not-owned")
		}
		yard := req.GetYardPets()
		if len(yard) > maxYardPets {
			return nil, fail(400, "invalid-request")
		}
		seen := map[string]bool{}
		for _, key := range yard {
			if key == "" || seen[key] {
				return nil, fail(400, "invalid-request")
			}
			seen[key] = true
			if !slices.Contains(p.Pets, key) {
				return nil, fail(409, "companion-not-owned")
			}
		}
		// The choices hold while the account is on a deed in this world;
		// the mount rows are not touched here.
		if _, err := tx.ExecContext(ctx, `INSERT INTO player_companions(account_id,follow_pet) VALUES(?,?)
 ON CONFLICT(account_id) DO UPDATE SET follow_pet=excluded.follow_pet`, s.AccountID, follow); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM yard_pets WHERE account_id=?", s.AccountID); err != nil {
			return nil, err
		}
		for i, key := range yard {
			if _, err := tx.ExecContext(ctx, "INSERT INTO yard_pets(account_id,slot,pet_key) VALUES(?,?,?)", s.AccountID, i+1, key); err != nil {
				return nil, err
			}
		}
		c, err := store.CompanionsFor(ctx, tx, s.AccountID, s.WorldID, s.ProfileSource, p)
		if err != nil {
			return nil, err
		}
		account = s.AccountID
		avatar = visualAvatar(*p, c)
		return &contract.CompanionsResult{Companions: store.CompanionsProto(c)}, nil
	}, func() {
		if avatar != nil {
			a.avatarChanged(account, avatar)
		}
	})
	return err
}

// homeCompanions reads what a homestead shows of its members' companions
// (2.4, 3.4): the yard pets and the stalls, every key resolved against its
// owner's latest owned list, so visitors see what the owners see. Lapsed
// spots read empty and their stored rows wait for a pet that comes back.
func homeCompanions(ctx context.Context, tx *sql.Tx, h homeView) ([]stallView, []yardPetView, error) {
	type member struct {
		name string
		p    *rules.Profile
	}
	byID := map[string]member{}
	for _, m := range h.Members {
		var source, world string
		if err := tx.QueryRowContext(ctx, "SELECT profile_source,world_id FROM players WHERE account_id=?", m.ID).Scan(&source, &world); err != nil {
			return nil, nil, err
		}
		if source != "habitica" || world != h.WorldID {
			continue
		}
		p, err := profiles.For(ctx, tx, profiles.Account{ID: m.ID, Source: source})
		if err != nil || p == nil {
			return nil, nil, err
		}
		byID[m.ID] = member{name: m.DisplayName, p: p}
	}
	yard := []yardPetView{}
	for _, m := range h.Members {
		who, ok := byID[m.ID]
		if !ok {
			continue
		}
		rows, err := tx.QueryContext(ctx, "SELECT slot,pet_key FROM yard_pets WHERE account_id=? ORDER BY slot", m.ID)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var slot int
			var key string
			if err = rows.Scan(&slot, &key); err != nil {
				rows.Close()
				return nil, nil, err
			}
			if slices.Contains(who.p.Pets, key) {
				yard = append(yard, yardPetView{OwnerID: m.ID, Pet: key, Slot: slot})
			}
		}
		if err = rows.Err(); err != nil {
			rows.Close()
			return nil, nil, err
		}
		rows.Close()
	}
	stalls := []stallView{}
	if stable := stablePlaced(h); stable != nil {
		n := stallCount(*stable)
		standing := map[int]stallView{}
		rows, err := tx.QueryContext(ctx, "SELECT stall,mount_key,owner_id FROM homestead_stalls WHERE homestead_id=? ORDER BY stall", h.ID)
		if err != nil {
			return nil, nil, err
		}
		for rows.Next() {
			var v stallView
			var key, owner string
			if err = rows.Scan(&v.Stall, &key, &owner); err != nil {
				rows.Close()
				return nil, nil, err
			}
			who, ok := byID[owner]
			if ok && slices.Contains(who.p.Mounts, key) {
				// The mount that is out is out with its owner (3.3).
				c, err := store.CompanionsFor(ctx, tx, owner, h.WorldID, "habitica", who.p)
				if err != nil {
					rows.Close()
					return nil, nil, err
				}
				v.Mount, v.OwnerID, v.OwnerName = key, owner, who.name
				v.Out = c.MountOut == key && c.MountHome == h.ID
				standing[v.Stall] = v
			}
		}
		if err = rows.Err(); err != nil {
			rows.Close()
			return nil, nil, err
		}
		rows.Close()
		for i := 1; i <= n; i++ {
			if v, ok := standing[i]; ok {
				stalls = append(stalls, v)
			} else {
				stalls = append(stalls, stallView{Stall: i})
			}
		}
	}
	return stalls, yard, nil
}
