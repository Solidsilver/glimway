package api

import (
	"bytes"
	"context"
	"encoding/json"
	"glimway/content"
	"glimway/server/internal/habitica"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"log"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const secret = "RECOGNIZABLE-HABITICA-TOKEN-NEVER-PERSIST-9238"

type rig struct {
	t        *testing.T
	db       *store.Store
	api      *Server
	upstream *httptest.Server
	accounts map[string]string
	profiles map[string]rules.Profile
	mu       sync.Mutex
	now      atomic.Int64
	logs     bytes.Buffer
	calls    atomic.Int64
	dir      string
}

type response struct {
	store.Snapshot
	Lease  string `json:"lease"`
	Status string `json:"status"`
	// WorldChoice: a newcomer's sign-in held until they choose a world.
	WorldChoice *worldChoiceView `json:"worldChoice"`
}

func profile(id string, level, exp, hp float64) rules.Profile {
	p := rules.Profile{ID: id, Name: "Hero", Level: level, Exp: &exp, HP: hp, MaxHP: 50, MP: 10, MaxMP: 30 + 2*float64(int(min(level, 100))/2), Stats: rules.Stats{Str: float64(int(min(level, 100)) / 2), Int: float64(int(min(level, 100)) / 2), Con: float64(int(min(level, 100)) / 2), Per: float64(int(min(level, 100)) / 2)}, Pets: []string{}, Mounts: []string{}}
	return rules.SanitizeProfile(p)
}

func newRig(t *testing.T) *rig {
	t.Helper()
	x := &rig{t: t, accounts: map[string]string{}, profiles: map[string]rules.Profile{}, dir: t.TempDir()}
	x.now.Store(time.Now().Unix())
	var err error
	x.db, err = store.Open(filepath.Join(x.dir, "game.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	x.upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		x.calls.Add(1)
		if r.Method != "GET" || r.URL.Path != "/api/v3/user" || r.Header.Get("X-Client") != "test-creator-glimway" {
			t.Error("invalid upstream request")
		}
		id := r.Header.Get("X-Api-User")
		x.mu.Lock()
		p, ok := x.profiles[id]
		x.mu.Unlock()
		if !ok {
			p = profile(id, 1, 0, 20)
		}
		w.Header().Set("Content-Type", "application/json")
		class := ""
		if p.Class != nil {
			class = *p.Class
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"success": true, "data": map[string]any{"_id": id, "party": map[string]any{"_id": p.PartyID}, "profile": map[string]any{"name": p.Name}, "flags": map[string]any{"classSelected": p.Class != nil}, "stats": map[string]any{"lvl": p.Level, "exp": p.Exp, "hp": p.HP, "mp": p.MP, "str": 0, "int": 0, "con": 0, "per": 0, "class": class}, "apiToken": r.Header.Get("X-Api-Key"), "items": map[string]any{"gear": map[string]any{"equipped": map[string]any{"apiToken": secret}}}}})
	}))
	x.api = New(x.db, habitica.New(x.upstream.URL, "test-creator-glimway"), Config{SecureCookie: true, Logger: log.New(&x.logs, "", 0), Now: func() time.Time { return time.Unix(x.now.Load(), 0) }})
	t.Cleanup(func() { x.upstream.Close(); x.db.Close() })
	return x
}

func (x *rig) set(p rules.Profile) { x.mu.Lock(); defer x.mu.Unlock(); x.profiles[p.ID] = p }

