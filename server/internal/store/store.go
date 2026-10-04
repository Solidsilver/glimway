// Package store owns the single SQLite connection and ordered embedded migrations.
package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"embed"
	"encoding/hex"
	"encoding/json"
	"fingersnap/server/internal/rules"
	"fmt"
	_ "modernc.org/sqlite"
	"os"
	"path/filepath"
	"strings"
	"time"
)

//go:embed migrations/*.sql
var migrations embed.FS

type Store struct{ DB *sql.DB }

func Open(path string) (*Store, error) {
	if path != ":memory:" {
		if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return nil, err
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
		if err != nil {
			return nil, err
		}
		f.Close()
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	fail := func(err error) (*Store, error) { db.Close(); return nil, err }
	for _, q := range []string{"PRAGMA journal_mode=WAL", "PRAGMA foreign_keys=ON", "PRAGMA busy_timeout=10000", "PRAGMA synchronous=FULL", "CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"} {
		if _, err = db.Exec(q); err != nil {
			return fail(err)
		}
	}
	files, err := migrations.ReadDir("migrations")
	if err != nil {
		return fail(err)
	}
	for _, f := range files {
		var exists int
		if err = db.QueryRow("SELECT count(*) FROM schema_migrations WHERE name=?", f.Name()).Scan(&exists); err != nil {
			return fail(err)
		}
		if exists > 0 {
			continue
		}
		b, err := migrations.ReadFile("migrations/" + f.Name())
		if err != nil {
			return fail(err)
		}
		tx, err := db.Begin()
		if err != nil {
			return fail(err)
		}
		if _, err = tx.Exec(string(b)); err == nil {
			_, err = tx.Exec("INSERT INTO schema_migrations VALUES(?,?)", f.Name(), time.Now().Unix())
		}
		if err != nil {
			tx.Rollback()
			return fail(err)
		}
		if err = tx.Commit(); err != nil {
			return fail(err)
		}
	}
	return &Store{db}, nil
}
func (s *Store) Close() error { return s.DB.Close() }
func Random() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}
func Hash(s string) string { v := sha256.Sum256([]byte(s)); return hex.EncodeToString(v[:]) }
func JSON(v any) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}
func (s *Store) Backup(ctx context.Context, path string) error {
	path, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	// Refuse existing files; SQLite VACUUM INTO itself is not a replace operation.
	if _, err = os.Stat(path); err == nil {
		return fmt.Errorf("backup destination exists")
	} else if !os.IsNotExist(err) {
		return err
	}
	_, err = s.DB.ExecContext(ctx, "VACUUM INTO ?", path)
	if err != nil {
		return err
	}
	return os.Chmod(path, 0600)
}
func (s *Store) Allow(ctx context.Context, id string, add bool) error {
	if id == "" || len(id) > 128 {
		return fmt.Errorf("invalid account id")
	}
	if add {
		_, err := s.DB.ExecContext(ctx, "INSERT OR IGNORE INTO allowlist VALUES(?,?,?)", id, "cli", time.Now().Unix())
		return err
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "DELETE FROM allowlist WHERE habitica_id=?", id); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM sessions WHERE habitica_id=?", id); err != nil {
		return err
	}
	return tx.Commit()
}
func (s *Store) Invite(ctx context.Context, world string) (string, error) {
	code, err := Random()
	if err != nil {
		return "", err
	}
	var w any
	if strings.TrimSpace(world) != "" {
		w = world
	}
	_, err = s.DB.ExecContext(ctx, "INSERT INTO invites(code_hash,created_by,world_id,created_at) VALUES(?,?,?,?)", Hash(code), "cli", w, time.Now().Unix())
	return code, err
}

type Snapshot struct {
	State           rules.State    `json:"state"`
	Rev             int64          `json:"rev"`
	VitalsSource    string         `json:"vitalsSource"`
	ImportedProfile *rules.Profile `json:"importedProfile,omitempty"`
	HabiticaID      string         `json:"habiticaId"`
	WorldID         string         `json:"worldId"`
	SaveOrigin      *string        `json:"saveOrigin"`
	Pending         int            `json:"pending"`
	VerifiedXP      float64        `json:"verifiedXp"`
	Flagged         bool           `json:"flagged"`
	Checkpoint      rules.Profile  `json:"-"`
	LeaseID         sql.NullString `json:"-"`
	LeaseClient     sql.NullString `json:"-"`
	LeaseSeen       sql.NullInt64  `json:"-"`
}

