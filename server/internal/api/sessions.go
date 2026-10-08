package api

import (
	"context"
	"database/sql"
	"glimway/server/internal/store"
	"net/http"
	"time"
)

func (a *Server) cookie(w http.ResponseWriter, value string, expires time.Time) {
	maxAge := int(expires.Unix() - a.Config.Now().Unix())
	if value == "" {
		maxAge = -1
	}
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: value, Path: "/", HttpOnly: true, Secure: a.Config.SecureCookie, SameSite: http.SameSiteLaxMode, Expires: expires, MaxAge: maxAge})
}

// authenticate refreshes expiry in the same tx. On a failed mutation its
// refresh rolls back with the rest. Removing allowlist access revokes sessions.
func (a *Server) auth(ctx context.Context, tx *sql.Tx, r *http.Request) (string, string, error) {
	c, err := r.Cookie(CookieName)
	if err != nil || len(c.Value) != 64 {
		return "", "", fail(401, "unauthorized")
	}
	hash := store.Hash(c.Value)
	var id string
	now := a.Config.Now().Unix()
	err = tx.QueryRowContext(ctx, "SELECT s.account_id FROM sessions s JOIN sign_ins i ON i.account_id=s.account_id AND i.method='habitica' JOIN allowlist l ON l.habitica_id=i.subject WHERE s.id_hash=? AND s.expires_at>? AND s.created_at>?", hash, now, now-int64(SessionTTL.Seconds())).Scan(&id)
	if err == sql.ErrNoRows {
		// Signed in, but the world isn't chosen yet: everything waits for
		// POST /api/world/choose (world_choice.go).
		if _, err = pendingSession(ctx, tx, hash, now); err == nil {
			return "", "", fail(409, "world-choice-required")
		}
		if err != sql.ErrNoRows {
			return "", "", err
		}
		return "", "", fail(401, "unauthorized")
	}
	if err != nil {
		return "", "", err
	}
	_, err = tx.ExecContext(ctx, "UPDATE sessions SET expires_at=MIN(?,created_at+?) WHERE id_hash=?", now+int64(SessionIdleTTL.Seconds()), int64(SessionTTL.Seconds()), hash)
	return id, hash, err
}

// logout revokes this session and releases a play lease held through it, in
// one transaction, so signing straight back in on the same device does not
// meet its own old lease as "playing elsewhere". Lease clients are
// "<session hash>:<clientId>"; another session's lease is untouched. A lease
// release does not change rev.
func (a *Server) logout(w http.ResponseWriter, r *http.Request) error {
	var id string
	if c, err := r.Cookie(CookieName); err == nil {
		hash := store.Hash(c.Value)
		tx, err := a.Store.DB.BeginTx(r.Context(), nil)
		if err != nil {
			return err
		}
		defer tx.Rollback()
		err = tx.QueryRowContext(r.Context(), "SELECT account_id FROM sessions WHERE id_hash=?", hash).Scan(&id)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		for _, table := range []string{"sessions", "pending_sessions"} {
			if _, err = tx.ExecContext(r.Context(), "DELETE FROM "+table+" WHERE id_hash=?", hash); err != nil {
				return err
			}
		}
		prefix := hash + ":"
		if _, err = tx.ExecContext(r.Context(), "UPDATE players SET lease_id=NULL,lease_client=NULL,lease_seen_at=NULL WHERE lease_client IS NOT NULL AND substr(lease_client,1,?)=?", len(prefix), prefix); err != nil {
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
	}
	if id != "" {
		a.presenceChanged(id)
	}
	a.cookie(w, "", time.Unix(1, 0))
	write(w, 200, map[string]bool{"ok": true})
	return nil
}
