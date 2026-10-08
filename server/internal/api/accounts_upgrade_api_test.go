package api

import (
	"database/sql"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// Historical cookies, held sign-ins and foreign-key gameplay rows cross 026/027
// together. SQL 001–025 builds the old schema; their Go backfill has no old rows
// to visit here. The populated rows then run production's full 026/027 upgrade.
func TestHistoricalAccountUpgradeThroughAPI(t *testing.T) {
	x := newRig(t)
	path := filepath.Join(x.dir, "historical.sqlite")
	old, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = old.Exec("PRAGMA foreign_keys=ON; CREATE TABLE schema_migrations(name TEXT PRIMARY KEY,applied_at INTEGER NOT NULL)"); err != nil {
		t.Fatal(err)
	}
	files, err := filepath.Glob("../store/migrations/*.sql")
	if err != nil {
		t.Fatal(err)
	}
	for _, file := range files {
		name := filepath.Base(file)
		if name > "025_world_choice.sql" {
			break
		}
		raw, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = old.Exec(string(raw)); err != nil {
			t.Fatal(name, err)
		}
		if _, err = old.Exec("INSERT INTO schema_migrations VALUES(?,0)", name); err != nil {
			t.Fatal(err)
		}
	}
	execOld := func(query string, args ...any) {
		t.Helper()
		offset := 0
		for _, statement := range strings.Split(query, ";") {
			if strings.TrimSpace(statement) == "" {
				continue
			}
			n := strings.Count(statement, "?")
			if _, err := old.Exec(statement, args[offset:offset+n]...); err != nil {
				t.Fatal(err)
			}
			offset += n
		}
	}
	now := x.now.Load()
	cookie := strings.Repeat("a", 64)
	heldCookie := strings.Repeat("b", 64)
	p := profile("legacy-owner", 2, 5, 32)
	checkpoint := store.JSON(p)
	if _, err = old.Exec("INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('legacy-world','legacy-owner','seed',?)", now); err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"legacy-owner", "legacy-friend"} {
		var origin any = "fresh"
		if id == "legacy-owner" {
			origin = nil
		}
		execOld(`INSERT INTO players(habitica_id,display_name,world_id,save_origin,created_at,last_seen_at,rev) VALUES(?,'Hero','legacy-world',?,?,?,7);
   INSERT INTO progress VALUES(?,1,7,?,?); INSERT INTO balances VALUES(?,9,3);
   INSERT INTO sync_baselines(habitica_id,profile_json,xp_mark,verified_xp,checkpoint_json,checkpoint_at,updated_at) VALUES(?,?,0,30,?,?,?);
   INSERT INTO allowlist VALUES(?,'cli',?)`, id, origin, now, now, id, store.JSON(rules.NewState()), now, id, id, checkpoint, checkpoint, now, now, id, now)
	}
	execOld(`INSERT INTO sessions(id_hash,habitica_id,created_at,expires_at,checkpoint_json,checkpoint_xp) VALUES(?,'legacy-owner',?,?,?,30);
  INSERT INTO allowlist VALUES('held-subject','cli',?);
  INSERT INTO pending_sessions VALUES(?,'held-subject','Held','party',?,?,?,30);
  INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,sent_at) VALUES('old-mail','legacy-world','legacy-friend','legacy-owner','material','timber',1,?);
  INSERT INTO invites(code_hash,created_by,world_id,created_at,expires_at) VALUES(?,'legacy-owner','legacy-world',?,?)`, store.Hash(cookie), now, now+3600, checkpoint, now, store.Hash(heldCookie), now, now+3600, store.JSON(profile("held-subject", 2, 5, 32)), now, store.Hash("historical-invite"), now, now+3600)
	execOld(`UPDATE mail SET makers='[{"maker":"","qty":1}]' WHERE id='old-mail'`)
	old.Close()
	upgraded, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	x.db.Close()
	x.db = upgraded
	x.api.Store = upgraded
	x.set(p)
	legacy := &http.Cookie{Name: CookieName, Value: cookie}
	held := &http.Cookie{Name: CookieName, Value: heldCookie}
	s := x.expect("GET", "/api/state", nil, legacy, 200)
	if s.AccountID != "legacy-owner" || s.State.HP != 32 || s.State.Embers != 9 {
		t.Fatal("historical fresh baseline", s)
	}
	if w := x.rawHTTP("GET", "/api/mail", nil, legacy); w.Code != 200 || !strings.Contains(w.Body.String(), "old-mail") {
		t.Fatal(w.Body.String())
	}
	if w := x.rawHTTP("GET", "/api/invites", nil, legacy); w.Code != 200 || !strings.Contains(w.Body.String(), store.Hash("historical-invite")) {
		t.Fatal(w.Body.String())
	}
	if w := x.rawHTTP("GET", "/api/world/choice", nil, held); w.Code != 200 || !strings.Contains(w.Body.String(), "held-subject") {
		t.Fatal(w.Code, w.Body.String())
	}
	x.expect("POST", "/api/world/choose", map[string]any{"choice": "own"}, held, 200)
	// Prove the fake Habitica path still maps the old subject and first mutation works.
	login := x.login("legacy-owner", "")
	play := x.expect("POST", "/api/play", map[string]any{"clientId": "upgrade-client"}, login, 200)
	mutation := x.p5("POST", "/api/mail/old-mail/claim", body(play, "upgrade-claim", map[string]any{}), login, 200)
	if mutation.Version <= play.Version {
		t.Fatal("first upgraded mutation did not commit")
	}
	rows, err := upgraded.DB.Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	if rows.Next() {
		t.Fatal("foreign keys invalid")
	}
}
