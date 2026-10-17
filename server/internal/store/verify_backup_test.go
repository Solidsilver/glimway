package store

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/binary"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// seedBackupFixture opens a fresh store with two worlds, two accounts and a
// home, plus enough filler rows to span many pages.
func seedBackupFixture(t *testing.T, path string) *Store {
	t.Helper()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	for _, q := range []string{
		"INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w1','alice','s1',1),('w2','bob','s2',1)",
		"INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at) VALUES('alice','Alice','w1',1,1),('bob','Bob','w2',1,1)",
		"INSERT INTO homesteads(id,world_id,gate,claimed_at) VALUES('home-a','w1',3,1)",
	} {
		if _, err = s.DB.Exec(q); err != nil {
			t.Fatal(q, err)
		}
	}
	for i := range 400 {
		if err = s.Allow(context.Background(), "filler-"+string(rune('a'+i%26))+string(rune('a'+i/26)), true, 1); err != nil {
			t.Fatal(err)
		}
	}
	return s
}

func fileBytes(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

// The restore drill from docs/home-server.md: back up, verify, copy the
// snapshot alone to a new database path, open it with the store, read back.
func TestBackupVerifyRestore(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := seedBackupFixture(t, filepath.Join(dir, "live.sqlite"))
	backup := filepath.Join(dir, "backups", "snap.sqlite")
	if err := s.Backup(ctx, backup); err != nil {
		t.Fatal(err)
	}
	before := fileBytes(t, backup)
	sum, err := VerifyBackup(ctx, backup)
	if err != nil {
		t.Fatal(err)
	}
	history, err := migrationHistory()
	if err != nil {
		t.Fatal(err)
	}
	if sum.Schema != history[len(history)-1].Name || sum.Pending != 0 {
		t.Fatal("schema", sum)
	}
	if sum.Counts["players"] != 2 || sum.Counts["worlds"] != 2 || sum.Counts["homesteads"] != 1 {
		t.Fatal("counts", sum.Counts)
	}
	if !bytes.Equal(before, fileBytes(t, backup)) {
		t.Fatal("verify-backup changed the snapshot")
	}
	for _, side := range []string{"-wal", "-shm", "-journal"} {
		if _, err = os.Stat(backup + side); !os.IsNotExist(err) {
			t.Fatal("verify-backup left", side, err)
		}
	}

	restoredPath := filepath.Join(dir, "restored", "glimway.sqlite")
	if err = os.MkdirAll(filepath.Dir(restoredPath), 0700); err != nil {
		t.Fatal(err)
	}
	src, err := os.Open(backup)
	if err != nil {
		t.Fatal(err)
	}
	dst, err := os.OpenFile(restoredPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = io.Copy(dst, src); err != nil {
		t.Fatal(err)
	}
	src.Close()
	if err = dst.Close(); err != nil {
		t.Fatal(err)
	}
	restored, err := Open(restoredPath)
	if err != nil {
		t.Fatal(err)
	}
	defer restored.Close()
	var name, world, home string
	if err = restored.DB.QueryRow("SELECT p.display_name,p.world_id,h.id FROM players p JOIN homesteads h ON h.world_id=p.world_id WHERE p.account_id='alice'").Scan(&name, &world, &home); err != nil {
		t.Fatal(err)
	}
	if name != "Alice" || world != "w1" || home != "home-a" {
		t.Fatal("restored", name, world, home)
	}
	var allowed int
	if err = restored.DB.QueryRow("SELECT count(*) FROM allowlist").Scan(&allowed); err != nil || allowed != 400 {
		t.Fatal("restored allowlist", allowed, err)
	}
}

// A snapshot an older binary made still verifies: the server migrates it on restore.
func TestVerifyBackupAcceptsOlderSchema(t *testing.T) {
	history, err := migrationHistory()
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "old.sqlite")
	old := newUpgradeFixture(t, path, history[len(history)-3].Name, nil)
	old.Close()
	sum, err := VerifyBackup(context.Background(), path)
	if err != nil {
		t.Fatal(err)
	}
	if sum.Schema != history[len(history)-3].Name || sum.Pending != 2 {
		t.Fatal("older schema", sum)
	}
}

func TestVerifyBackupRejectsBrokenFiles(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s := seedBackupFixture(t, filepath.Join(dir, "live.sqlite"))
	good := filepath.Join(dir, "good.sqlite")
	if err := s.Backup(ctx, good); err != nil {
		t.Fatal(err)
	}
	raw := fileBytes(t, good)
	pageSize := int(binary.BigEndian.Uint16(raw[16:18]))
	if pageSize == 1 {
		pageSize = 65536
	}
	write := func(name string, b []byte) string {
		path := filepath.Join(dir, name)
		if err := os.WriteFile(path, b, 0600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	// Scribble over the head of the snapshot's allowlist root page.
	corrupt := bytes.Clone(raw)
	var snapRoot int
	snap, err := sql.Open("sqlite", "file:"+good+"?mode=ro&immutable=1")
	if err != nil {
		t.Fatal(err)
	}
	if err = snap.QueryRow("SELECT rootpage FROM sqlite_schema WHERE name='allowlist'").Scan(&snapRoot); err != nil {
		t.Fatal(err)
	}
	snap.Close()
	for i := range 64 {
		corrupt[(snapRoot-1)*pageSize+i] = 0xA5
	}
	newer := filepath.Join(dir, "newer.sqlite")
	if err = s.Backup(ctx, newer); err != nil {
		t.Fatal(err)
	}
	db, err := sql.Open("sqlite", newer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("INSERT INTO schema_migrations VALUES('999_from_the_future',1)"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	gap := filepath.Join(dir, "gap.sqlite")
	if err = s.Backup(ctx, gap); err != nil {
		t.Fatal(err)
	}
	if db, err = sql.Open("sqlite", gap); err != nil {
		t.Fatal(err)
	}
	if _, err = db.Exec("DELETE FROM schema_migrations WHERE name=(SELECT min(name) FROM schema_migrations)"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	for name, path := range map[string]string{
		"truncated": write("truncated.sqlite", raw[:len(raw)/2]),
		"corrupt":   write("corrupt.sqlite", corrupt),
		"garbage":   write("garbage.sqlite", bytes.Repeat([]byte("not a database "), 512)),
		"empty":     write("empty.sqlite", nil),
		"no schema": write("plain.sqlite", fileBytes(t, plainSQLite(t, dir))),
		"newer":     newer,
		"gap":       gap,
		"missing":   filepath.Join(dir, "missing.sqlite"),
	} {
		if sum, err := VerifyBackup(ctx, path); err == nil {
			t.Error(name, "verified", sum)
		} else {
			t.Log(name, err)
		}
	}
	if _, err = VerifyBackup(ctx, good); err != nil {
		t.Fatal("good snapshot", err)
	}
}

// plainSQLite is a sound SQLite file that is not a Glimway database.
func plainSQLite(t *testing.T, dir string) string {
	t.Helper()
	path := filepath.Join(dir, "plain-src.sqlite")
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec("CREATE TABLE notes(body TEXT); INSERT INTO notes VALUES('hello')"); err != nil {
		t.Fatal(err)
	}
	return path
}
