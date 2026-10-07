// Package api implements the HTTP and presence contracts. All gameplay commits,
// authorization checks, ledger entries and idempotency responses share one tx.
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"glimway/content"
	"glimway/server/internal/habitica"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"io"
	"log"
	"math"
	"net/http"
	"net/url"
	"slices"
	"strconv"
	"strings"
	"time"
)

const CookieName = "glimway_session"
const SessionTTL = 30 * 24 * time.Hour
const SessionIdleTTL = 7 * 24 * time.Hour

type Config struct {
	SecureCookie     bool
	Logger           *log.Logger
	Now              func() time.Time
	TrustedProxies   []string
	LoginConcurrency int
	LoginRate        int
	LoginGlobalRate  int
	LoginWindow      time.Duration
	// Zero uses the shared content default; stored epochs always retain their version.
	WildsGeneratorVersion int
	// Nil uses the shared presence defaults. Intended for embedded-server configuration.
	Presence *content.Presence
	// PartyAdmissionOff: no one signs in through a party, and no party's
	// world is made (-party-admission=false). Party worlds already made stay.
	PartyAdmissionOff bool
	// LoginPartyRate: upstream calls a minute for sign-ins that only a party
	// could admit, a bucket apart from LoginGlobalRate (zero: a quarter of it).
	LoginPartyRate int
	// Habitica outfit art (sprites.go): where fetched sprites are kept on
	// disk (empty: a folder in the system temp dir) and the sprite host
	// (empty: DefaultSpriteBaseURL; the playtests point it at a fake).
	SpriteCacheDir string
	SpriteBaseURL  string
}
type Server struct {
	Store       *store.Store
	Habitica    *habitica.Client
	Config      Config
	loginSlots  chan struct{}
	loginLimit  *loginLimiter
	loginGlobal *loginLimiter
	loginParty  *loginLimiter
	loginProofs *proofLimiter
	presence    *presenceHub
	sprites     *spriteProxy
}

func New(s *store.Store, h *habitica.Client, c Config) *Server {
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Logger == nil {
		c.Logger = log.New(io.Discard, "", 0)
	}
	return newServer(s, h, c)
}

func newServer(s *store.Store, h *habitica.Client, c Config) *Server {
	if c.LoginConcurrency <= 0 {
		c.LoginConcurrency = 4
	}
	if c.LoginRate <= 0 {
		c.LoginRate = 10
	}
	if c.LoginGlobalRate <= 0 {
		c.LoginGlobalRate = 60
	}
	if c.LoginWindow <= 0 {
		c.LoginWindow = time.Minute
	}
	if c.LoginPartyRate <= 0 {
		c.LoginPartyRate = max(1, c.LoginGlobalRate/4)
	}
	return &Server{sprites: newSpriteProxy(c.SpriteCacheDir, c.SpriteBaseURL, c.Now), presence: newPresenceHub(c.Presence), loginProofs: &proofLimiter{buckets: map[string]*proofBucket{}}, loginGlobal: &loginLimiter{buckets: map[string]loginBucket{}, rate: c.LoginGlobalRate, window: time.Minute}, loginParty: &loginLimiter{buckets: map[string]loginBucket{}, rate: c.LoginPartyRate, window: time.Minute}, Store: s, Habitica: h, Config: c, loginSlots: make(chan struct{}, c.LoginConcurrency), loginLimit: &loginLimiter{buckets: map[string]loginBucket{}, rate: c.LoginRate, window: c.LoginWindow}}
}

type failure struct {
	status int
	code   string
}

