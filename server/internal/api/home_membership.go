package api

import (
	"context"
	"database/sql"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"slices"
	"strings"
)

func invite(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, req *contract.HomesteadRequest, now int64) (string, error) {
	if req.To == "" || len(req.To) > 128 {
		return "", fail(404, "not-found")
	}
	if req.To == s.AccountID {
		return "", fail(400, "self-invite")
	}
	var world string
	err := tx.QueryRowContext(ctx, "SELECT world_id FROM players WHERE account_id=?", req.To).Scan(&world)
	if err == sql.ErrNoRows {
		return "", fail(404, "not-found")
	}
	if err != nil {
		return "", err
	}
	if world != s.WorldID {
		return "", fail(403, "world-access-denied")
	}
	if slices.ContainsFunc(h.Members, func(m homeMember) bool { return m.ID == req.To }) {
		return "", fail(409, "already-member")
	}
	expires := now + int64(content.HomeRules.JointDeed.InviteHours)*3600
	_, err = tx.ExecContext(ctx, `INSERT INTO homestead_invites(homestead_id,to_id,from_id,created_at,expires_at) VALUES(?,?,?,?,?)
ON CONFLICT(homestead_id,to_id) DO UPDATE SET from_id=excluded.from_id,created_at=excluded.created_at,expires_at=excluded.expires_at,from_confirmed_at=NULL,to_confirmed_at=NULL`, h.ID, req.To, s.AccountID, now, expires)
	return "invited", err
}

// atTable: connected to presence in this world, in the Commons, by Silas's table.
func (a *Server) atTable(world, id string) bool {
	t := content.HomeRules.GetCommons().GetSilasTable()
	return a.presence != nil && a.presence.near(world, id, "commons", float64(t.GetX()), float64(t.GetY()), float64(t.GetRadius()))
}

// joint is one partner's signature on a joint deed. Both partners must stand
// at Silas's table; the second signature, within the confirm window of the
// first, amends the deed.
func (a *Server) joint(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.HomesteadRequest, now int64) (string, error) {
	var from, world string
	var expires int64
	var fromAt, toAt *int64
	err := tx.QueryRowContext(ctx, "SELECT i.from_id,i.expires_at,i.from_confirmed_at,i.to_confirmed_at,h.world_id FROM homestead_invites i JOIN homesteads h ON h.id=i.homestead_id WHERE i.homestead_id=? AND i.to_id=?", req.HomeId, req.To).Scan(&from, &expires, &fromAt, &toAt, &world)
	if err == sql.ErrNoRows || (err == nil && (expires <= now || world != s.WorldID)) {
		return "", fail(404, "invite-not-found")
	}
	if err != nil {
		return "", err
	}
	other, column, otherAt := from, "to_confirmed_at", fromAt
	switch s.AccountID {
	case req.To:
	case from:
		other, column, otherAt = req.To, "from_confirmed_at", toAt
	default:
		return "", fail(404, "invite-not-found")
	}
	// The inviter must still be on the deed.
	fromHome, ok, err := memberOf(ctx, tx, from)
	if err != nil {
		return "", err
	}
	if !ok || fromHome != req.HomeId {
		return "", fail(404, "invite-not-found")
	}
	if !a.atTable(s.WorldID, s.AccountID) {
		return "", fail(409, "not-at-table")
	}
	if !a.atTable(s.WorldID, other) {
		return "", fail(409, "partner-not-at-table")
	}
	window := int64(content.HomeRules.JointDeed.ConfirmWindowSeconds)
	if otherAt == nil || now-*otherAt > window {
		_, err = tx.ExecContext(ctx, "UPDATE homestead_invites SET "+column+"=? WHERE homestead_id=? AND to_id=?", now, req.HomeId, req.To)
		return "waiting", err
	}
	if _, ok, err := memberOf(ctx, tx, req.To); err != nil {
		return "", err
	} else if ok {
		return "", fail(409, "already-homesteaded")
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_members VALUES(?,?,?)", req.To, req.HomeId, now); err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM homestead_invites WHERE homestead_id=? AND to_id=?", req.HomeId, req.To); err != nil {
		return "", err
	}
	if err = addDeed(ctx, tx, req.To); err != nil {
		return "", err
	}
	return "joined", store.Credit(ctx, tx, s, 0, 0, "homestead-joint", req.HomeId, nil, now)
}

// leave: the player takes their pack and personal chest (both are theirs
// already); placed pieces, posts and the shared chest stay. The last one out
// leaves the land vacant: desolate in a while, the deed lost after that.
func leave(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, now int64) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM homestead_members WHERE account_id=?", s.AccountID); err != nil {
		return err
	}
	// Their mounts come out of the stable's stalls with them: nobody can move
	// a partner's mount, so a leaver's stalls would stand occupied for good
	// (docs/design/crafts.md 3.1, lane B's rule). Emptying a stall refunds
	// nothing.
	if _, err := tx.ExecContext(ctx, "DELETE FROM homestead_stalls WHERE homestead_id=? AND owner_id=?", h.ID, s.AccountID); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO homestead_departures VALUES(?,?,?) ON CONFLICT(homestead_id,account_id) DO UPDATE SET left_at=excluded.left_at", h.ID, s.AccountID, now); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM homestead_invites WHERE homestead_id=? AND from_id=?", h.ID, s.AccountID); err != nil {
		return err
	}
	if len(h.Members) <= 1 {
		if _, err := tx.ExecContext(ctx, "UPDATE homesteads SET vacant_since=? WHERE id=?", now, h.ID); err != nil {
			return err
		}
		if _, err := tx.ExecContext(ctx, "DELETE FROM homestead_invites WHERE homestead_id=?", h.ID); err != nil {
			return err
		}
	}
	return store.Credit(ctx, tx, s, 0, 0, "homestead-leave", h.ID, nil, now)
}

// checkHomeRest requires the cottage on a gate named by your deed, or, before
// there is a cottage (tier 0), the bedroll on that land.
func checkHomeRest(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) error {
	gate := rules.HomeGate(content.RootArea(s.State.Area))
	inside := strings.HasPrefix(s.State.Area, "in:home:")
	if gate < 0 {
		return fail(409, "not-at-own-plot")
	}
	if err := settleHomes(ctx, tx, s.WorldID, now); err != nil {
		return err
	}
	var mine, tier int
	err := tx.QueryRowContext(ctx, "SELECT h.gate, h.tier FROM homestead_members m JOIN homesteads h ON h.id=m.homestead_id WHERE m.account_id=?", s.AccountID).Scan(&mine, &tier)
	if err == sql.ErrNoRows || (err == nil && (mine != gate || !inside && tier > 0)) {
		return fail(409, "not-at-own-plot")
	}
	return err
}
