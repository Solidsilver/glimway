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
	var n int
	if err = s.DB.QueryRow("SELECT count(*) FROM schema_migrations").Scan(&n); err != nil || n != 8 {
		t.Fatal("migration rerun")
	}
	if err = s.Allow(context.Background(), "alice", false); err != nil {
		t.Fatal(err)
	}
}
