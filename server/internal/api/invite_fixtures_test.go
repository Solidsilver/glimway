package api

import (
	"encoding/json"
	"fmt"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"os"
	"reflect"
	"strings"
	"testing"
)

// Independent legacy JSON oracle for lifecycle tests; production uses generated messages.
type InviteMetadata struct {
	ID        string `json:"id"`
	CreatedAt int64  `json:"createdAt"`
	ExpiresAt int64  `json:"expiresAt"`
	Used      bool   `json:"used"`
}

type inviteFixture struct {
	Name   string          `json:"name"`
	Unix   int64           `json:"unix"`
	Method string          `json:"method"`
	Body   json.RawMessage `json:"body"`
}

// Fixtures were captured from the original encoding/json handlers. Creation's
// random code/hash are compared by shape plus their hash relationship.
func inviteFixtureResponse(t *testing.T, f inviteFixture) map[string]any {
	t.Helper()
	x := newRig(t)
	x.now.Store(f.Unix)
	c, s := x.ready("alice")
	exec := func(q string, args ...any) {
		t.Helper()
		if _, err := x.db.DB.Exec(q, args...); err != nil {
			t.Fatal(err)
		}
	}
	switch f.Name {
	case "populated":
		exec("INSERT INTO invites(code_hash,created_by,world_id,created_at,expires_at,used_by) VALUES(?,?,?,?,?,?)", strings.Repeat("a", 64), "alice", s.WorldID, 0, f.Unix+InviteTTL, nil)
		exec("INSERT INTO invites(code_hash,created_by,world_id,created_at,expires_at,used_by) VALUES(?,?,?,?,?,?)", strings.Repeat("b", 64), "alice", s.WorldID, 0, 0, "alice")
		// Neither expired nor revoked unused codes appear in the read response.
		exec("INSERT INTO invites(code_hash,created_by,world_id,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?)", strings.Repeat("c", 64), "alice", s.WorldID, 1, 0, nil)
		exec("INSERT INTO invites(code_hash,created_by,world_id,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?)", strings.Repeat("d", 64), "alice", s.WorldID, 1, f.Unix+InviteTTL, 1)
	case "exhausted":
		for i := 0; i < rules.E.LifetimeInvites; i++ {
			exec("INSERT INTO invites(code_hash,created_by,world_id,created_at,expires_at,revoked_at) VALUES(?,?,?,?,?,?)", fmt.Sprintf("%064x", i), "alice", s.WorldID, 0, 0, 1)
		}
	case "party-admitted-own-world":
		exec("UPDATE allowlist SET added_by='party' WHERE habitica_id='alice'")
	case "party":
		exec("UPDATE worlds SET owner_id='' WHERE id=?", s.WorldID)
		exec("UPDATE allowlist SET added_by='party' WHERE habitica_id='alice'")
	}
	var body any
	if f.Method == "POST" {
		body = map[string]any{}
	}
	w := x.rawHTTP(f.Method, "/api/invites", body, c)
	if w.Code != 200 {
		t.Fatalf("invite fixture %s: %d %s", f.Name, w.Code, w.Body.String())
	}
	return decodeHTTP[map[string]any](t, w)
}

func TestInviteGolden(t *testing.T) {
	b, err := os.ReadFile("testdata/invites.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []inviteFixture
	if err = json.Unmarshal(b, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, f := range fixtures {
		t.Run(f.Name, func(t *testing.T) {
			got := inviteFixtureResponse(t, f)
			var want map[string]any
			if err := json.Unmarshal(f.Body, &want); err != nil {
				t.Fatal(err)
			}
			if f.Method == "POST" {
				code, ok := got["code"].(string)
				if !ok || code == "" || store.Hash(code) != got["id"] {
					t.Fatal("creation lost raw code/hash", got)
				}
				got["code"], got["id"] = want["code"], want["id"]
			}
			if !reflect.DeepEqual(got, want) {
				t.Fatalf("HTTP shape changed\ngot %#v\nwant %#v", got, want)
			}
		})
	}
}
