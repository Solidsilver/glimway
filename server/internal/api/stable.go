// The stable (docs/design/crafts.md 3.2–3.4): one placed piece whose
// footprint grows east two tiles a bay, the stalls it holds on a shared
// deed, and the mount that is out with its owner. A stalled mount stands in
// its bay until its owner empties the stall; nobody moves a partner's mount,
// and only its owner saddles or leads it.
package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/land"
	profiles "glimway/server/internal/profile"
	"glimway/server/internal/store"
	"net/http"
	"slices"
)

// stableItemID is the stable's furnishing row (content/homestead.json).
func stableItemID() string { return content.HomeRules.GetStable().GetItem() }

// stallCount is the stable's bay count: the piece grows with it (3.2), and
// every stable carries at least its first bay ("comes with stall 1").
func stallCount(v homeInstance) int {
	if v.Stalls != nil && *v.Stalls >= 1 {
		return *v.Stalls
	}
	return 1
}

// stablePlaced is the homestead's standing stable, if any. One per
// homestead; a carried one waits in its owner's pack (3.2).
func stablePlaced(h homeView) *homeInstance {
	for i := range h.Items {
		if h.Items[i].ItemDef == stableItemID() && h.Items[i].Scene != nil {
			return &h.Items[i]
		}
	}
	return nil
}

// stallRect is a bay's tiles on the land: the tack room is two tiles at the
// west end, then every bay is two tiles wide and three deep (3.2).
func stallRect(stable homeInstance, stall int) rect {
	return rect{*stable.X + 2*stall, *stable.Y, 2, 3}
}

// nearStall is the walk-up check (3.3): `where` stands within two tiles of
// the bay, measured from its tiles.
func nearStall(where *contract.Where, r rect) bool {
	x0, y0 := float64(r.x*wildsTileSize), float64(r.y*wildsTileSize)
	x1, y1 := float64((r.x+r.w)*wildsTileSize), float64((r.y+r.h)*wildsTileSize)
	dx := max(x0-where.X, 0, where.X-x1)
	dy := max(y0-where.Y, 0, where.Y-y1)
	return dx*dx+dy*dy <= float64(2*2*wildsTileSize*wildsTileSize)
}

// mountHeld: the owner's latest owned list still names the mount key. A
// lapsed key reads as an empty stall everywhere (2.2's rule), and the stored
// row waits for a mount that comes back.
func mountHeld(ctx context.Context, tx *sql.Tx, owner, key string) (bool, error) {
	var source string
	if err := tx.QueryRowContext(ctx, "SELECT profile_source FROM players WHERE account_id=?", owner).Scan(&source); err != nil {
		return false, err
	}
	p, err := profiles.For(ctx, tx, profiles.Account{ID: owner, Source: source})
	if err != nil {
		return false, err
	}
	return p != nil && slices.Contains(p.Mounts, key), nil
}

// stallsInUse is the stable's removal gate (3.2): every stall empty and no
// stalled mount out. A mount that is out still stands in its stall, so the
// one check covers both.
func stallsInUse(ctx context.Context, tx *sql.Tx, home string) (bool, error) {
	rows, err := tx.QueryContext(ctx, "SELECT owner_id,mount_key FROM homestead_stalls WHERE homestead_id=?", home)
	if err != nil {
		return false, err
	}
	all := []struct{ owner, key string }{}
	for rows.Next() {
		var v struct{ owner, key string }
		if err = rows.Scan(&v.owner, &v.key); err != nil {
			rows.Close()
			return false, err
		}
		all = append(all, v)
	}
	if err = rows.Err(); err != nil {
		rows.Close()
		return false, err
	}
	rows.Close()
	for _, v := range all {
		held, err := mountHeld(ctx, tx, v.owner, v.key)
		if err != nil {
			return false, err
		}
		if held {
			return true, nil
		}
	}
	return false, nil
}

