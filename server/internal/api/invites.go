package api

import (
	"database/sql"
	"encoding/hex"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
	"net/http"
	"strings"
)

const InviteTTL = 30 * 86400

type InviteMetadata struct {
	ID        string `json:"id"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
	Used      bool   `json:"used"`
}

// Player invites require authentication and persistent world membership, but
// no play lease. The raw code is returned once and never persisted. A party's
// world is for that party only: its residents invite no one (from a world of
// their own, they can). An account let in through a party invites no one
// anywhere: its invitee would count as let in by the operator and could open
// their own party's world, so party admission would chain.
func (a *Server) createInvite(w http.ResponseWriter, r *http.Request) error {
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
	var owner sql.NullString
	if err = tx.QueryRowContext(ctx, "SELECT owner_id FROM worlds WHERE id=?", s.WorldID).Scan(&owner); err != nil && err != sql.ErrNoRows {
		return err
	}
	if !owner.Valid {
		return fail(403, "world-required")
	}
	if owner.String == "" {
		return fail(409, "party-world-invites")
	}
	if admitted, err := partyAdmitted(ctx, tx, s.HabiticaID); err != nil {
		return err
	} else if admitted {
		return fail(403, "party-admitted-invites")
	}
	if s.Flagged {
		return fail(403, "player-flagged")
	}
	var lifetime int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM invites WHERE created_by=?", s.HabiticaID).Scan(&lifetime); err != nil {
		return err
	}
	if lifetime >= rules.E.LifetimeInvites {
		return fail(409, "invite-budget")
	}
	var outstanding int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM invites WHERE created_by=? AND used_by IS NULL AND revoked_at IS NULL AND expires_at>?", s.HabiticaID, now).Scan(&outstanding); err != nil {
		return err
	}
	if outstanding >= rules.E.OutstandingInvites {
		return fail(409, "invite-limit")
	}
	code, err := store.InviteCode()
	if err != nil {
		return err
	}
	meta := InviteMetadata{ID: store.Hash(code), CreatedAt: now, ExpiresAt: now + InviteTTL}
	if _, err = tx.ExecContext(ctx, "INSERT INTO invites(code_hash,created_by,world_id,created_at,expires_at) VALUES(?,?,?,?,?)", meta.ID, s.HabiticaID, s.WorldID, now, meta.ExpiresAt); err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		InviteMetadata
		Code string `json:"code"`
	}{meta, code})
}
func (a *Server) listInvites(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	rows, err := tx.QueryContext(r.Context(), "SELECT code_hash,created_at,expires_at,used_by IS NOT NULL FROM invites WHERE created_by=? AND (used_by IS NOT NULL OR (revoked_at IS NULL AND expires_at>?)) ORDER BY created_at,code_hash", s.HabiticaID, a.Config.Now().Unix())
	if err != nil {
		return err
	}
	entries := []InviteMetadata{}
	for rows.Next() {
		var m InviteMetadata
		if err = rows.Scan(&m.ID, &m.CreatedAt, &m.ExpiresAt, &m.Used); err != nil {
			rows.Close()
			return err
		}
		entries = append(entries, m)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	var lifetime int
	if err = tx.QueryRowContext(r.Context(), "SELECT count(*) FROM invites WHERE created_by=?", s.HabiticaID).Scan(&lifetime); err != nil {
		return err
	}
	var partyWorld bool
	if err = tx.QueryRowContext(r.Context(), "SELECT EXISTS(SELECT 1 FROM worlds WHERE id=? AND owner_id='')", s.WorldID).Scan(&partyWorld); err != nil {
		return err
	}
	admitted, err := partyAdmitted(r.Context(), tx, s.HabiticaID)
	if err != nil {
		return err
	}
	// partyWorld: they live in a party's world, which takes no codes.
	// partyAdmitted: they came in through a party and make no codes anywhere.
	return a.finish(w, r, tx, map[string]any{"invites": entries, "remaining": max(0, rules.E.LifetimeInvites-lifetime), "outstandingLimit": rules.E.OutstandingInvites, "partyWorld": partyWorld, "partyAdmitted": admitted})
}
func (a *Server) revokeInvite(w http.ResponseWriter, r *http.Request) error {
	id := strings.TrimPrefix(r.URL.Path, "/api/invites/")
	if decoded, err := hex.DecodeString(id); err != nil || len(decoded) != 32 {
		return fail(404, "invite-not-found")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	var used, revoked sql.NullString
	err = tx.QueryRowContext(ctx, "SELECT used_by,CAST(revoked_at AS TEXT) FROM invites WHERE code_hash=? AND created_by=?", id, s.HabiticaID).Scan(&used, &revoked)
	if err == sql.ErrNoRows {
		return fail(404, "invite-not-found")
	}
	if err != nil {
		return err
	}
	if used.Valid {
		return fail(409, "invite-used")
	}
	if !revoked.Valid {
		if _, err = tx.ExecContext(ctx, "UPDATE invites SET revoked_at=? WHERE code_hash=? AND used_by IS NULL", a.Config.Now().Unix(), id); err != nil {
			return err
		}
	}
	return a.finish(w, r, tx, map[string]bool{"ok": true})
}