func (e *failure) Error() string         { return e.code }
func fail(status int, code string) error { return &failure{status, code} }
func problem(w http.ResponseWriter, err error) {
	var f *failure
	if !errors.As(err, &f) {
		f = &failure{500, "internal"}
	}
	write(w, f.status, map[string]any{"error": map[string]string{"code": f.code}})
}
func write(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
func decode(w http.ResponseWriter, r *http.Request, v any) error {
	r.Body = http.MaxBytesReader(w, r.Body, 200000)
	d := json.NewDecoder(r.Body)
	if err := d.Decode(v); err != nil {
		return fail(400, "invalid-json")
	}
	if err := d.Decode(&struct{}{}); err != io.EOF {
		return fail(400, "invalid-json")
	}
	return nil
}
func (a *Server) cookie(w http.ResponseWriter, value string, expires time.Time) {
	maxAge := int(expires.Unix() - a.Config.Now().Unix())
	if value == "" {
		maxAge = -1
	}
	http.SetCookie(w, &http.Cookie{Name: CookieName, Value: value, Path: "/", HttpOnly: true, Secure: a.Config.SecureCookie, SameSite: http.SameSiteLaxMode, Expires: expires, MaxAge: maxAge})
}
func (a *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	// Log fixed route labels only. No bodies, headers, raw paths or query strings.
	route := "unknown"
	if slices.Contains([]string{"/api/health", "/ws", "/api/session", "/api/origin", "/api/play", "/api/state", "/api/progress", "/api/sync", "/api/spend", "/api/invites", "/api/commons", "/api/calendar", "/api/storage", "/api/craft", "/api/hearth/craft", "/api/desk/copy", "/api/homestead/woodpile", "/api/mail", "/api/projects", "/api/library", "/api/library/donate", "/api/items", "/api/world", "/api/world/party", "/api/world/prompt", "/api/world/move", "/api/world/leave", "/api/world/notice", "/api/world/choice", "/api/world/choose"}, r.URL.Path) {
		route = r.URL.Path
	}
	observed := &statusWriter{ResponseWriter: w, status: 200}
	w = observed
	if strings.HasPrefix(r.URL.Path, "/api/invites/") {
		route = "/api/invites/:id"
	}
	if strings.HasPrefix(r.URL.Path, "/api/homestead/") {
		route = "/api/homestead/:action"
	}
	if strings.HasPrefix(r.URL.Path, "/api/mail/") {
		route = "/api/mail/:id/claim"
	}
	if strings.HasPrefix(r.URL.Path, "/api/projects/") {
		route = "/api/projects/:id/contribute"
	}
	if strings.HasPrefix(r.URL.Path, "/api/wilds/") {
		route = "/api/wilds/:action"
	}
	if strings.HasPrefix(r.URL.Path, "/api/items/") {
		route = "/api/items/:action"
	}
	if strings.HasPrefix(r.URL.Path, "/api/repairs/") {
		route = "/api/repairs/:id/mend"
	}
	if strings.HasPrefix(r.URL.Path, "/api/sprites/") {
		route = "/api/sprites/:name"
	}
	defer func() {
		class := "none"
		if observed.status == 502 {
			class = "upstream"
		} else if observed.status >= 500 {
			class = "internal"
		}
		a.Config.Logger.Printf("request method=%s route=%s status=%d error_class=%s", safeMethod(r.Method), route, observed.status, class)
	}()
	if r.Method != "GET" && r.Method != "HEAD" {
		if !sameOrigin(r, false) {
			problem(w, fail(403, "cross-origin"))
			return
		}
		if r.Method != "DELETE" && !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
			problem(w, fail(415, "json-required"))
			return
		}
	}
	var err error
	switch r.Method + " " + r.URL.Path {
	case "GET /api/health", "HEAD /api/health":
		ctx, cancel := context.WithTimeout(r.Context(), time.Second)
		defer cancel()
		if a.Store.DB.PingContext(ctx) != nil {
			err = fail(503, "internal")
		} else if r.Method == "HEAD" {
			w.WriteHeader(http.StatusOK)
		} else {
			write(w, 200, map[string]string{"status": "ok"})
		}
	case "GET /ws":
		err = a.presenceSocket(w, r)
	case "POST /api/invites":
		err = a.createInvite(w, r)
	case "GET /api/invites":
		err = a.listInvites(w, r)
	case "GET /api/world":
		err = a.worldRead(w, r)
	case "POST /api/world/party":
		err = a.worldParty(w, r)
	case "POST /api/world/prompt":
		err = a.worldPrompt(w, r)
	case "POST /api/world/move":
		err = a.worldMove(w, r)
	case "POST /api/world/leave":
		err = a.worldLeave(w, r)
	case "POST /api/world/notice":
		err = a.worldNotice(w, r)
	case "GET /api/world/choice":
		err = a.worldChoiceRead(w, r)
	case "POST /api/world/choose":
		err = a.worldChoose(w, r)
	case "POST /api/session":
		err = a.login(w, r)
	case "DELETE /api/session":
		err = a.logout(w, r)
	case "GET /api/state":
		err = a.state(w, r)
	case "POST /api/play":
		err = a.play(w, r)
	case "POST /api/origin":
		err = a.origin(w, r)
	case "PUT /api/progress":
		err = a.progress(w, r)
	case "POST /api/sync":
		err = a.sync(w, r)
	case "GET /api/commons":
		err = a.commons(w, r)
	case "GET /api/calendar":
		write(w, 200, content.CalendarAt(content.CalendarRules, a.Config.Now().Unix()))
	case "GET /api/storage":
		err = a.storageRead(w, r)
	case "POST /api/storage":
		err = a.storageMutation(w, r)
	case "POST /api/craft":
		err = a.craft(w, r)
	case "POST /api/hearth/craft":
		err = a.hearthCraft(w, r)
	case "POST /api/desk/copy":
		err = a.deskCopy(w, r)
	case "GET /api/homestead/woodpile":
		err = a.woodpileRead(w, r)
	case "POST /api/homestead/woodpile":
		err = a.woodpileMutation(w, r)
	case "GET /api/homestead/shelf":
		err = a.shelfRead(w, r)
	case "POST /api/homestead/shelf":
		err = a.shelfMutation(w, r)
	case "GET /api/mail":
		err = a.mailRead(w, r)
	case "POST /api/mail":
		err = a.mailSend(w, r)
	case "GET /api/projects":
		err = a.projectsRead(w, r)
	case "GET /api/library":
		err = a.libraryRead(w, r)
	case "POST /api/library/donate":
		err = a.libraryDonate(w, r)
	case "POST /api/wilds/claim", "POST /api/wilds/lantern", "POST /api/wilds/defeat":
		err = a.wildsMutation(w, r)
	case "POST /api/homestead/buy", "POST /api/homestead/place", "POST /api/homestead/remove", "POST /api/homestead/move", "POST /api/homestead/upgrade",
		"POST /api/homestead/claim", "POST /api/homestead/clear", "POST /api/homestead/invite", "POST /api/homestead/joint", "POST /api/homestead/leave":
		err = a.homeMutation(w, r)
	case "POST /api/spend":
		err = a.spend(w, r)
	case "GET /api/items":
		err = a.itemsRead(w, r)
	case "POST /api/items/use", "POST /api/items/repair", "POST /api/items/fit", "POST /api/items/unfit", "POST /api/items/give",
		"POST /api/items/pocket", "POST /api/items/offhand", "POST /api/items/pickup", "POST /api/items/return",
		"POST /api/items/heirloom", "POST /api/items/ada-oil", "POST /api/items/gather", "POST /api/items/plant",
		"POST /api/items/buy":
		err = a.itemsMutation(w, r)
	case "GET /api/repairs":
		err = a.repairsRead(w, r)
	default:
		if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/mail/") {
			if strings.HasSuffix(r.URL.Path, "/recall") {
				err = a.mailRecall(w, r)
			} else {
				err = a.mailClaim(w, r)
			}
		} else if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/projects/") {
			err = a.projectContribute(w, r)
		} else if r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/repairs/") && strings.HasSuffix(r.URL.Path, "/mend") {
			err = a.repairMend(w, r)
		} else if r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/api/invites/") {
			err = a.revokeInvite(w, r)
		} else if r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/api/homestead/") {
			err = a.homeRead(w, r)
		} else if r.Method == "GET" && strings.HasPrefix(r.URL.Path, "/api/wilds/region/") {
			err = a.regionRead(w, r)
		} else if (r.Method == "GET" || r.Method == "HEAD") && strings.HasPrefix(r.URL.Path, "/api/sprites/") {
			err = a.sprite(w, r)
		} else {
			err = fail(404, "not-found")
		}
	}
	if err != nil {
		problem(w, err)
	}
}
func safeMethod(m string) string {
	if slices.Contains([]string{"GET", "POST", "PUT", "DELETE", "HEAD", "OPTIONS", "PATCH"}, m) {
		return m
	}
	return "other"
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
	err = tx.QueryRowContext(ctx, "SELECT s.habitica_id FROM sessions s JOIN allowlist l USING(habitica_id) WHERE s.id_hash=? AND s.expires_at>? AND s.created_at>?", hash, now, now-int64(SessionTTL.Seconds())).Scan(&id)
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
func (a *Server) begin(r *http.Request) (*sql.Tx, store.Snapshot, string, error) {
	tx, err := a.Store.DB.BeginTx(r.Context(), nil)
	if err != nil {
		return nil, store.Snapshot{}, "", err
	}
	id, hash, err := a.auth(r.Context(), tx, r)
	if err != nil {
		tx.Rollback()
		return nil, store.Snapshot{}, "", err
	}
	if _, err = store.ReturnDueMailTx(r.Context(), tx, a.Config.Now().Unix(), id); err != nil {
		tx.Rollback()
		return nil, store.Snapshot{}, "", err
	}
	s, err := store.Load(r.Context(), tx, id)
	if err != nil {
		tx.Rollback()
		return nil, s, "", err
	}
	return tx, s, hash, nil
}
func (a *Server) finish(w http.ResponseWriter, r *http.Request, tx *sql.Tx, v any, afterCommit ...func()) error {
	var cookie *http.Cookie
	var expiry int64
	if c, err := r.Cookie(CookieName); err == nil {
		cookie = c
		if err = tx.QueryRowContext(r.Context(), "SELECT expires_at FROM sessions WHERE id_hash=?", store.Hash(c.Value)).Scan(&expiry); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, notify := range afterCommit {
		notify()
	}
	if cookie != nil {
		a.cookie(w, cookie.Value, time.Unix(expiry, 0))
	}
	write(w, 200, v)
	return nil
}
func (a *Server) login(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		UserID string `json:"userId"`
		Token  string `json:"token"`
		Invite string `json:"invite"`
		// Party: the party the client expects Habitica to report (from the
		// profile it read itself). Only lets a party-only sign-in past the
		// precheck; the verified party must match it.
		Party string `json:"party"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	if req.UserID == "" || len(req.UserID) > 128 || req.Token == "" || len(req.Token) > 512 || len(req.Invite) > 512 || len(req.Party) > 128 {
		return fail(400, "invalid-credentials")
	}
	req.Invite = store.NormalizeInvite(req.Invite)
	if len(req.Invite) > 128 {
		return fail(400, "invalid-credentials")
	}
	route, err := a.precheck(r.Context(), req.UserID, req.Invite, req.Party)
	if err != nil {
		return err
	}
	if route == "" {
		return fail(403, "access-denied")
	}
	// Sign-ins only a party could admit spend their own, smaller share of
	// the Habitica budget, never the one allowlisted and invited players use.
	budget := a.loginGlobal
	if route == "party" {
		budget = a.loginParty
	}
	if !a.loginLimit.allow(a.clientIP(r), a.Config.Now()) {
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(a.Config.LoginWindow.Seconds()))))
		return fail(429, "login-rate-limited")
	}
	finishProof, retry, ok := a.loginProofs.begin(req.UserID, a.Config.Now())
	if !ok {
		w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(retry.Seconds()))))
		return fail(429, "login-user-rate-limited")
	}
	failedProof := false
	defer func() { finishProof(failedProof) }()
	select {
	case a.loginSlots <- struct{}{}:
		defer func() { <-a.loginSlots }()
	default:
		w.Header().Set("Retry-After", "1")
		return fail(429, "login-busy")
	}
	p, err := a.Habitica.VerifyLimited(r.Context(), req.UserID, req.Token, func() bool { return budget.allow("global", a.Config.Now()) })
	req.Token = ""
	if err != nil {
		var h *habitica.Error
		if errors.As(err, &h) {
			failedProof = h.Code == "habitica-auth"
			if h.Status == 429 {
				w.Header().Set("Retry-After", strconv.Itoa(int(math.Ceil(h.RetryAfter.Seconds()))))
			}
			return fail(h.Status, h.Code)
		}
		return fail(502, "habitica-unavailable")
	}
	ctx := r.Context()
	tx, err := a.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := a.Config.Now().Unix()
	var allowed int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM allowlist WHERE habitica_id=?", p.ID).Scan(&allowed); err != nil {
		return err
	}
	var existing int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM players WHERE habitica_id=?", p.ID).Scan(&existing); err != nil {
		return err
	}
	// A party with an open world here counts as an invite: a verified member
	// may sign in with no code and no allowlist entry (and is allowlisted from
	// then on, added_by 'party'), unless the CLI removed them. The party comes
	// only from the identity check above, and must be the one the client said.
	admits, err := a.partyAdmits(ctx, tx, p.PartyID)
	if err != nil {
		return err
	}
	// A named invite decides a new player's world. An unnamed invite admits
	// them to the world-choice flow below, or a solo world if no choice is
	// offered. An allowlisted newcomer's valid code still counts. A code
	// naming a party's world admits no one.
	world := ""
	via := "invite"
	if allowed == 0 || existing == 0 && req.Invite != "" {
		var named sql.NullString
		err = tx.QueryRowContext(ctx, "SELECT world_id FROM invites WHERE (created_by='cli' OR NOT EXISTS(SELECT 1 FROM access_removals WHERE habitica_id=?)) AND code_hash=? AND "+inviteUsable, p.ID, store.Hash(req.Invite), now).Scan(&named)
		if err == sql.ErrNoRows && allowed == 0 {
			var removed int
			if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM access_removals WHERE habitica_id=?", p.ID).Scan(&removed); err != nil {
				return err
			}
			if admits == "" || removed > 0 || req.Party != *p.PartyID {
				return fail(403, "access-denied")
			}
			via = "party"
		} else if err != nil && err != sql.ErrNoRows {
			return err
		} else if err == nil {
			if named.Valid {
				world = named.String
			}
			res, err := tx.ExecContext(ctx, "UPDATE invites SET used_by=?,used_at=? WHERE code_hash=? AND "+inviteUsable, p.ID, now, store.Hash(req.Invite), now)
			if err != nil {
				return err
			}
			n, err := res.RowsAffected()
			if err != nil {
				return err
			}
			if n != 1 {
				return fail(403, "access-denied")
			}
		}
		if allowed == 0 {
			if _, err = tx.ExecContext(ctx, "INSERT INTO allowlist VALUES(?,?,?)", p.ID, via, now); err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, "DELETE FROM access_removals WHERE habitica_id=?", p.ID); err != nil {
				return err
			}
		}
	}
	// A newcomer whose party has a world here, or who may open one, is asked
	// where to live (POST /api/world/choose), unless a code named a world.
	// The sign-in is held until then: the session, but no player yet.
	var offer *worldChoiceView
	if existing == 0 && world == "" {
		v, err := a.loadWorldChoice(ctx, tx, p.ID, p.Name, p.PartyID)
		if err != nil {
			return err
		}
		if v.PartyWorld != nil || v.PartyCanOpen {
			offer = &v
		}
	}
	// The first operator-admitted member of a party to sign in makes the
	// party's world; one let in through a party never makes another. A
	// newcomer still choosing makes it only by choosing it.
	if offer == nil {
		why, err := a.mayOpenParty(ctx, tx, p.ID, p.PartyID)
		if err != nil {
			return err
		}
		if why == "" {
			if _, err = ensurePartyWorld(ctx, tx, p.PartyID, p.ID, now); err != nil {
				return err
			}
		}
	}
	verified := rules.LifetimeXP(p.Level, *p.Exp)
	movedOut := false
	if existing == 0 && offer == nil {
		if world == "" {
			own, err := ownWorld(ctx, tx, p.ID, now)
			if err != nil {
				return err
			}
			world = own.ID
		}
		if err = createPlayer(ctx, tx, p, world, now, now); err != nil {
			return err
		}
	} else if existing != 0 {
		s, err := store.Load(ctx, tx, p.ID)
		if err != nil {
			return err
		}
		if err = checkpoint(ctx, tx, &s, p, now); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE players SET display_name=?,last_seen_at=?,habitica_party_id=? WHERE habitica_id=?", p.Name, now, p.PartyID, p.ID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE sync_baselines SET verified_xp=?,checkpoint_json=?,checkpoint_at=?,verified_high_level=MAX(verified_high_level,?),checkpoint_ledger_id=COALESCE((SELECT MAX(id) FROM ledger WHERE habitica_id=?),0) WHERE habitica_id=?", verified, store.JSON(p), now, p.Level, p.ID, p.ID); err != nil {
			return err
		}
		// Left the party whose world they live in: warned now, moved out
		// once the grace period has passed.
		if movedOut, err = partyResidence(ctx, tx, &s, p.PartyID, now); err != nil {
			return err
		}
	}
	session, err := store.Random()
	if err != nil {
		return err
	}
	expires := time.Unix(now, 0).Add(SessionIdleTTL)
	for _, table := range []string{"sessions", "pending_sessions"} {
		if _, err = tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE expires_at<=? OR created_at<=?", now, now-int64(SessionTTL.Seconds())); err != nil {
			return err
		}
	}
	if offer != nil {
		if _, err = tx.ExecContext(ctx, "INSERT INTO pending_sessions VALUES(?,?,?,?,?,?,?,?)", store.Hash(session), p.ID, p.Name, p.PartyID, now, expires.Unix(), store.JSON(p), verified); err != nil {
			return err
		}
		if err = tx.Commit(); err != nil {
			return err
		}
		a.cookie(w, session, expires)
		write(w, 200, worldChoiceAnswer{*offer})
		return nil
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO sessions VALUES(?,?,?,?,?,?)", store.Hash(session), p.ID, now, expires.Unix(), store.JSON(p), verified); err != nil {
		return err
	}
	s, err := store.Load(ctx, tx, p.ID)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	if movedOut {
		a.presenceChanged(p.ID)
	}
	a.cookie(w, session, expires)
	write(w, 200, s)
	return nil
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
		err = tx.QueryRowContext(r.Context(), "SELECT habitica_id FROM sessions WHERE id_hash=?", hash).Scan(&id)
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
func (a *Server) state(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	l := r.Header.Get("X-Play-Lease")
	active := l != "" && s.LeaseID.Valid && l == s.LeaseID.String
	if active {
		if _, err = tx.ExecContext(r.Context(), "UPDATE players SET lease_seen_at=? WHERE habitica_id=?", a.Config.Now().Unix(), s.HabiticaID); err != nil {
			return err
		}
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		LeaseActive bool `json:"leaseActive"`
	}{s, active})
}
func (a *Server) play(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		ClientID string `json:"clientId"`
		TakeOver bool   `json:"takeOver"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	if req.ClientID == "" || len(req.ClientID) > 128 {
		return fail(400, "invalid-client")
	}
	tx, s, hash, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	client := hash + ":" + req.ClientID
	now := a.Config.Now().Unix()
	lease := s.LeaseID.String
	if s.LeaseID.Valid && s.LeaseClient.String != client && now-s.LeaseSeen.Int64 < 120 && !req.TakeOver {
		return fail(409, "playing-elsewhere")
	}
	if !s.LeaseID.Valid || s.LeaseClient.String != client {
		lease, err = store.Random()
		if err != nil {
			return err
		}
	}
	if _, err = tx.ExecContext(r.Context(), "UPDATE players SET lease_id=?,lease_client=?,lease_seen_at=? WHERE habitica_id=?", lease, client, now, s.HabiticaID); err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Lease string `json:"lease"`
	}{s, lease}, func() { a.presenceChanged(s.HabiticaID) })
}

