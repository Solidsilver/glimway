package api

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/land"
	profiles "glimway/server/internal/profile"
	"slices"
)

// Public overlays are read in a fixed number of queries, independent of the
// number of homes/members. Only the caller can see their carried furnishings; no per-member profile reads.
// Missing/corrupt optional companion evidence makes that member's pets/stalls
// read empty, rather than breaking the lane for everyone.
func commonsHomes(ctx context.Context, tx *sql.Tx, world, caller string, now int64) ([]homeView, error) {
	out := []homeView{}
	byID := map[string]int{}
	query := func(q string, scan func(*sql.Rows) error, args ...any) error {
		if len(args) == 0 {
			args = []any{world}
		}
		rows, err := tx.QueryContext(ctx, q, args...)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			if err = scan(rows); err != nil {
				return err
			}
		}
		return rows.Err()
	}
	err := query(`SELECT id,gate,tier,posts_bought,vacant_since FROM homesteads WHERE world_id=? ORDER BY gate`, func(r *sql.Rows) error {
		h := homeView{WorldID: world, Outdoor: content.Outdoor(content.HomeRules), Items: []homeInstance{}, Cleared: tileList{}, Stumps: tileList{}, Plants: []homePlantView{}, Members: []homeMember{}, Stalls: []stallView{}, YardPets: []yardPetView{}}
		if e := r.Scan(&h.ID, &h.Gate, &h.Tier, &h.PostsBought, &h.VacantSince); e != nil {
			return e
		}
		h.Desolate = desolate(h.VacantSince, now)
		h.LandSeed = land.Seed(world, h.Gate, content.HomeRules.GetLand())
		h.NextPost = content.HomePostCost(content.HomeRules, h.PostsBought)
		if h.Tier >= 1 {
			h.Indoor = content.HomeRules.GetIndoor()
		}
		byID[h.ID] = len(out)
		out = append(out, h)
		return nil
	})
	if err != nil {
		return nil, err
	}
	members, err := profiles.WorldMembers(ctx, tx, world)
	if err != nil {
		return nil, err
	}
	owners := map[string]profiles.WorldMember{}
	for _, m := range members {
		h := &out[byID[m.Home]]
		h.Members = append(h.Members, homeMember{ID: m.ID, DisplayName: m.Name})
		h.Member = h.Member || m.ID == caller
		owners[m.ID] = m
	}

	err = query(`SELECT i.homestead_id,i.id,i.item_def,i.scene,i.x,i.y,i.rotation,i.name,i.stalls FROM homestead_items i JOIN homesteads h ON h.id=i.homestead_id WHERE h.world_id=? AND i.location='placed' ORDER BY i.id`, func(r *sql.Rows) error {
		var home string
		var i homeInstance
		if e := r.Scan(&home, &i.ID, &i.ItemDef, &i.Scene, &i.X, &i.Y, &i.Rotation, &i.Name, &i.Stalls); e != nil {
			return e
		}
		h := &out[byID[home]]
		h.Items = append(h.Items, i)
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = query(`SELECT h.id,i.id,i.item_def,i.scene,i.x,i.y,i.rotation,i.name,i.stalls FROM homestead_items i JOIN homestead_members m ON m.account_id=i.account_id JOIN homesteads h ON h.id=m.homestead_id WHERE h.world_id=? AND i.account_id=? AND i.location='inventory' ORDER BY i.id`, func(r *sql.Rows) error {
		var home string
		var i homeInstance
		if e := r.Scan(&home, &i.ID, &i.ItemDef, &i.Scene, &i.X, &i.Y, &i.Rotation, &i.Name, &i.Stalls); e != nil {
			return e
		}
		h := &out[byID[home]]
		h.Items = append(h.Items, i)
		return nil
	}, world, caller)
	if err != nil {
		return nil, err
	}

	for _, table := range []string{"homestead_cleared", "homestead_stumps"} {
		err = query("SELECT t.homestead_id,t.x,t.y FROM "+table+" t JOIN homesteads h ON h.id=t.homestead_id WHERE h.world_id=? ORDER BY t.y,t.x", func(r *sql.Rows) error {
			var home string
			var tile [2]int
			if e := r.Scan(&home, &tile[0], &tile[1]); e != nil {
				return e
			}
			h := &out[byID[home]]
			if table == "homestead_cleared" {
				h.Cleared = append(h.Cleared, tile)
			} else {
				h.Stumps = append(h.Stumps, tile)
			}
			return nil
		})
		if err != nil {
			return nil, err
		}
	}
	err = query(`SELECT p.homestead_id,p.id,p.item_def,p.x,p.y,p.planted_at,p.planted_day FROM homestead_plants p JOIN homesteads h ON h.id=p.homestead_id WHERE h.world_id=? ORDER BY p.planted_at,p.id`, func(r *sql.Rows) error {
		var home string
		var p homePlantView
		if e := r.Scan(&home, &p.ID, &p.ItemDef, &p.X, &p.Y, &p.PlantedAt, &p.PlantedDay); e != nil {
			return e
		}
		h := &out[byID[home]]
		h.Plants = append(h.Plants, p)
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = query(`SELECT m.homestead_id,y.account_id,y.slot,y.pet_key FROM yard_pets y JOIN homestead_members m ON m.account_id=y.account_id JOIN homesteads h ON h.id=m.homestead_id WHERE h.world_id=? ORDER BY y.account_id,y.slot`, func(r *sql.Rows) error {
		var home, id, key string
		var slot int
		if e := r.Scan(&home, &id, &slot, &key); e != nil {
			return e
		}
		who := owners[id]
		if who.Profile != nil && slices.Contains(who.Profile.Pets, key) {
			h := &out[byID[home]]
			h.YardPets = append(h.YardPets, yardPetView{OwnerID: id, Slot: slot, Pet: key})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	err = query(`SELECT s.homestead_id,s.stall,s.owner_id,s.mount_key FROM homestead_stalls s JOIN homesteads h ON h.id=s.homestead_id WHERE h.world_id=? ORDER BY s.stall`, func(r *sql.Rows) error {
		var home, id, key string
		var stall int
		if e := r.Scan(&home, &stall, &id, &key); e != nil {
			return e
		}
		h := &out[byID[home]]
		who := owners[id]
		stable := stablePlaced(*h)
		if stable != nil && stall <= stallCount(*stable) && who.Profile != nil && who.Home == home && slices.Contains(who.Profile.Mounts, key) {
			h.Stalls = append(h.Stalls, stallView{Stall: stall, OwnerID: id, OwnerName: who.Name, Mount: key, Out: who.Mount == key && who.MountHome == home})
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for i := range out {
		h := &out[i]
		h.Plants = plantsOf(*h, h.Plants, now)
		if stable := stablePlaced(*h); stable != nil {
			held := h.Stalls
			h.Stalls = []stallView{}
			for n := 1; n <= stallCount(*stable); n++ {
				s := stallView{Stall: n}
				for _, v := range held {
					if v.Stall == n {
						s = v
						break
					}
				}
				h.Stalls = append(h.Stalls, s)
			}
		}
	}
	return out, nil
}
