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
// no play lease. The raw code is returned once and never persisted.
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
	var worldExists int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM worlds WHERE id=?", s.WorldID).Scan(&worldExists); err != nil {
		return err
	}
	if worldExists != 1 {
		return fail(403, "world-required")
	}
	var outstanding int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM invites WHERE created_by=? AND used_by IS NULL AND revoked_at IS NULL AND expires_at>?", s.HabiticaID, now).Scan(&outstanding); err != nil {
		return err
	}
	if outstanding >= rules.E.OutstandingInvites {
		return fail(409, "invite-limit")
	}
	code, err := store.Random()
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
	rows, err := tx.QueryContext(r.Context(), "SELECT code_hash,created_at,expires_at FROM invites WHERE created_by=? AND used_by IS NULL AND revoked_at IS NULL AND expires_at>? ORDER BY created_at,code_hash", s.HabiticaID, a.Config.Now().Unix())
	if err != nil {
		return err
	}
	entries := []InviteMetadata{}
	for rows.Next() {
		var m InviteMetadata
		if err = rows.Scan(&m.ID, &m.CreatedAt, &m.ExpiresAt); err != nil {
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
	return a.finish(w, r, tx, map[string]any{"invites": entries})
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