type Mutation struct {
	Lease   string `json:"lease"`
	BaseRev *int64 `json:"baseRev"`
}

func (a *Server) lease(ctx context.Context, tx *sql.Tx, s store.Snapshot, m Mutation) error {
	if !s.LeaseID.Valid || m.Lease == "" || m.Lease != s.LeaseID.String {
		return fail(409, "superseded")
	}
	if s.SaveOrigin == nil {
		return fail(409, "origin-required")
	}
	_, err := tx.ExecContext(ctx, "UPDATE players SET lease_seen_at=? WHERE habitica_id=?", a.Config.Now().Unix(), s.HabiticaID)
	return err
}
func revision(s store.Snapshot, m Mutation, current bool) error {
	if m.BaseRev == nil || *m.BaseRev < 0 || *m.BaseRev > s.Rev {
		return fail(409, "invalid-revision")
	}
	if current && *m.BaseRev != s.Rev {
		return fail(409, "stale-revision")
	}
	return nil
}

// upload merges a progress document. It reports the story beats the merge
// added (witness.go), none for a stale one: that is another device's
// catching up, not a moment anyone stands beside.
func upload(ctx context.Context, tx *sql.Tx, s *store.Snapshot, raw json.RawMessage, stale bool, now int64) ([]string, error) {
	maxHP, maxMana := s.State.MaxHP, s.State.MaxMana
	if stale {
		maxHP = 1e6
		maxMana = 1e6
	}
	p, err := rules.DecodeProgress(raw, maxHP, maxMana)
	if err != nil {
		return nil, fail(400, "invalid-progress")
	}
	if !stale && s.VitalsSource == "imported" && s.ImportedProfile != nil && s.State.HP <= 0 && s.ImportedProfile.HP <= 0 && p.HP != 0 {
		return nil, fail(400, "invalid-progress")
	}
	before := s.State
	s.State = rules.Merge(s.State, p, stale)
	if !rules.ValidMerged(s.State) {
		return nil, fail(400, "invalid-progress")
	}
	var beats []string
	if !stale {
		beats = storyBeats(before, s.State)
	}
	return beats, gifts(ctx, tx, s, now)
}
func gifts(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) error {
	for _, g := range []struct{ event, stage string }{{"defeat-guardian", "guardian-defeated"}, {"return-village", "complete"}} {
		if slices.Index(rules.Stages, s.State.Quest) < slices.Index(rules.Stages, g.stage) {
			continue
		}
		added, err := store.Outcome(ctx, tx, s.HabiticaID, "quest-gift:"+g.event, "quest", now)
		if err != nil {
			return err
		}
		if added {
			if err = store.Credit(ctx, tx, s, rules.E.QuestEmbers[g.event], 0, "quest", g.event, nil, now); err != nil {
				return err
			}
		}
	}
	// Settling the Warden is a story beat only: no warden-stone sliver. Slivers
	// come from the deep Tangle and the Whitequiet (maybeGrantWardenSliver).
	return nil
}
func (a *Server) progress(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		Doc json.RawMessage `json:"doc"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	if err = a.lease(ctx, tx, s, req.Mutation); err != nil {
		return err
	}
	if err = revision(s, req.Mutation, false); err != nil {
		return err
	}
	stale := *req.BaseRev < s.Rev
	status := "current"
	if stale {
		status = "stale"
	}
	beats, err := upload(ctx, tx, &s, req.Doc, stale, a.Config.Now().Unix())
	if err != nil {
		return err
	}
	if err = store.Persist(ctx, tx, &s, a.Config.Now().Unix()); err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Status string `json:"status"`
	}{s, status}, a.witnessed(s, beats))
}
func (a *Server) sync(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		Profile  json.RawMessage `json:"profile"`
		Progress json.RawMessage `json:"progress"`
	}
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
	if err = a.lease(ctx, tx, s, req.Mutation); err != nil {
		return err
	}
	if err = revision(s, req.Mutation, true); err != nil {
		return err
	}
	p, err := rules.DecodeProfile(req.Profile)
	if err != nil {
		return fail(422, "implausible-profile")
	}
	if p.ID != s.HabiticaID {
		return fail(409, "account-switch")
	}
	if !rules.Plausible(p) {
		return fail(422, "implausible-profile")
	}
	beats, err := upload(ctx, tx, &s, req.Progress, false, now)
	if err != nil {
		return err
	}
	if !rules.IsSafeArea(s.State.Area) {
		return fail(409, "not-at-safe-boundary")
	}
	p.MP = math.Min(p.MP, p.MaxMP)
	before := s.State
	reported := rules.LifetimeXP(p.Level, *p.Exp)
	if rules.IsRebirth(p, s.LossReference, s.VerifiedHighLevel) {
		if err = store.Credit(ctx, tx, &s, 0, 0, "rebirth", "sync", &reported, now); err != nil {
			return err
		}
	} else if s.LossReference.XP-reported > rules.DeathWindow(s.LossReference.Level) {
		if err = store.Credit(ctx, tx, &s, 0, 0, "xp-loss", "sync", &reported, now); err != nil {
			return err
		}
	}
	if _, err = expirePending(ctx, tx, &s, now); err != nil {
		return err
	}
	if err = store.SetLossReference(ctx, tx, &s, p, now); err != nil {
		return err
	}
	r0 := rules.Sync(rules.Save{State: s.State, VitalsSource: s.VitalsSource, ImportedProfile: s.ImportedProfile}, p, true)
	s.State = r0.Save.State
	s.ImportedProfile = r0.Save.ImportedProfile
	s.VitalsSource = r0.Save.VitalsSource
	credit := s.State.Embers - before.Embers
	// The checkpoint allowance grows by full days, never by request count.
	days := max(int64(0), (now-s.CheckpointAt)/86400)
	cap := rules.E.SyncCreditCap + int(min(days, int64(rules.E.SyncCreditMax)))*rules.E.SyncCreditDailyGrowth
	cap = min(cap, rules.E.SyncCreditMax)
	payable := max(0, int(math.Floor(s.VerifiedXP/float64(rules.E.XPPerEmber)))+cap-int(math.Floor(before.EmberXP/float64(rules.E.XPPerEmber))))
	paid := min(credit, payable)
	s.State.Embers = before.Embers
	s.State.XPEmbers = before.XPEmbers
	s.Pending += credit - paid
	if paid > 0 {
		if err = store.Credit(ctx, tx, &s, paid, paid, "sync", "xp", &reported, now); err != nil {
			return err
		}
	}
	if credit > paid {
		if _, err = tx.ExecContext(ctx, "INSERT INTO pending_credits VALUES(?,?,?,?)", s.HabiticaID, reported, credit-paid, now); err != nil {
			return err
		}
		if err = store.Credit(ctx, tx, &s, 0, 0, "pending-held", strconv.Itoa(credit-paid), &reported, now); err != nil {
			return err
		}
	}
	welcomed, err := store.Outcome(ctx, tx, s.HabiticaID, "embers:welcome", "welcome", now)
	if err != nil {
		return err
	}
	if welcomed {
		if err = store.Credit(ctx, tx, &s, rules.E.WelcomeEmbers, 0, "welcome", "first-sync", nil, now); err != nil {
			return err
		}
		s.State.Flags = rules.AddUnique(s.State.Flags, "embers:welcome")
	}
	if err = store.Persist(ctx, tx, &s, now); err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Status       string             `json:"status"`
		VitalsCredit map[string]float64 `json:"vitalsCredit"`
	}{s, r0.Status, map[string]float64{"hp": s.State.HP - before.HP, "mana": s.State.Mana - before.Mana}}, a.witnessed(s, beats))
}
func idem(ctx context.Context, tx *sql.Tx, id, op, key string, req any, now int64) (string, string, error) {
	if key == "" || len(key) > 128 {
		return "", "", fail(400, "key-required")
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM idempotency WHERE created_at<=?", now-7*86400); err != nil {
		return "", "", err
	}
	canonical := store.JSON(req)
	var value any
	if err := json.Unmarshal([]byte(canonical), &value); err != nil {
		return "", "", err
	}
	if fields, ok := value.(map[string]any); ok {
		delete(fields, "lease")
	}
	hash := store.Hash(store.JSON(value))
	var prior, response string
	err := tx.QueryRowContext(ctx, "SELECT request_hash,response_json FROM idempotency WHERE habitica_id=? AND op=? AND key=?", id, op, key).Scan(&prior, &response)
	if err == sql.ErrNoRows {
		return hash, "", nil
	}
	if err != nil {
		return "", "", err
	}
	if hash != prior {
		return "", "", fail(409, "idempotency-mismatch")
	}
	return hash, response, nil
}
func saveIdem(ctx context.Context, tx *sql.Tx, id, op, key, hash string, v any, now int64) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO idempotency VALUES(?,?,?,?,?,?)", id, op, key, hash, store.JSON(v), now)
	return err
}
func (a *Server) spend(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		Kind     string          `json:"kind"`
		Target   string          `json:"target,omitempty"`
		Progress json.RawMessage `json:"progress,omitempty"`
		Key      string          `json:"key"`
	}
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
	if err = a.lease(ctx, tx, s, req.Mutation); err != nil {
		return err
	}
	hash, prior, err := idem(ctx, tx, s.HabiticaID, "spend", req.Key, req, now)
	if err != nil {
		return err
	}
	if prior != "" {
		return a.finish(w, r, tx, json.RawMessage(prior))
	}
	if err = revision(s, req.Mutation, true); err != nil {
		return err
	}
	var beats []string
	if len(req.Progress) > 0 && string(req.Progress) != "null" {
		if beats, err = upload(ctx, tx, &s, req.Progress, false, now); err != nil {
			return err
		}
	}
	if !slices.Contains([]string{"rest", "revive", "home-rest", "road-lantern", "chest"}, req.Kind) || req.Kind == "road-lantern" && !slices.Contains(rules.E.RoadLanterns, req.Target) {
		return fail(400, "invalid-spend")
	}
	if (req.Kind == "rest" || req.Kind == "revive") && s.State.Area != "village" {
		return fail(409, "not-at-safe-boundary")
	}
	if req.Kind == "revive" && s.State.HP > 0 {
		return fail(409, "not-defeated")
	}
	if req.Kind == "home-rest" {
		if err = checkHomeRest(ctx, tx, &s, now); err != nil {
			return err
		}
	}
	before := s.State
	after, err := rules.SpendEmbers(before, rules.Spend{Kind: req.Kind, ID: req.Target}, true)
	if err != nil {
		return fail(409, err.Error())
	}
	if err = store.Credit(ctx, tx, &s, after.Embers-before.Embers, after.XPEmbers-before.XPEmbers, "spend", req.Kind+":"+req.Target, nil, now); err != nil {
		return err
	}
	s.State = after
	outcome := ""
	switch req.Kind {
	case "road-lantern":
		outcome = "lit:" + req.Target
	case "chest":
		outcome = "opened:" + rules.E.ChestID
		if err = grantOnce(ctx, tx, s.HabiticaID, rules.E.CharmItem, "chest-charm", now); err != nil {
			return err
		}
	}
	if outcome != "" {
		if _, err = store.Outcome(ctx, tx, s.HabiticaID, outcome, "spend", now); err != nil {
			return err
		}
	}
	if err = store.Persist(ctx, tx, &s, now); err != nil {
		return err
	}
	v := struct {
		store.Snapshot
		Outcome string `json:"outcome"`
	}{s, outcome}
	if err = saveIdem(ctx, tx, s.HabiticaID, "spend", req.Key, hash, v, now); err != nil {
		return err
	}
	return a.finish(w, r, tx, v, a.witnessed(s, beats))
}
func (a *Server) origin(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Choice string          `json:"choice"`
		Save   json.RawMessage `json:"save,omitempty"`
		Key    string          `json:"key"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	if req.Choice != "migrate" && req.Choice != "fresh" {
		return fail(400, "invalid-choice")
	}
	tx, s, sessionHash, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now().Unix()
	hash, prior, err := idem(ctx, tx, s.HabiticaID, "origin", req.Key, req, now)
	if err != nil {
		return err
	}
	if prior != "" {
		return a.finish(w, r, tx, json.RawMessage(prior))
	}
	choice := "fresh"
	if req.Choice == "migrate" {
		choice = "migrated"
	}
	res, err := tx.ExecContext(ctx, "UPDATE players SET save_origin=?,save_origin_at=? WHERE habitica_id=? AND save_origin IS NULL", choice, now, s.HabiticaID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return fail(409, "already-set")
	}
	s.SaveOrigin = &choice
	var checkpoint string
	var originXP float64
	if err = tx.QueryRowContext(ctx, "SELECT checkpoint_json,checkpoint_xp FROM sessions WHERE id_hash=?", sessionHash).Scan(&checkpoint, &originXP); err != nil {
		return err
	}
	var p rules.Profile
	if err = json.Unmarshal([]byte(checkpoint), &p); err != nil {
		return err
	}
	s.State = rules.NewState()
	s.State.HP = math.Min(p.HP, p.MaxHP)
	s.State.MaxHP = p.MaxHP
	s.State.Mana = math.Min(p.MP, p.MaxMP)
	s.State.MaxMana = p.MaxMP
	s.State.EmberXP = originXP
	s.ImportedProfile = &p
	s.VitalsSource = "imported"
	if req.Choice == "migrate" {
		var save struct {
			State        json.RawMessage `json:"state"`
			VitalsSource string          `json:"vitalsSource"`
		}
		if json.Unmarshal(req.Save, &save) != nil || len(save.State) == 0 || (save.VitalsSource != "" && save.VitalsSource != "demo" && save.VitalsSource != "imported") {
			return fail(400, "invalid-save")
		}
		local, err := rules.DecodeProgress(save.State, 1e6, 1e6)
		if err != nil {
			return fail(400, "invalid-save")
		}
		hp, mana := s.State.HP, s.State.Mana
		s.State = rules.Merge(s.State, local, false)
		s.State.HP = hp
		s.State.Mana = mana
		if save.VitalsSource == "imported" {
			s.State.HP = math.Min(hp, local.HP)
			s.State.Mana = math.Min(mana, local.Mana)
		}
		var owned struct {
			Embers    float64  `json:"embers"`
			Flags     []string `json:"flags"`
			Inventory []string `json:"inventory"`
		}
		if json.Unmarshal(save.State, &owned) != nil || owned.Embers < 0 || math.IsNaN(owned.Embers) || math.IsInf(owned.Embers, 0) {
			return fail(400, "invalid-save")
		}
		gift := int(math.Min(math.Floor(owned.Embers), float64(rules.E.MigrationGiftCap)))
		if err = store.Credit(ctx, tx, &s, gift, 0, "migration", "guest-balance", nil, now); err != nil {
			return err
		}
		for _, f := range owned.Flags {
			valid := f == "embers:welcome" || f == "opened:"+rules.E.ChestID
			for _, id := range rules.E.RoadLanterns {
				valid = valid || f == "lit:"+id
			}
			if valid {
				if _, err = store.Outcome(ctx, tx, s.HabiticaID, f, "migration", now); err != nil {
					return err
				}
				s.State.Flags = rules.AddUnique(s.State.Flags, f)
			}
		}
		charm := slices.Contains(owned.Inventory, rules.E.CharmItem) || slices.Contains(owned.Flags, "opened:"+rules.E.ChestID)
		if charm {
			if err = grantOnce(ctx, tx, s.HabiticaID, rules.E.CharmItem, "migration-charm", now); err != nil {
				return err
			}
			if _, err = store.Outcome(ctx, tx, s.HabiticaID, "owned:"+rules.E.CharmItem, "migration", now); err != nil {
				return err
			}
			s.State.Inventory = rules.AddUnique(s.State.Inventory, rules.E.CharmItem)
		}
		for _, g := range []struct{ stage, event string }{{"guardian-defeated", "defeat-guardian"}, {"complete", "return-village"}} {
			if slices.Index(rules.Stages, s.State.Quest) >= slices.Index(rules.Stages, g.stage) {
				if _, err = store.Outcome(ctx, tx, s.HabiticaID, "quest-gift:"+g.event, "migration", now); err != nil {
					return err
				}
			}
		}
	}
	if err = store.Persist(ctx, tx, &s, now); err != nil {
		return err
	}
	if err = saveIdem(ctx, tx, s.HabiticaID, "origin", req.Key, hash, s, now); err != nil {
		return err
	}
	return a.finish(w, r, tx, s)
}

// Browser WebSockets require an Origin; HTTP callers retain the established
// optional-Origin contract. Do not trust a caller-supplied forwarded Host.
func sameOrigin(r *http.Request, required bool) bool {
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" {
		return false
	}
	raw := r.Header.Get("Origin")
	if raw == "" {
		return !required
	}
	u, err := url.Parse(raw)
	return err == nil && u.Host == r.Host && (u.Scheme == "http" || u.Scheme == "https") && u.User == nil && u.Path == "" && u.RawQuery == "" && u.Fragment == ""
}
