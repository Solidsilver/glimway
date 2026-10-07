package api

import (
	"context"
	"glimway/server/internal/store"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

type statusWriter struct {
	http.ResponseWriter
	status  int
	written bool
}

func (w *statusWriter) WriteHeader(status int) {
	if !w.written {
		w.status = status
		w.written = true
		w.ResponseWriter.WriteHeader(status)
	}
}
func (w *statusWriter) Write(b []byte) (int, error) {
	if !w.written {
		w.WriteHeader(200)
	}
	return w.ResponseWriter.Write(b)
}
func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

type loginBucket struct {
	start time.Time
	count int
}
type loginLimiter struct {
	mu        sync.Mutex
	buckets   map[string]loginBucket
	rate      int
	window    time.Duration
	lastSweep time.Time
}

func (l *loginLimiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastSweep) >= l.window {
		for k, b := range l.buckets {
			if now.Sub(b.start) >= l.window {
				delete(l.buckets, k)
			}
		}
		l.lastSweep = now
	}
	b, exists := l.buckets[ip]
	if !exists && len(l.buckets) >= 4096 {
		var oldestKey string
		var oldest time.Time
		for key, value := range l.buckets {
			if oldestKey == "" || value.start.Before(oldest) {
				oldestKey = key
				oldest = value.start
			}
		}
		delete(l.buckets, oldestKey)
	}
	if !exists || now.Sub(b.start) >= l.window {
		b = loginBucket{start: now}
	}
	if b.count >= l.rate {
		return false
	}
	b.count++
	l.buckets[ip] = b
	return true
}
func (a *Server) clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	remote := net.ParseIP(host)
	if remote == nil {
		return "unknown"
	}
	trusted := false
	for _, proxy := range a.Config.TrustedProxies {
		if p := net.ParseIP(proxy); p != nil && p.Equal(remote) {
			trusted = true
			break
		}
	}
	if trusted {
		hops := strings.Split(strings.Join(r.Header.Values("X-Forwarded-For"), ","), ",")
		if ip := net.ParseIP(strings.TrimSpace(hops[len(hops)-1])); ip != nil {
			return ipBucket(ip)
		}
	}
	return ipBucket(remote)
}

// IPv6 privacy-address rotation stays in one /64 rate bucket.
func ipBucket(ip net.IP) string {
	if v4 := ip.To4(); v4 != nil {
		return v4.String()
	}
	return ip.Mask(net.CIDRMask(64, 128)).String() + "/64"
}

// inviteUsable: an invite row (args: now) still admits someone: unused,
// unrevoked, unexpired, and not naming a party's world (those take no codes).
const inviteUsable = "used_by IS NULL AND revoked_at IS NULL AND expires_at>? AND NOT EXISTS(SELECT 1 FROM worlds pw WHERE pw.id=invites.world_id AND pw.owner_id='')"

// precheck turns away, before Habitica is asked, a sign-in that can't
// succeed, and says which way it could: "listed" (the allowlist, or a usable
// invite code) or "party" (only through the party the client says it is in:
// that party has an open world here, and the CLI hasn't removed the
// account). The verified party is checked against the claim afterwards.
func (a *Server) precheck(ctx context.Context, id, invite, party string) (string, error) {
	var route string
	err := a.Store.DB.QueryRowContext(ctx, `SELECT CASE
 WHEN EXISTS(SELECT 1 FROM allowlist WHERE habitica_id=?) OR EXISTS(SELECT 1 FROM invites WHERE (created_by='cli' OR NOT EXISTS(SELECT 1 FROM access_removals WHERE habitica_id=?)) AND code_hash=? AND `+inviteUsable+`) THEN 'listed'
 WHEN ? AND ?!='' AND EXISTS(SELECT 1 FROM worlds WHERE owner_id='' AND habitica_party_id=?) AND NOT EXISTS(SELECT 1 FROM party_closures WHERE party_id=?) AND NOT EXISTS(SELECT 1 FROM access_removals WHERE habitica_id=?) THEN 'party'
 ELSE '' END`, id, id, store.Hash(store.NormalizeInvite(invite)), a.Config.Now().Unix(), !a.Config.PartyAdmissionOff, party, party, party, id).Scan(&route)
	return route, err
}
