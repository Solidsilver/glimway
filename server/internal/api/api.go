// Package api implements the phase-2 HTTP contract. All gameplay commits,
// authorization checks, ledger entries and idempotency responses share one tx.
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fingersnap/server/internal/habitica"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
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

const CookieName = "fingersnap_session"
const SessionTTL = 30 * 24 * time.Hour

type Config struct {
	SecureCookie bool
	Logger       *log.Logger
	Now          func() time.Time
}
type Server struct {
	Store    *store.Store
	Habitica *habitica.Client
	Config   Config
}

func New(s *store.Store, h *habitica.Client, c Config) *Server {
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.Logger == nil {
		c.Logger = log.New(io.Discard, "", 0)
	}
	return &Server{s, h, c}
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
	maxAge := int(SessionTTL.Seconds())
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
	if slices.Contains([]string{"/api/session", "/api/origin", "/api/play", "/api/state", "/api/progress", "/api/sync", "/api/spend"}, r.URL.Path) {
		route = r.URL.Path
	}
	defer a.Config.Logger.Printf("request method=%s route=%s", safeMethod(r.Method), route)
	if r.Method != "GET" && r.Method != "HEAD" {
		if site := r.Header.Get("Sec-Fetch-Site"); site == "cross-site" {
			problem(w, fail(403, "cross-origin"))
			return
		}
		if origin := r.Header.Get("Origin"); origin != "" {
			u, err := url.Parse(origin)
			if err != nil || u.Host != r.Host || (u.Scheme != "http" && u.Scheme != "https") {
				problem(w, fail(403, "cross-origin"))
				return
			}
		}
		if r.Method != "DELETE" && !strings.HasPrefix(strings.ToLower(r.Header.Get("Content-Type")), "application/json") {
			problem(w, fail(415, "json-required"))
			return
		}
	}
	var err error
	switch r.Method + " " + r.URL.Path {
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
	case "POST /api/spend":
		err = a.spend(w, r)
	default:
		err = fail(404, "not-found")
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
	err = tx.QueryRowContext(ctx, "SELECT s.habitica_id FROM sessions s JOIN allowlist l USING(habitica_id) WHERE s.id_hash=? AND s.expires_at>?", hash, now).Scan(&id)
	if err == sql.ErrNoRows {
		return "", "", fail(401, "unauthorized")
	}
	if err != nil {
		return "", "", err
	}
	_, err = tx.ExecContext(ctx, "UPDATE sessions SET expires_at=? WHERE id_hash=?", now+int64(SessionTTL.Seconds()), hash)
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
	s, err := store.Load(r.Context(), tx, id)
	if err != nil {
		tx.Rollback()
		return nil, s, "", err
	}
	return tx, s, hash, nil
}
func (a *Server) finish(w http.ResponseWriter, r *http.Request, tx *sql.Tx, v any) error {
	if err := tx.Commit(); err != nil {
		return err
	}
	if c, err := r.Cookie(CookieName); err == nil {
		a.cookie(w, c.Value, a.Config.Now().Add(SessionTTL))
	}
	write(w, 200, v)
	return nil
}
func (a *Server) login(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		UserID string `json:"userId"`
		Token  string `json:"token"`
		Invite string `json:"invite"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	if req.UserID == "" || len(req.UserID) > 128 || req.Token == "" || len(req.Token) > 512 || len(req.Invite) > 128 {
		return fail(400, "invalid-credentials")
	}
	p, err := a.Habitica.Verify(r.Context(), req.UserID, req.Token)
	req.Token = ""
	if err != nil {
		var h *habitica.Error
		if errors.As(err, &h) {
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
	world := ""
	if allowed == 0 {
		var named sql.NullString
		err = tx.QueryRowContext(ctx, "SELECT world_id FROM invites WHERE code_hash=? AND used_by IS NULL", store.Hash(req.Invite)).Scan(&named)
		if err == sql.ErrNoRows {
			return fail(403, "access-denied")
		}
		if err != nil {
			return err
		}
		if named.Valid {
			world = named.String
		}
		res, err := tx.ExecContext(ctx, "UPDATE invites SET used_by=?,used_at=? WHERE code_hash=? AND used_by IS NULL", p.ID, now, store.Hash(req.Invite))
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
		if _, err = tx.ExecContext(ctx, "INSERT INTO allowlist VALUES(?,?,?)", p.ID, "invite", now); err != nil {
			return err
		}
	}
	var existing int
	if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM players WHERE habitica_id=?", p.ID).Scan(&existing); err != nil {
		return err
	}
	verified := rules.LifetimeXP(p.Level, *p.Exp)
	if existing == 0 {
		if world == "" {
			world, err = store.Random()
			if err != nil {
				return err
			}
			seed, err := store.Random()
			if err != nil {
				return err
			}
			if _, err = tx.ExecContext(ctx, "INSERT INTO worlds(id,owner_id,seed,created_at) VALUES(?,?,?,?)", world, p.ID, seed, now); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO players(habitica_id,display_name,world_id,created_at,last_seen_at) VALUES(?,?,?,?,?)", p.ID, p.Name, world, now, now); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO progress VALUES(?,1,0,?,?)", p.ID, store.JSON(rules.NewState()), now); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO balances VALUES(?,0,0)", p.ID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO sync_baselines(habitica_id,xp_mark,verified_xp,checkpoint_json,checkpoint_at,updated_at) VALUES(?,?,?,?,?,?)", p.ID, verified, verified, store.JSON(p), now, now); err != nil {
			return err
		}
	} else {
		s, err := store.Load(ctx, tx, p.ID)
		if err != nil {
			return err
		}
		changed := false
		if s.State.EmberXP > verified+rules.E.CheckpointToleranceXP {
			if _, err = tx.ExecContext(ctx, "UPDATE players SET flagged_at=COALESCE(flagged_at,?) WHERE habitica_id=?", now, p.ID); err != nil {
				return err
			}
			s.Flagged = true
			if s.Pending > 0 {
				if err = store.Credit(ctx, tx, &s, 0, 0, "pending-dropped", "checkpoint", &verified, now); err != nil {
					return err
				}
			}
			s.Pending = 0
			changed = true
		} else if s.Pending > 0 {
			// Pay only the portion independently confirmed by this checkpoint.
			unconfirmed := max(0, int(math.Floor(s.State.EmberXP/float64(rules.E.XPPerEmber))-math.Floor(verified/float64(rules.E.XPPerEmber))))
			confirmed := max(0, s.Pending-unconfirmed)
			if confirmed > 0 {
				if err = store.Credit(ctx, tx, &s, confirmed, confirmed, "pending-settled", "checkpoint", &verified, now); err != nil {
					return err
				}
			}
			if s.Pending > confirmed {
				if err = store.Credit(ctx, tx, &s, 0, 0, "pending-dropped", "checkpoint", &verified, now); err != nil {
					return err
				}
			}
			s.Pending = 0
			changed = true
		}
		if changed {
			if err = store.Persist(ctx, tx, &s, now); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE players SET display_name=?,last_seen_at=? WHERE habitica_id=?", p.Name, now, p.ID); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE sync_baselines SET verified_xp=?,checkpoint_json=?,checkpoint_at=? WHERE habitica_id=?", verified, store.JSON(p), now, p.ID); err != nil {
			return err
		}
	}
	session, err := store.Random()
	if err != nil {
		return err
	}
	expires := a.Config.Now().Add(SessionTTL)
	if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE expires_at<=?", now); err != nil {
		return err
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
	a.cookie(w, session, expires)
	write(w, 200, s)
	return nil
}
func (a *Server) logout(w http.ResponseWriter, r *http.Request) error {
	if c, err := r.Cookie(CookieName); err == nil {
		if _, err = a.Store.DB.ExecContext(r.Context(), "DELETE FROM sessions WHERE id_hash=?", store.Hash(c.Value)); err != nil {
			return err
		}
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
	if l := r.Header.Get("X-Play-Lease"); l != "" && s.LeaseID.Valid && l == s.LeaseID.String {
		if _, err = tx.ExecContext(r.Context(), "UPDATE players SET lease_seen_at=? WHERE habitica_id=?", a.Config.Now().Unix(), s.HabiticaID); err != nil {
			return err
		}
	}
	return a.finish(w, r, tx, s)
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
	}{s, lease})
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
func upload(ctx context.Context, tx *sql.Tx, s *store.Snapshot, raw json.RawMessage, stale bool, now int64) error {
	maxHP, maxMana := s.State.MaxHP, s.State.MaxMana
	if stale {
		maxHP = 1e6
		maxMana = 1e6
	}
	p, err := rules.DecodeProgress(raw, maxHP, maxMana)
	if err != nil {
		return fail(400, "invalid-progress")
	}
	s.State = rules.Merge(s.State, p, stale)
	return gifts(ctx, tx, s, now)
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
	if err = upload(ctx, tx, &s, req.Doc, stale, a.Config.Now().Unix()); err != nil {
		return err
	}
	if err = store.Persist(ctx, tx, &s, a.Config.Now().Unix()); err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Status string `json:"status"`
	}{s, status})
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
	if !rules.Plausible(p, s.State.EmberXP) {
		return fail(422, "implausible-profile")
	}
	if err = upload(ctx, tx, &s, req.Progress, false, now); err != nil {
		return err
	}
	if !rules.SafeAreas[s.State.Area] {
		return fail(409, "not-at-safe-boundary")
	}
	before := s.State
	r0 := rules.Sync(rules.Save{State: s.State, VitalsSource: s.VitalsSource, ImportedProfile: s.ImportedProfile}, p, true)
	s.State = r0.Save.State
	s.ImportedProfile = r0.Save.ImportedProfile
	s.VitalsSource = r0.Save.VitalsSource
	credit := s.State.Embers - before.Embers
	paid := min(credit, rules.E.SyncCreditCap)
	s.State.Embers = before.Embers
	s.State.XPEmbers = before.XPEmbers
	s.Pending += credit - paid
	reported := rules.LifetimeXP(p.Level, *p.Exp)
	if paid > 0 {
		if err = store.Credit(ctx, tx, &s, paid, paid, "sync", "xp", &reported, now); err != nil {
			return err
		}
	}
	if credit > paid {
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
	}{s, r0.Status, map[string]float64{"hp": s.State.HP - before.HP, "mana": s.State.Mana - before.Mana}})
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
	if len(req.Progress) > 0 && string(req.Progress) != "null" {
		if err = upload(ctx, tx, &s, req.Progress, false, now); err != nil {
			return err
		}
	}
	if !slices.Contains([]string{"rest", "revive", "road-lantern", "chest"}, req.Kind) || req.Kind == "road-lantern" && !slices.Contains(rules.E.RoadLanterns, req.Target) {
		return fail(400, "invalid-spend")
	}
	if (req.Kind == "rest" || req.Kind == "revive") && !rules.SafeAreas[s.State.Area] {
		return fail(409, "not-at-safe-boundary")
	}
	if req.Kind == "revive" && s.State.HP > 0 {
		return fail(409, "not-defeated")
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
		if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO inventory VALUES(?,?,1)", s.HabiticaID, rules.E.CharmItem); err != nil {
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
	return a.finish(w, r, tx, v)
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
			if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO inventory VALUES(?,?,1)", s.HabiticaID, rules.E.CharmItem); err != nil {
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