// stableHome is the named homestead for a member of its deed (6.2).
func stableHome(ctx context.Context, tx *sql.Tx, s *store.Snapshot, home string, now int64) (homeView, error) {
	id, ok, err := memberOf(ctx, tx, s.AccountID)
	if err != nil {
		return homeView{}, err
	}
	if !ok || id != home {
		return homeView{}, fail(409, "not-a-member")
	}
	return loadHome(ctx, tx, home, s.AccountID, now)
}

// stableStall puts a mount in a bay or empties one (6.2, POST
// /api/stable/stall): the stable stands with that stall, the mount is owned
// (or empty), and the bay is empty or holds one of the caller's own mounts.
// The same mount moves between its owner's stalls rather than standing twice.
func (a *Server) stableStall(w http.ResponseWriter, r *http.Request) error {
	req := &contract.StallRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	var account string
	var avatar *presenceAvatarMsg
	var room presenceRoom
	err := a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		h, err := stableHome(ctx, tx, s, req.GetHomeId(), now)
		if err != nil {
			return nil, err
		}
		stable := stablePlaced(h)
		if stable == nil || req.GetStall() < 1 || int(req.GetStall()) > stallCount(*stable) {
			return nil, fail(409, "no-stable")
		}
		p := s.ImportedProfile
		if p == nil {
			return nil, fail(409, "needs-habitica")
		}
		mount := req.GetMount()
		if mount != "" && !slices.Contains(p.Mounts, mount) {
			return nil, fail(409, "companion-not-owned")
		}
		var owner, key string
		err = tx.QueryRowContext(ctx, "SELECT owner_id,mount_key FROM homestead_stalls WHERE homestead_id=? AND stall=?", h.ID, req.GetStall()).Scan(&owner, &key)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if err == nil && owner != s.AccountID {
			held, err := mountHeld(ctx, tx, owner, key)
			if err != nil {
				return nil, err
			}
			if held {
				return nil, fail(409, "stall-taken")
			}
		}
		if mount == "" {
			if _, err := tx.ExecContext(ctx, "DELETE FROM homestead_stalls WHERE homestead_id=? AND stall=? AND owner_id=?", h.ID, req.GetStall(), s.AccountID); err != nil {
				return nil, err
			}
		} else {
			// The same mount moves here from another of its owner's stalls.
			if _, err := tx.ExecContext(ctx, "DELETE FROM homestead_stalls WHERE homestead_id=? AND owner_id=? AND mount_key=?", h.ID, s.AccountID, mount); err != nil {
				return nil, err
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO homestead_stalls(homestead_id,stall,mount_key,owner_id) VALUES(?,?,?,?)
 ON CONFLICT(homestead_id,stall) DO UPDATE SET mount_key=excluded.mount_key,owner_id=excluded.owner_id`, h.ID, req.GetStall(), mount, s.AccountID); err != nil {
				return nil, err
			}
		}
		// A mount that is out stands in a bay (3.3): emptying its bay, or
		// swapping another mount over it, sends it home on the spot — and
		// the room hears the new avatar, as mount-out does.
		c, err := store.CompanionsFor(ctx, tx, s.AccountID, s.WorldID, s.ProfileSource, p)
		if err != nil {
			return nil, err
		}
		if c.MountOut == "" {
			if _, err := tx.ExecContext(ctx, "UPDATE player_companions SET mount_out='',mount_home=NULL WHERE account_id=?", s.AccountID); err != nil {
				return nil, err
			}
		}
		home, err := myHome(ctx, tx, s.AccountID, now)
		if err != nil {
			return nil, err
		}
		account = s.AccountID
		avatar = companionAvatar(c, *p)
		room = homeRoom(s.WorldID, h.Gate)
		out := &contract.StallResult{}
		if home != nil {
			out.Home = homeViewProto(*home)
		}
		return out, nil
	}, func() {
		if avatar != nil {
			a.avatarChanged(account, avatar, room)
		}
	})
	return err
}

// mountOut saddles up the mount stalled at `stall` (6.2, POST
// /api/stable/out): from then on it is out with its owner — ridden or led,
// which the screen owns — until it goes home, a new lease or a world move
// finds it back in its stall (3.3).
func (a *Server) mountOut(w http.ResponseWriter, r *http.Request) error {
	req := &contract.MountOutRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	var account string
	var avatar *presenceAvatarMsg
	var room presenceRoom
	err := a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		h, err := stableHome(ctx, tx, s, req.GetHomeId(), now)
		if err != nil {
			return nil, err
		}
		stable := stablePlaced(h)
		if stable == nil || req.GetStall() < 1 || int(req.GetStall()) > stallCount(*stable) {
			return nil, fail(409, "no-stable")
		}
		// Walk up to the bay: `where` is home:<gate> of this homestead and
		// within two tiles of the stall (3.3).
		if req.Where == nil || req.Where.Area != fmt.Sprintf("home:%d", h.Gate) || !nearStall(req.Where, stallRect(*stable, int(req.GetStall()))) {
			return nil, fail(409, "too-far-away")
		}
		var owner, key string
		err = tx.QueryRowContext(ctx, "SELECT owner_id,mount_key FROM homestead_stalls WHERE homestead_id=? AND stall=?", h.ID, req.GetStall()).Scan(&owner, &key)
		if err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return nil, fail(409, "companion-not-owned")
			}
			return nil, err
		}
		p := s.ImportedProfile
		if owner != s.AccountID || p == nil || !slices.Contains(p.Mounts, key) {
			return nil, fail(409, "companion-not-owned")
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO player_companions(account_id,mount_out,mount_home) VALUES(?,?,?)
 ON CONFLICT(account_id) DO UPDATE SET mount_out=excluded.mount_out,mount_home=excluded.mount_home`, s.AccountID, key, h.ID); err != nil {
			return nil, err
		}
		c, err := store.CompanionsFor(ctx, tx, s.AccountID, s.WorldID, s.ProfileSource, p)
		if err != nil {
			return nil, err
		}
		account = s.AccountID
		avatar = companionAvatar(c, *p)
		// The bay stands empty now: the stable's land hears it (3.4).
		room = homeRoom(s.WorldID, h.Gate)
		return &contract.MountOutResult{Companions: companionsProto(c)}, nil
	}, func() {
		if avatar != nil {
			a.avatarChanged(account, avatar, room)
		}
	})
	return err
}