func (x *rig) request(method, path string, body any, cookie *http.Cookie) (int, response, string, *http.Cookie) {
	x.t.Helper()
	w := x.rawHTTP(method, path, body, cookie)
	v := decodeHTTP[response](x.t, w)
	// Domain assertions include pack items; PlayerState intentionally does not.
	if w.Code == 200 && v.AccountID != "" && (path == "/api/state" || path == "/api/play" || path == "/api/session" || path == "/api/world/choose") {
		tx, err := x.db.DB.Begin()
		if err != nil {
			x.t.Fatal(err)
		}
		items, err := store.PackItems(context.Background(), tx, v.AccountID)
		tx.Rollback()
		if err != nil {
			x.t.Fatal(err)
		}
		for _, item := range items {
			v.State.Inventory = rules.AddUnique(v.State.Inventory, item)
		}
	}
	errDoc := decodeHTTP[struct{ Error struct{ Code string } }](x.t, w)
	var out *http.Cookie
	if cs := w.Result().Cookies(); len(cs) > 0 {
		out = cs[0]
	}
	return w.Code, v, errDoc.Error.Code, out
}

func (x *rig) expect(method, path string, body any, c *http.Cookie, code int) response {
	x.t.Helper()
	status, s, e, _ := x.request(method, path, body, c)
	if status != code {
		x.t.Fatalf("%s %s: got %d %s, want %d", method, path, status, e, code)
	}
	return s
}

func (x *rig) login(id, invite string) *http.Cookie {
	x.t.Helper()
	if invite == "" {
		if err := x.db.Allow(context.Background(), id, true); err != nil {
			x.t.Fatal(err)
		}
	}
	code, v, err, c := x.request("POST", "/api/session", map[string]any{"userId": id, "token": secret, "invite": invite}, nil)
	if code != 200 {
		x.t.Fatalf("login: %d %s", code, err)
	}
	x.chooseIfAsked(v, c)
	return c
}

// chooseIfAsked answers a first sign-in's world question the way most tests
// want it: the party's world (world_choice_test.go asks it both ways).
func (x *rig) chooseIfAsked(v response, c *http.Cookie) {
	x.t.Helper()
	if v.WorldChoice != nil {
		x.expect("POST", "/api/world/choose", map[string]any{"choice": "party"}, c, 200)
	}
}

func (x *rig) ready(id string) (*http.Cookie, response) {
	c := x.login(id, "")
	s := x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c, 200)
	return c, s
}

func mutation(s response, doc rules.State) map[string]any {
	return map[string]any{"lease": s.Lease, "baseRev": s.Version, "doc": doc}
}

func syncBody(s response, p rules.Profile, doc rules.State) map[string]any {
	return map[string]any{"lease": s.Lease, "baseRev": s.Version, "profile": p, "progress": doc}
}

func spendBody(s response, kind, target, key string, doc rules.State) map[string]any {
	return map[string]any{"lease": s.Lease, "baseRev": s.Version, "kind": kind, "target": target, "key": key, "progress": doc}
}

