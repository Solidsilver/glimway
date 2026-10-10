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
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

const secret = "RECOGNIZABLE-HABITICA-TOKEN-NEVER-PERSIST-9238"

// rigStart is the clock every rig starts on (review findings 4 and 5): a
// fixed day, never the day the suite happens to run. It is Bloom wick, day 5
// of the calendar's first year (2026-01-30T00:00:00Z) — a Carting-mark day
// with no festival on it — so the seasonal tests walk the same calendar
// every run and the madder stall, the Quiet banks and Carting Day are always
// reached by an explicit jump. Tests that need another season move the clock
// there themselves. GLIMWAY_RIG_START=<unix seconds> runs the whole suite at
// another day instead — ready for a nightly job, one date per mark plus each
// festival (review finding 9).
var rigStart = func() int64 {
	if v := os.Getenv("GLIMWAY_RIG_START"); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return 1769731200
}()

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
	// pulses is the hub's ward-pulse timer, fired by hand (review finding 12).
	pulses *wardPulseQueue

	// The fake Habitica's purse side (design 2.2, 4.3): the hero's gold and
	// owned gear, the rewards a top-up created, and how the score answers.
	// The switches are the same ones the e2e fake offers (e2e/server/
	// fake-habitica.ts): 'ok', 'not-enough-gold', 'error' (an unknown
	// outcome, nothing charged), 'timeout-moved' (the gold goes and the
	// answer never comes) and 'hang' (the score blocks).
	habiticaGold   int
	habiticaOwned  map[string]bool
	habiticaScore  string
	habiticaCreate string
	habiticaDelete string
	habiticaDown   bool
	// habiticaDownAfter: "Habitica is down" from the n-th call on (0: never),
	// for the checks that all fail.
	habiticaDownAfter int
	// habiticaHang is how long a 'hang' score blocks.
	habiticaHang time.Duration
	rewards      map[string]int
	scores       int
	creates      int
	deletes      map[string]int
	// callLog is the order of the fake's calls: 'user', 'create', 'score',
	// 'delete:<alias>' — "leftovers deleted first" is read off it.
	callLog []string
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

// API fixtures share only the bytes of an empty, fully migrated database.
// Each test opens an independent copy; upgrade tests build their old schemas
// explicitly. This avoids repeating expensive migration instrumentation under race.
var fixtureSchema struct {
	once sync.Once
	raw  []byte
	err  error
}

func fixtureDatabase(t *testing.T, path string) (*store.Store, error) {
	t.Helper()
	fixtureSchema.once.Do(func() {
		template := filepath.Join(t.TempDir(), "empty.sqlite")
		var db *store.Store
		db, fixtureSchema.err = store.Open(template)
		if fixtureSchema.err != nil {
			return
		}
		fixtureSchema.err = db.Close()
		if fixtureSchema.err == nil {
			fixtureSchema.raw, fixtureSchema.err = os.ReadFile(template)
		}
	})
	if fixtureSchema.err != nil {
		return nil, fixtureSchema.err
	}
	if err := os.WriteFile(path, fixtureSchema.raw, 0600); err != nil {
		return nil, err
	}
	return store.Open(path)
}

func newRig(t *testing.T) *rig {
	t.Helper()
	x := &rig{t: t, accounts: map[string]string{}, profiles: map[string]rules.Profile{}, dir: t.TempDir(), habiticaGold: 1000, habiticaOwned: map[string]bool{}, rewards: map[string]int{}, deletes: map[string]int{}}
	x.now.Store(rigStart)
	var err error
	x.db, err = fixtureDatabase(t, filepath.Join(x.dir, "game.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	x.upstream = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		x.calls.Add(1)
		if r.Header.Get("X-Client") != "test-creator-glimway" {
			t.Error("invalid upstream request")
		}
		x.serveHabitica(w, r)
	}))
	x.api = New(x.db, habitica.New(x.upstream.URL, "test-creator-glimway"), Config{SecureCookie: true, Logger: log.New(&x.logs, "", 0), Now: func() time.Time { return time.Unix(x.now.Load(), 0) }})
	t.Cleanup(func() { x.upstream.Close(); x.db.Close() })
	return x
}

func (x *rig) set(p rules.Profile) { x.mu.Lock(); defer x.mu.Unlock(); x.profiles[p.ID] = p }

// The fake Habitica's purse side. The switches mirror
// e2e/server/fake-habitica.ts, which lane D's e2e drives.

func (x *rig) setGold(n int) { x.mu.Lock(); defer x.mu.Unlock(); x.habiticaGold = n }

func (x *rig) setOwned(owned map[string]bool) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.habiticaOwned = owned
}

func (x *rig) setScore(mode string) { x.mu.Lock(); defer x.mu.Unlock(); x.habiticaScore = mode }

func (x *rig) setCreate(mode string) { x.mu.Lock(); defer x.mu.Unlock(); x.habiticaCreate = mode }

func (x *rig) setDelete(mode string) { x.mu.Lock(); defer x.mu.Unlock(); x.habiticaDelete = mode }

func (x *rig) setDown(down bool) { x.mu.Lock(); defer x.mu.Unlock(); x.habiticaDown = down }

