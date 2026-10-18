//go:build dev

package api

import (
	"glimway/server/internal/store"
	"net/http"
	"strings"
)

// DevCaller is the Habitica user id behind a dev request, for a deployed dev
// server's gate (server/cmd/glimway-server/dev_routes.go): the signed-in,
// allowlisted session auth would accept, read without refreshing it. A write
// must come from this site as JSON, like every other write (ServeHTTP), so
// another site can't move the clock with a player's cookie. Dev builds only.
func (a *Server) DevCaller(r *http.Request) (string, bool) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		if !sameOrigin(r, false) || !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
			return "", false
		}
	}
	c, err := r.Cookie(CookieName)
	if err != nil || len(c.Value) != 64 {
		return "", false
	}
	now := a.Config.Now().Unix()
	var subject string
	err = a.Store.DB.QueryRowContext(r.Context(), "SELECT i.subject FROM sessions s JOIN sign_ins i ON i.account_id=s.account_id AND i.method='habitica' JOIN allowlist l ON l.habitica_id=i.subject WHERE s.id_hash=? AND s.expires_at>? AND s.created_at>?",
		store.Hash(c.Value), now, now-int64(SessionTTL.Seconds())).Scan(&subject)
	return subject, err == nil
}