// mountHome sends the mount that is out back to its stall (6.2, POST
// /api/stable/home). It always succeeds; the walk off the screen is the
// client's drawing (3.4).
func (a *Server) mountHome(w http.ResponseWriter, r *http.Request) error {
	req := &contract.MountHomeRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	var account string
	var avatar *presenceAvatarMsg
	var room presenceRoom
	err := a.keyedOpStay(w, r, req.Op, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		p := s.ImportedProfile
		if s.ProfileSource != "habitica" || p == nil {
			if _, err := tx.ExecContext(ctx, "UPDATE player_companions SET mount_out='' WHERE account_id=?", s.AccountID); err != nil {
				return nil, err
			}
			return &contract.MountHomeResult{Companions: &contract.Companions{YardPets: []string{}}}, nil
		}
		// The bay it fills again: the stable's land hears it (3.4), wherever
		// its owner is.
		before, err := store.CompanionsFor(ctx, tx, s.AccountID, s.WorldID, s.ProfileSource, p)
		if err != nil {
			return nil, err
		}
		if before.MountHome != "" {
			var gate int
			if err := tx.QueryRowContext(ctx, "SELECT gate FROM homesteads WHERE id=?", before.MountHome).Scan(&gate); err != nil {
				return nil, err
			}
			room = homeRoom(s.WorldID, gate)
		}
		if _, err := tx.ExecContext(ctx, "UPDATE player_companions SET mount_out='' WHERE account_id=?", s.AccountID); err != nil {
			return nil, err
		}
		c, err := store.CompanionsFor(ctx, tx, s.AccountID, s.WorldID, s.ProfileSource, p)
		if err != nil {
			return nil, err
		}
		account = s.AccountID
		avatar = companionAvatar(c, *p)
		return &contract.MountHomeResult{Companions: companionsProto(c)}, nil
	}, func() {
		if avatar != nil {
			a.avatarChanged(account, avatar, room)
		}
	})
	return err
}

