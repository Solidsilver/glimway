// Companions (docs/design/crafts.md 2.2, 3.3): the account's follower, yard
// pets and the mount that is out, every key resolved against the latest owned
// list when someone looks. A lapsed key reads as its fallback — the follower
// as Habitica's current pet, a yard spot as empty, the mount as back in its
// stall — and the stored rows are not rewritten until the player next changes
// them: a pet that comes back (a re-hatch) comes back to its place.
package store

import (
	"context"
	"database/sql"
	"errors"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"slices"
)

// NoFollower is the follower choice "No pet": the hero walks alone. It is a
// reserved value of follow_pet (Habitica's keys are `Species-Potion`, so no
// pet is ever called this), held and gated like any other choice.
const NoFollower = "none"

// Companions is what an account shows, resolved. FollowPet is '' when the
// follower reads as Habitica's current pet (nothing chosen, the choice lapsed
// or gated away — or a guest), NoFollower when the player chose No pet; YardPets is slot order, with a lapsed spot
// empty (its pet drops out and its stored row keeps the slot, so a pet that
// comes back comes back to its place); MountOut is '' when every mount reads
// as in its stall, and MountHome names the homestead it came from only while
// one is out.
type Companions struct {
	FollowPet string
	YardPets  []string
	MountOut  string
	MountHome string
}

// Follower is the pet that walks with the account: the resolved choice, or
// Habitica's current pet when the choice reads as its fallback, '' for No
// pet. This is what presence carries (3.4).
func (c Companions) Follower(p *rules.Profile) string {
	if c.FollowPet == NoFollower {
		return ""
	}
	if c.FollowPet != "" {
		return c.FollowPet
	}
	if p != nil && p.SelectedPet != nil {
		return *p.SelectedPet
	}
	return ""
}

// companionReader is *sql.Tx or *sql.DB.
type companionReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// CompanionsProto is the resolved view on the wire (review finding 17: one
// mapping, not one here and one in the api).
func CompanionsProto(c Companions) *contract.Companions {
	return &contract.Companions{FollowPet: c.FollowPet, YardPets: c.YardPets, MountOut: c.MountOut, MountHome: c.MountHome}
}

// SendMountHome sends the account's mount home (review finding 16): off the
// road and out of any stall it stood in. One helper, so every path that
// takes the mount out clears the same two columns the same way.
func SendMountHome(ctx context.Context, tx *sql.Tx, account string) error {
	_, err := tx.ExecContext(ctx, "UPDATE player_companions SET mount_out='',mount_home=NULL WHERE account_id=?", account)
	return err
}

// CompanionsFor resolves the account's companions as they read right now.
// The choices hold while the account is on a deed in its current world; the
// mount is out only while a stall on the homestead it came from still holds
// that key for this account, on that deed, in that world, and the key is in
// the owned mounts. Guests (and `profile_source: none`) get none of this.
func CompanionsFor(ctx context.Context, q companionReader, id, world, source string, p *rules.Profile) (Companions, error) {
	var out Companions
	if source != "habitica" || p == nil {
		return out, nil
	}
	var follow, mountOut, mountHome string
	err := q.QueryRowContext(ctx, "SELECT follow_pet,mount_out,COALESCE(mount_home,'') FROM player_companions WHERE account_id=?", id).Scan(&follow, &mountOut, &mountHome)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	// A homestead in this world gates the choices (and the mount's deed).
	var deed string
	err = q.QueryRowContext(ctx, "SELECT h.id FROM homestead_members m JOIN homesteads h ON h.id=m.homestead_id WHERE m.account_id=? AND h.world_id=?", id, world).Scan(&deed)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return out, err
	}
	if deed != "" {
		if follow == NoFollower || slices.Contains(p.Pets, follow) {
			out.FollowPet = follow
		}
		rows, err := q.QueryContext(ctx, "SELECT slot,pet_key FROM yard_pets WHERE account_id=? ORDER BY slot", id)
		if err != nil {
			return out, err
		}
		bySlot := map[int]string{}
		for rows.Next() {
			var slot int
			var key string
			if err = rows.Scan(&slot, &key); err != nil {
				rows.Close()
				return out, err
			}
			bySlot[slot] = key
		}
		if err = rows.Err(); err != nil {
			rows.Close()
			return out, err
		}
		rows.Close()
		slots := make([]int, 0, len(bySlot))
		for slot := range bySlot {
			slots = append(slots, slot)
		}
		// The stored slots in order, never assumed contiguous (review
		// finding 16): a lapsed spot keeps its slot, so the numbers can gap.
		slices.Sort(slots)
		for _, slot := range slots {
			// A lapsed spot reads empty: its pet drops out of the list and
			// its stored row keeps the slot (2.2).
			if key := bySlot[slot]; slices.Contains(p.Pets, key) {
				out.YardPets = append(out.YardPets, key)
			}
		}
	}
	if mountOut != "" && mountHome != "" && slices.Contains(p.Mounts, mountOut) {
		// A stall on mount_home holds that key with this account as owner,
		// the account is on that deed, and the account's world is that
		// homestead's world (3.3).
		var held bool
		err = q.QueryRowContext(ctx, `SELECT EXISTS(
 SELECT 1 FROM homestead_stalls s JOIN homestead_members m ON m.homestead_id=s.homestead_id AND m.account_id=? JOIN homesteads h ON h.id=s.homestead_id
 WHERE s.homestead_id=? AND s.owner_id=? AND s.mount_key=? AND h.world_id=?)`, id, mountHome, id, mountOut, world).Scan(&held)
		if err != nil {
			return out, err
		}
		if held {
			out.MountOut, out.MountHome = mountOut, mountHome
		}
	}
	return out, nil
}
