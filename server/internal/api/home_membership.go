package api

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"slices"
)

func invite(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, req homeRequest, now int64) (string, error) {
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
	t := content.HomeRules.Lane.SilasTable
	return a.presence != nil && a.presence.near(world, id, "commons", float64(t.X), float64(t.Y), float64(t.Radius))
}

// joint is one partner's signature on a joint deed. Both partners must stand
// at Silas's table; the second signature, within the confirm window of the
// first, amends the deed.
func (a *Server) joint(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req homeRequest, now int64) (string, error) {
	var from, world string
	var expires int64
	var fromAt, toAt *int64
	err := tx.QueryRowContext(ctx, "SELECT i.from_id,i.expires_at,i.from_confirmed_at,i.to_confirmed_at,h.world_id FROM homestead_invites i JOIN homesteads h ON h.id=i.homestead_id WHERE i.homestead_id=? AND i.to_id=?", req.HomeID, req.To).Scan(&from, &expires, &fromAt, &toAt, &world)
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
	if !ok || fromHome != req.HomeID {
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
		_, err = tx.ExecContext(ctx, "UPDATE homestead_invites SET "+column+"=? WHERE homestead_id=? AND to_id=?", now, req.HomeID, req.To)
		return "waiting", err
	}
	if _, ok, err := memberOf(ctx, tx, req.To); err != nil {
		return "", err
	} else if ok {
		return "", fail(409, "already-homesteaded")
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_members VALUES(?,?,?)", req.To, req.HomeID, now); err != nil {
		return "", err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM homestead_invites WHERE homestead_id=? AND to_id=?", req.HomeID, req.To); err != nil {
		return "", err
	}
	if err = addDeed(ctx, tx, req.To); err != nil {
		return "", err
	}
	return "joined", store.Credit(ctx, tx, s, 0, 0, "homestead-joint", req.HomeID, nil, now)
}

// leave: the player takes their pack and personal chest (both are theirs
// already); placed pieces, posts and the shared chest stay. The last one out
// leaves the land vacant: desolate in a while, the deed lost after that.
func leave(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, now int64) error {
	if _, err := tx.ExecContext(ctx, "DELETE FROM homestead_members WHERE account_id=?", s.AccountID); err != nil {
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

// checkHomeRest: resting at home means standing on your own homestead's map
// (or in its cottage, which saves as the map).
func checkHomeRest(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) error {
	gate := rules.HomeGate(s.State.Area)
	if gate < 0 {
		return fail(409, "not-at-own-plot")
	}
	if err := settleHomes(ctx, tx, s.WorldID, now); err != nil {
		return err
	}
	var mine int
	err := tx.QueryRowContext(ctx, "SELECT h.gate FROM homestead_members m JOIN homesteads h ON h.id=m.homestead_id WHERE m.account_id=?", s.AccountID).Scan(&mine)
	if err == sql.ErrNoRows || (err == nil && mine != gate) {
		return fail(409, "not-at-own-plot")
	}
	return err
}
