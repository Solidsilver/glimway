package main

import (
	"glimway/server/internal/store"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestRound2ACLIFlagClear(t *testing.T) {
	path := filepath.Join(t.TempDir(), "game.sqlite")
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// Seed a complete player through the minimum foreign-key graph.
	_, err = s.DB.Exec("INSERT INTO worlds(id,owner_id,seed,habitica_party_id,created_at) VALUES('w','alice','seed',NULL,1); INSERT INTO players(habitica_id,display_name,world_id,flagged_at,created_at,last_seen_at) VALUES('alice','Hero','w',1,1,1); INSERT INTO progress VALUES('alice',1,0,'{}',1)")
	s.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err = run([]string{"-db", path, "flag", "clear", "alice"}); err != nil {
		t.Fatal(err)
	}
	s, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var n int
	if err = s.DB.QueryRow("SELECT count(*) FROM players WHERE flagged_at IS NOT NULL").Scan(&n); err != nil || n != 0 {
		t.Fatal("flag not cleared")
	}
}
func TestRound2DCLIInviteInspectAndRevoke(t *testing.T) {
	path := filepath.Join(t.TempDir(), "game.sqlite")
	s, err := store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	code, err := s.Invite(t.Context(), "")
	s.Close()
	if err != nil {
		t.Fatal(err)
	}
	capture := func(args ...string) string {
		t.Helper()
		r, w, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		original := os.Stdout
		os.Stdout = w
		err = run(append([]string{"-db", path}, args...))
		os.Stdout = original
		w.Close()
		b := make([]byte, 4096)
		n, _ := r.Read(b)
		r.Close()
		if err != nil {
			t.Fatal(err)
		}
		return string(b[:n])
	}
	out := capture("invites", "cli")
	if !strings.Contains(out, store.Hash(code)) || strings.Contains(out, code) {
		t.Fatal("CLI metadata absent or raw code leaked")
	}
	capture("invite", "revoke", store.Hash(code))
	s, err = store.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var n int
	if err = s.DB.QueryRow("SELECT count(*) FROM invites WHERE revoked_at IS NOT NULL").Scan(&n); err != nil || n != 1 {
		t.Fatal("CLI revoke failed")
	}
}