func Load(ctx context.Context, tx *sql.Tx, id string) (Snapshot, error) {
	var s Snapshot
	var doc string
	var baseline sql.NullString
	var origin sql.NullString
	var flagged sql.NullInt64
	var checkpoint string
	err := tx.QueryRowContext(ctx, `SELECT p.habitica_id,p.world_id,p.rev,p.save_origin,p.flagged_at,p.lease_id,p.lease_client,p.lease_seen_at,g.doc_json,b.embers,b.xp_embers,x.profile_json,x.xp_mark,x.pending,x.verified_xp,x.checkpoint_json FROM players p JOIN progress g USING(habitica_id) JOIN balances b USING(habitica_id) JOIN sync_baselines x USING(habitica_id) WHERE p.habitica_id=?`, id).Scan(&s.HabiticaID, &s.WorldID, &s.Rev, &origin, &flagged, &s.LeaseID, &s.LeaseClient, &s.LeaseSeen, &doc, &s.State.Embers, &s.State.XPEmbers, &baseline, &s.State.EmberXP, &s.Pending, &s.VerifiedXP, &checkpoint)
	if err != nil {
		return s, err
	}
	embers, xp, mark := s.State.Embers, s.State.XPEmbers, s.State.EmberXP
	if err = json.Unmarshal([]byte(doc), &s.State); err != nil {
		return s, err
	}
	s.State.Embers = embers
	s.State.XPEmbers = xp
	s.State.EmberXP = mark
	s.Flagged = flagged.Valid
	if origin.Valid {
		s.SaveOrigin = &origin.String
	}
	if err = json.Unmarshal([]byte(checkpoint), &s.Checkpoint); err != nil {
		return s, err
	}
	s.VitalsSource = "demo"
	if baseline.Valid {
		var p rules.Profile
		if err = json.Unmarshal([]byte(baseline.String), &p); err != nil {
			return s, err
		}
		s.ImportedProfile = &p
		s.VitalsSource = "imported"
		s.State.MaxHP = p.MaxHP
		s.State.MaxMana = p.MaxMP
	}
	rows, err := tx.QueryContext(ctx, "SELECT outcome_id FROM outcomes WHERE habitica_id=? ORDER BY at,outcome_id", id)
	if err != nil {
		return s, err
	}
	for rows.Next() {
		var v string
		if err = rows.Scan(&v); err != nil {
			rows.Close()
			return s, err
		}
		if rules.EconomyFlag(v) {
			s.State.Flags = rules.AddUnique(s.State.Flags, v)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return s, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT item_def FROM inventory WHERE habitica_id=? ORDER BY item_def", id)
	if err != nil {
		return s, err
	}
	for rows.Next() {
		var v string
		if err = rows.Scan(&v); err != nil {
			rows.Close()
			return s, err
		}
		s.State.Inventory = rules.AddUnique(s.State.Inventory, v)
	}
	err = rows.Err()
	rows.Close()
	return s, err
}
func Outcome(ctx context.Context, tx *sql.Tx, id, outcome, reason string, now int64) (bool, error) {
	res, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO outcomes VALUES(?,?,?,?)", id, outcome, reason, now)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n == 1, err
}
func Credit(ctx context.Context, tx *sql.Tx, s *Snapshot, n, earned int, reason, ref string, xp *float64, now int64) error {
	s.State.Embers += n
	s.State.XPEmbers += earned
	_, err := tx.ExecContext(ctx, "INSERT INTO ledger(habitica_id,currency,delta,earned_delta,reason,ref,reported_xp,created_at) VALUES(?,'embers',?,?,?,?,?,?)", s.HabiticaID, n, earned, reason, ref, xp, now)
	return err
}
func Persist(ctx context.Context, tx *sql.Tx, s *Snapshot, now int64) error {
	s.Rev++
	// Store only writable progress; server authority stays in normalized tables.
	doc := s.State
	doc.Embers = 0
	doc.XPEmbers = 0
	doc.EmberXP = 0
	doc.Flags = []string{}
	for _, v := range s.State.Flags {
		if !rules.EconomyFlag(v) {
			doc.Flags = append(doc.Flags, v)
		}
	}
	doc.Inventory = []string{}
	for _, v := range s.State.Inventory {
		if v != rules.E.CharmItem {
			doc.Inventory = append(doc.Inventory, v)
		}
	}
	var p any
	if s.ImportedProfile != nil {
		p = JSON(s.ImportedProfile)
	}
	for _, q := range []struct {
		sql  string
		args []any
	}{
		{"UPDATE players SET rev=?,last_seen_at=? WHERE habitica_id=?", []any{s.Rev, now, s.HabiticaID}},
		{"UPDATE progress SET rev=?,doc_json=?,updated_at=? WHERE habitica_id=?", []any{s.Rev, JSON(doc), now, s.HabiticaID}},
		{"UPDATE balances SET embers=?,xp_embers=? WHERE habitica_id=?", []any{s.State.Embers, s.State.XPEmbers, s.HabiticaID}},
		{"UPDATE sync_baselines SET profile_json=?,xp_mark=?,pending=?,updated_at=? WHERE habitica_id=?", []any{p, s.State.EmberXP, s.Pending, now, s.HabiticaID}},
	} {
		if _, err := tx.ExecContext(ctx, q.sql, q.args...); err != nil {
			return err
		}
	}
	return nil
}