// stableExtend builds one more bay on the stable's east side (3.1, 6.2):
// fewer than six stalls, the two tiles east of the last bay inside the
// land, clear, buildable and lit, and the bay's growth bill paid. It is a
// new operation because it grows a placed piece and spends growth-priced
// materials (3.2).
func (a *Server) stableExtend(w http.ResponseWriter, r *http.Request) error {
	req := &contract.StableExtendRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		h, err := stableHome(ctx, tx, s, req.GetHomeId(), now)
		if err != nil {
			return nil, err
		}
		stable := stablePlaced(h)
		if stable == nil {
			return nil, fail(409, "no-stable")
		}
		n := stallCount(*stable)
		if n >= int(content.HomeRules.GetStable().GetMaxStalls()) {
			return nil, fail(409, "stable-full")
		}
		// The next bay's tiles: two tiles east of the last one (3.2).
		next := n + 1
		w, _ := footprint(*stable, 0)
		ext := rect{*stable.X + w, *stable.Y, 2, 3}
		if *stable.Scene != "outdoor" {
			return nil, fail(409, "no-stable")
		}
		g := groundOf(h)
		if ext.x < 0 || ext.y < 0 || ext.x+ext.w > g.land.Width || ext.y+ext.h > g.land.Height {
			return nil, fail(409, "out-of-bounds")
		}
		for y := ext.y; y < ext.y+ext.h; y++ {
			for x := ext.x; x < ext.x+ext.w; x++ {
				// The new tiles must be cleared and buildable: anything
				// standing there is ground to clear first.
				if !land.Buildable(g.land.Effective(g.cleared, x, y)) {
					return nil, fail(409, "land-blocked")
				}
			}
		}
		for _, v := range content.HomeRules.GetOutdoorReserved() {
			if ext.overlaps(rect{int(v.GetX()), int(v.GetY()), int(v.GetW()), int(v.GetH())}) {
				return nil, fail(409, "placement-overlap")
			}
		}
		for _, p := range h.Plants {
			if ext.overlaps(rect{p.X, p.Y, 1, 1}) {
				return nil, fail(409, "placement-overlap")
			}
		}
		for _, v := range placedItems(h) {
			// Indoor and gate pieces stand on their own grids
			// (validatePlacement's scene rule): only outdoor ground is the
			// bay's business.
			if v.ID == stable.ID || v.Scene == nil || *v.Scene != "outdoor" {
				continue
			}
			if o, ok := placedRect(v); ok && ext.overlaps(o) {
				return nil, fail(409, "placement-overlap")
			}
		}
		if !rectLit(connectedLights(placedItems(h), stable.ID), ext) {
			return nil, fail(409, "unlit")
		}
		// The n-th extra bay's bill (the growth rule), before anything moves.
		bill := content.HomeStallCost(content.HomeRules, n)
		if err := checkMaterials(ctx, tx, s.AccountID, bill); err != nil {
			return nil, err
		}
		if err := debitMaterials(ctx, tx, s, bill, 1, "stable-extend", stable.ID, now); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE homestead_items SET stalls=? WHERE id=? AND homestead_id=?", next, stable.ID, h.ID); err != nil {
			return nil, err
		}
		home, err := myHome(ctx, tx, s.AccountID, now)
		if err != nil {
			return nil, err
		}
		m, err := materials(ctx, tx, s.AccountID)
		if err != nil {
			return nil, err
		}
		out := &contract.StableExtendResult{Materials: materialCountsProto(m)}
		if home != nil {
			out.Home = homeViewProto(*home)
		}
		return out, nil
	})
}