func (x *rig) setDownAfter(n int) { x.mu.Lock(); defer x.mu.Unlock(); x.habiticaDownAfter = n }

func (x *rig) setHang(d time.Duration) { x.mu.Lock(); defer x.mu.Unlock(); x.habiticaHang = d }

// calls lists the fake's calls in order.
func (x *rig) habiticaCalls() []string {
	x.mu.Lock()
	defer x.mu.Unlock()
	return append([]string(nil), x.callLog...)
}

// rewardLeft says whether a top-up's reward is still in the hero's Habitica
// Rewards.
func (x *rig) rewardLeft(alias string) bool {
	x.mu.Lock()
	defer x.mu.Unlock()
	_, ok := x.rewards[alias]
	return ok
}

func (x *rig) scoreCalls() int { x.mu.Lock(); defer x.mu.Unlock(); return x.scores }

func (x *rig) serveHabitica(w http.ResponseWriter, r *http.Request) {
	send := func(status int, body any) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_ = json.NewEncoder(w).Encode(body)
	}
	x.mu.Lock()
	down, gold, score := x.habiticaDown, x.habiticaGold, x.habiticaScore
	create, del := x.habiticaCreate, x.habiticaDelete
	hang := x.habiticaHang
	if x.habiticaDownAfter > 0 {
		x.habiticaDownAfter--
		if x.habiticaDownAfter == 0 {
			x.habiticaDown = true
			down = true
		}
	}
	owned := map[string]bool{}
	for k, v := range x.habiticaOwned {
		owned[k] = v
	}
	x.mu.Unlock()
	if r.Header.Get("X-Api-Key") != secret {
		// A wrong token reads no account, as Habitica would (4.3: a refused
		// token counts as a failed proof).
		send(401, map[string]any{"success": false, "error": "NotAuthorized"})
		return
	}
	if down {
		send(503, map[string]any{"success": false, "error": "ServiceUnavailable"})
		return
	}
	switch {
	case r.Method == "GET" && r.URL.Path == "/api/v3/user":
		x.logCall("user")
		id := r.Header.Get("X-Api-User")
		x.mu.Lock()
		p, ok := x.profiles[id]
		x.mu.Unlock()
		if !ok {
			p = profile(id, 1, 0, 20)
		}
		class := ""
		if p.Class != nil {
			class = *p.Class
		}
		// The owned lists travel the same way Habitica's do (crafts.md 2.2):
		// pets as feed counts, mounts as true. The purse's own reads ask for
		// stats.gp and items.gear.owned (2.2 step b, 4.3).
		items := map[string]any{"gear": map[string]any{"equipped": map[string]any{"apiToken": secret}, "owned": owned}}
		pets, mounts := map[string]any{}, map[string]any{}
		for _, key := range p.Pets {
			pets[key] = 1
		}
		for _, key := range p.Mounts {
			mounts[key] = true
		}
		items["pets"], items["mounts"] = pets, mounts
		if p.SelectedPet != nil {
			items["currentPet"] = *p.SelectedPet
		}
		if p.SelectedMount != nil {
			items["currentMount"] = *p.SelectedMount
		}
		send(200, map[string]any{"success": true, "data": map[string]any{"_id": id, "party": map[string]any{"_id": p.PartyID}, "profile": map[string]any{"name": p.Name}, "flags": map[string]any{"classSelected": p.Class != nil}, "stats": map[string]any{"lvl": p.Level, "exp": p.Exp, "hp": p.HP, "mp": p.MP, "gp": gold, "str": 0, "int": 0, "con": 0, "per": 0, "class": class}, "apiToken": r.Header.Get("X-Api-Key"), "items": items}})
	case r.Method == "POST" && r.URL.Path == "/api/v3/tasks/user":
		x.logCall("create")
		if create == "error" {
			send(500, map[string]any{"success": false, "error": "InternalServerError"})
			return
		}
		var task struct {
			Type, Text, Notes, Alias string
			Value                    int
		}
		if json.NewDecoder(r.Body).Decode(&task) != nil {
			send(400, map[string]any{"success": false})
			return
		}
		x.mu.Lock()
		x.rewards[task.Alias] = task.Value
		x.creates++
		x.mu.Unlock()
		send(201, map[string]any{"success": true, "data": map[string]any{"_id": task.Alias, "alias": task.Alias, "type": task.Type, "text": task.Text, "notes": task.Notes, "value": task.Value}})
	case r.Method == "POST" && strings.HasPrefix(r.URL.Path, "/api/v3/tasks/") && strings.HasSuffix(r.URL.Path, "/score/down"):
		alias := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/v3/tasks/"), "/score/down")
		x.logCall("score")
		x.mu.Lock()
		x.scores++
		value, exists := x.rewards[alias]
		x.mu.Unlock()
		if !exists {
			send(404, map[string]any{"success": false, "error": "NotFound"})
			return
		}
		charge := func() {
			x.mu.Lock()
			x.habiticaGold = max(0, x.habiticaGold-value)
			x.mu.Unlock()
		}
		switch score {
		case "not-enough-gold":
			send(401, map[string]any{"success": false, "error": "NotAuthorized", "message": "Not Enough Gold"})
		case "error":
			send(500, map[string]any{"success": false, "error": "InternalServerError"})
		case "hang":
			if hang == 0 {
				hang = 300 * time.Millisecond
			}
			time.Sleep(hang)
			send(500, map[string]any{"success": false, "error": "InternalServerError"})
		case "timeout-partial":
			// Half the charge went through and the answer didn't: the checks
			// see gold between gold_before − amount and gold_before (2.3).
			x.mu.Lock()
			x.habiticaGold = max(0, x.habiticaGold-value/2)
			x.mu.Unlock()
			send(500, map[string]any{"success": false, "error": "InternalServerError"})
		case "timeout-moved":
			// The charge happened; the answer never comes (2.3).
			charge()
			send(500, map[string]any{"success": false, "error": "InternalServerError"})
		default:
			charge()
			send(200, map[string]any{"success": true, "data": map[string]any{"gp": max(0, gold-value)}})
		}
	case r.Method == "DELETE" && strings.HasPrefix(r.URL.Path, "/api/v3/tasks/"):
		alias := strings.TrimPrefix(r.URL.Path, "/api/v3/tasks/")
		x.logCall("delete:" + alias)
		if del == "error" {
			send(500, map[string]any{"success": false, "error": "InternalServerError"})
			return
		}
		x.mu.Lock()
		_, exists := x.rewards[alias]
		delete(x.rewards, alias)
		x.deletes[alias]++
		x.mu.Unlock()
		if !exists {
			send(404, map[string]any{"success": false, "error": "NotFound"})
			return
		}
		send(200, map[string]any{"success": true, "data": map[string]any{}})
	default:
		x.t.Errorf("invalid upstream request: %s %s", r.Method, r.URL.Path)
		send(404, map[string]any{"success": false})
	}
}