func count(t *testing.T, s *store.Store, q string, args ...any) int {
	t.Helper()
	var n int
	if err := s.DB.QueryRow(q, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func unchanged(t *testing.T, a, b store.Snapshot) {
	t.Helper()
	if store.JSON(a) != store.JSON(b) {
		t.Fatalf("state changed on rejected operation\nbefore=%s\nafter=%s", store.JSON(a), store.JSON(b))
	}
}

func body(s response, key string, fields map[string]any) map[string]any {
	out := map[string]any{"lease": s.Lease, "baseRev": s.Version, "key": key}
	for k, v := range fields {
		out[k] = v
	}
	return out
}

var keyCounter struct {
	sync.Mutex
	n int
}

func keySeq() int {
	keyCounter.Lock()
	defer keyCounter.Unlock()
	keyCounter.n++
	return keyCounter.n
}

// conserved: for every carried definition, the ledger's pack currency adds
// up to what the tables hold (stacks plus loose instances) for this player.
func (x *rig) conserved(id string) {
	x.t.Helper()
	rows, err := x.db.DB.Query("SELECT currency,SUM(delta) FROM ledger WHERE account_id=? AND (currency LIKE 'material:%' OR currency LIKE 'item:%' OR currency LIKE 'fitted:%') GROUP BY currency", id)
	if err != nil {
		x.t.Fatal(err)
	}
	ledger := map[string]int{}
	for rows.Next() {
		var c string
		var n int
		if err = rows.Scan(&c, &n); err != nil {
			x.t.Fatal(err)
		}
		ledger[c] = n
	}
	rows.Close()
	held := map[string]int{}
	// Fittings count under whoever holds their tool (fitted:<def>).
	rows, err = x.db.DB.Query(`SELECT item_def,SUM(qty) FROM item_stacks WHERE location='pack' AND owner=? GROUP BY item_def
 UNION ALL SELECT item_def,count(*) FROM item_instances WHERE location='pack' AND owner=? GROUP BY item_def
 UNION ALL SELECT 'fitted:'||f.item_def,count(*) FROM item_instances f JOIN item_instances t ON t.id=f.owner WHERE f.location='fitted' AND t.location='pack' AND t.owner=? GROUP BY f.item_def`, id, id, id)
	if err != nil {
		x.t.Fatal(err)
	}
	for rows.Next() {
		var d string
		var n int
		if err = rows.Scan(&d, &n); err != nil {
			x.t.Fatal(err)
		}
		if strings.HasPrefix(d, "fitted:") {
			held[d] += n
		} else {
			held[content.StackCurrency(d)] += n
		}
	}
	rows.Close()
	for c, n := range ledger {
		if held[c] != n {
			x.t.Fatalf("%s: ledger %d, held %d", c, n, held[c])
		}
	}
	for c, n := range held {
		if ledger[c] != n {
			x.t.Fatalf("%s: held %d, ledger %d", c, n, ledger[c])
		}
	}
}

func (x *rig) refresh(c *http.Cookie, s *response) {
	s.Snapshot = x.expect("GET", "/api/state", nil, c, 200).Snapshot
}

// rawHTTP keeps response bytes available for replay and malformed-input assertions.
func (x *rig) rawHTTP(method, path string, body any, cookie *http.Cookie) *httptest.ResponseRecorder {
	x.t.Helper()
	var b []byte
	if body != nil {
		var err error
		b, err = json.Marshal(body)
		if err != nil {
			x.t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	r.Header.Set("X-Glimway-Contract", "3")
	r.Header.Set("Content-Type", "application/json")
	if cookie != nil {
		r.AddCookie(cookie)
	}
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, r)
	x.cacheAccounts()
	return w
}

func decodeHTTP[T any](t *testing.T, w *httptest.ResponseRecorder) T {
	t.Helper()
	var v T
	if err := json.Unmarshal(testSnapshotJSON(w.Body.Bytes()), &v); err != nil {
		t.Fatalf("HTTP %d: invalid JSON: %v\n%s", w.Code, err, w.Body.String())
	}
	return v
}

func httpResponse[T any](x *rig, method, path string, body any, c *http.Cookie, status int) (T, *httptest.ResponseRecorder) {
	x.t.Helper()
	w := x.rawHTTP(method, path, body, c)
	if w.Code != status {
		x.t.Fatalf("%s %s got %d %s want %d", method, path, w.Code, w.Body.String(), status)
	}
	return decodeHTTP[T](x.t, w), w
}

// account explicitly resolves a test sign-in subject to its gameplay identity.
func (x *rig) account(subject string) string {
	x.t.Helper()

	id, ok := x.accounts[subject]
	if !ok {
		x.t.Fatalf("account %s does not exist", subject)
	}
	return id
}
func (x *rig) cacheAccounts() {
	rows, err := x.db.DB.Query("SELECT subject,account_id FROM sign_ins WHERE method='habitica'")
	if err != nil {
		return
	}
	defer rows.Close()
	for rows.Next() {
		var subject, id string
		if err = rows.Scan(&subject, &id); err != nil {
			x.t.Fatal(err)
		}
		x.accounts[subject] = id
	}
	if err = rows.Err(); err != nil {
		x.t.Fatal(err)
	}
}
