package store

import (
	"context"
	"path/filepath"
	"testing"
)

func TestWALMigrationsBackupAndAdmin(t *testing.T) {
	path := filepath.Join(t.TempDir(), "db.sqlite")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	var mode string
	if err = s.DB.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatal("WAL missing")
	}
	if s.DB.Stats().MaxOpenConnections != 1 {
		t.Fatal("not one writer")
	}
	if err = s.Allow(context.Background(), "alice", true); err != nil {
		t.Fatal(err)
	}
	if _, err = s.Invite(context.Background(), "nonexistent"); err == nil {
		t.Fatal("invalid invite world allowed")
	}
	code, err := s.Invite(context.Background(), "")
	if err != nil {
		t.Fatal(err)
	}
	var hash string
	if err = s.DB.QueryRow("SELECT code_hash FROM invites").Scan(&hash); err != nil || hash != Hash(code) {
		t.Fatal("invite stored raw")
	}
	backup := filepath.Join(t.TempDir(), "backup.sqlite")
	if err = s.Backup(context.Background(), backup); err != nil {
		t.Fatal(err)
	}
	if err = s.Backup(context.Background(), backup); err == nil {
		t.Fatal("overwrote existing backup")
	}
	s.Close()
	s, err = Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	history, err := migrationHistory()
	if err != nil {
		t.Fatal(err)
	}
	rows, err := s.DB.Query("SELECT name FROM schema_migrations ORDER BY name")
	if err != nil {
		t.Fatal(err)
	}
	var applied []string
	for rows.Next() {
		var name string
		if err = rows.Scan(&name); err != nil {
			t.Fatal(err)
		}
		applied = append(applied, name)
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	if len(applied) != len(history) {
		t.Fatal("migration rerun", applied)
	}
	for i, m := range history {
		if applied[i] != m.Name {
			t.Fatal("migration history", applied)
		}
	}
	if err = s.Allow(context.Background(), "alice", false); err != nil {
		t.Fatal(err)
	}
}