func (x *rig) logCall(name string) {
	x.mu.Lock()
	defer x.mu.Unlock()
	x.callLog = append(x.callLog, name)
}

func (x *rig) request(method, path string, body any, cookie *http.Cookie) (int, response, string, *http.Cookie) {
	x.t.Helper()
	w := x.rawHTTP(method, path, body, cookie)
	v := decodeDomainHTTP[response](x, w)
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
		if err := x.db.Allow(context.Background(), id, true, x.now.Load()); err != nil {
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

func spendBody(s response, kind, target, key string, doc rules.State) map[string]any {
	return body(s, key, map[string]any{"kind": kind, "target": target, "where": testWhere(doc)})
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
	out := map[string]any{"op": map[string]any{"lease": s.Lease, "key": key}, "where": testWhere(s.State)}
	for k, v := range fields {
		if k == "progress" {
			if doc, ok := v.(rules.State); ok {
				out["where"] = testWhere(doc)
			}
			continue
		}
		if k == "op" {
			out["action"] = v
			continue
		}
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
	if fields, ok := body.(map[string]any); ok {
		if _, ok := fields["op"].(map[string]any); ok {
			if doc, ok := fields["progress"].(rules.State); ok {
				fields["where"] = testWhere(doc)
				delete(fields, "progress")
			}
		}
	}
	if fields, ok := body.(map[string]any); ok && cookie != nil {
		if op, ok := fields["op"].(map[string]any); ok {
			if path == "/api/spend" && (fields["kind"] == "rest" || fields["kind"] == "home-rest") || path == "/api/items/use" && fields["instance"] == nil {
				x.flushFixtureReport(cookie, op)
			}
		}
	}
	var b []byte
	if body != nil {
		var err error
		b, err = json.Marshal(body)
		if err != nil {
			x.t.Fatal(err)
		}
	}
	r := httptest.NewRequest(method, path, bytes.NewReader(b))
	r.Header.Set("X-Glimway-Contract", "6")
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
	return decodeDomainHTTP[T](x, w), w
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

func testWhere(s rules.State) map[string]any {
	area := s.Area
	if area == "wilds" {
		area = "wilds:inner-1"
	}
	return map[string]any{"area": area, "x": s.Position.X, "y": s.Position.Y}
}

func decodeDomainHTTP[T any](x *rig, w *httptest.ResponseRecorder) T {
	x.t.Helper()
	raw := testSnapshotJSON(w.Body.Bytes())
	var fields map[string]json.RawMessage
	json.Unmarshal(raw, &fields)
	var snap store.Snapshot
	json.Unmarshal(raw, &snap)
	if snap.AccountID != "" {
		tx, err := x.db.DB.Begin()
		if err != nil {
			x.t.Fatal(err)
		}
		items, err := store.PackItems(context.Background(), tx, snap.AccountID)
		tx.Rollback()
		if err != nil {
			x.t.Fatal(err)
		}
		var state rules.State
		if json.Unmarshal(fields["state"], &state) == nil {
			state.Inventory = rules.AddUnique(state.Inventory, items...)
			fields["state"] = json.RawMessage(store.JSON(state))
			raw, _ = json.Marshal(fields)
		}
	}
	var out T
	if err := json.Unmarshal(raw, &out); err != nil {
		x.t.Fatal(err)
	}
	return out
}
