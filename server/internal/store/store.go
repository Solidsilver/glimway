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
	"errors"
	"fingersnap/content"
	"fingersnap/server/internal/rules"
	"fmt"
	"modernc.org/sqlite"
	"net/url"
	"os"
	"path/filepath"
	"slices"
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
	dsn := path
	if path != ":memory:" {
		abs, err := filepath.Abs(path)
		if err != nil {
			return nil, err
		}
		dsn = (&url.URL{Scheme: "file", Path: abs}).String()
	}
	// Apply timeout before WAL setup; CLI and service may open concurrently.
	dsn += "?_txlock=immediate&_pragma=busy_timeout(10000)&_pragma=foreign_keys(ON)&_pragma=synchronous(FULL)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	fail := func(err error) (*Store, error) { db.Close(); return nil, err }
	if err = configureWAL(db); err != nil {
		return fail(err)
	}
	if err = migrate(db); err != nil {
		return fail(err)
	}
	return &Store{db}, nil
}

// Switching a fresh database into WAL may report BUSY without waiting for
// busy_timeout when two openers both need the header lock. Retry that setup
// only, bounded by the same ten-second startup budget.
func configureWAL(db *sql.DB) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for {
		_, err := db.ExecContext(ctx, "PRAGMA journal_mode=WAL")
		if err == nil {
			return nil
		}
		var busy *sqlite.Error
		if !errors.As(err, &busy) || (busy.Code()&255 != 5 && busy.Code()&255 != 6) {
			return err
		}
		timer := time.NewTimer(20 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return err
		case <-timer.C:
		}
	}
}

// Hold an immediate transaction before both the schema check and each change.
func migrate(db *sql.DB) error {
	tx, err := db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err = tx.Exec("CREATE TABLE IF NOT EXISTS schema_migrations(name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)"); err != nil {
		return err
	}
	files, err := migrations.ReadDir("migrations")
	if err != nil {
		return err
	}
	// Migrations apply in name order, once each. A pending one that sorts
	// before the newest applied one would run against tables that later
	// migrations already reshaped (or dropped) on upgraded databases, though
	// a fresh database runs it in order: refuse to start instead. New
	// migrations always take the next number above the current highest.
	var newest string
	if err = tx.QueryRow("SELECT COALESCE(MAX(name),'') FROM schema_migrations").Scan(&newest); err != nil {
		return err
	}
	for _, f := range files {
		var applied int
		if err = tx.QueryRow("SELECT count(*) FROM schema_migrations WHERE name=?", f.Name()).Scan(&applied); err != nil {
			return err
		}
		if applied == 0 && f.Name() < newest {
			return fmt.Errorf("out-of-order migration %s after %s: renumber it above the newest applied migration", f.Name(), newest)
		}
	}
	for _, f := range files {
		var exists int
		if err = tx.QueryRow("SELECT count(*) FROM schema_migrations WHERE name=?", f.Name()).Scan(&exists); err != nil {
			return err
		}
		if exists > 0 {
			continue
		}
		b, err := migrations.ReadFile("migrations/" + f.Name())
		if err != nil {
			return err
		}
		if _, err = tx.Exec(string(b)); err != nil {
			return err
		}
		if f.Name() == "003_loss_and_admission.sql" {
			if err = initializeLossReferences(tx); err != nil {
				return err
			}
		}
		if _, err = tx.Exec("INSERT INTO schema_migrations VALUES(?,?)", f.Name(), time.Now().Unix()); err != nil {
			return err
		}
	}
	return tx.Commit()
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
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := time.Now().Unix()
	if add {
		// An account let in through a party becomes the operator's own: it
		// may then open a party's world (docs/home-server.md).
		if _, err = tx.ExecContext(ctx, "INSERT INTO allowlist VALUES(?,?,?) ON CONFLICT(habitica_id) DO UPDATE SET added_by='cli',added_at=excluded.added_at WHERE added_by='party'", id, "cli", now); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM access_removals WHERE habitica_id=?", id); err != nil {
			return err
		}
	} else {
		for _, q := range []string{
			"DELETE FROM allowlist WHERE habitica_id=?",
			"DELETE FROM sessions WHERE habitica_id=?",
			"DELETE FROM pending_sessions WHERE habitica_id=?",
		} {
			if _, err = tx.ExecContext(ctx, q, id); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO access_removals VALUES(?,?) ON CONFLICT(habitica_id) DO UPDATE SET removed_at=excluded.removed_at", id, now); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE invites SET revoked_at=COALESCE(revoked_at,?) WHERE created_by=? AND used_by IS NULL", now, id); err != nil {
			return err
		}
		// Return all of this recipient's unclaimed goods in the same transaction
		// as removal, including any legacy backlog beyond current admission caps.
		for {
			n, err := returnMailBatch(ctx, tx, now, "m.to_id=? AND m.kind!='thanks'", []any{id})
			if err != nil {
				return err
			}
			if n == 0 {
				break
			}
		}
	}
	return tx.Commit()
}
func (s *Store) Invite(ctx context.Context, world string) (string, error) {
	code, err := InviteCode()
	if err != nil {
		return "", err
	}
	var w any
	if strings.TrimSpace(world) != "" {
		w = world
		// A party's world is for that party only: no code names it.
		var party int
		if err = s.DB.QueryRowContext(ctx, "SELECT count(*) FROM worlds WHERE id=? AND owner_id=''", world).Scan(&party); err != nil {
			return "", err
		}
		if party > 0 {
			return "", fmt.Errorf("a party's world takes no invite codes")
		}
	}
	_, err = s.DB.ExecContext(ctx, "INSERT INTO invites(code_hash,created_by,world_id,created_at,expires_at) VALUES(?,?,?,?,?)", Hash(code), "cli", w, time.Now().Unix(), time.Now().Add(30*24*time.Hour).Unix())
	return code, err
}

type Snapshot struct {
	State              rules.State         `json:"state"`
	Rev                int64               `json:"rev"`
	VitalsSource       string              `json:"vitalsSource"`
	ImportedProfile    *rules.Profile      `json:"importedProfile,omitempty"`
	HabiticaID         string              `json:"habiticaId"`
	DisplayName        string              `json:"displayName"`
	HabiticaPartyID    *string             `json:"habiticaPartyId"`
	WorldID            string              `json:"worldId"`
	SaveOrigin         *string             `json:"saveOrigin"`
	Pending            int                 `json:"pending"`
	VerifiedXP         float64             `json:"verifiedXp"`
	Flagged            bool                `json:"flagged"`
	Checkpoint         rules.Profile       `json:"-"`
	CheckpointAt       int64               `json:"-"`
	CheckpointLedgerID int64               `json:"-"`
	LossReference      rules.LossReference `json:"-"`
	LossAt             int64               `json:"-"`
	VerifiedHighLevel  float64             `json:"-"`
	LeaseID            sql.NullString      `json:"-"`
	LeaseClient        sql.NullString      `json:"-"`
	LeaseSeen          sql.NullInt64       `json:"-"`
}

func Load(ctx context.Context, tx *sql.Tx, id string) (Snapshot, error) {
	var s Snapshot
	var doc string
	var baseline sql.NullString
	var origin sql.NullString
	var flagged sql.NullInt64
	var checkpoint string
	err := tx.QueryRowContext(ctx, `SELECT p.habitica_id,p.display_name,p.world_id,p.habitica_party_id,p.rev,p.save_origin,p.flagged_at,p.lease_id,p.lease_client,p.lease_seen_at,g.doc_json,b.embers,b.xp_embers,x.profile_json,x.xp_mark,x.pending,x.verified_xp,x.checkpoint_json,x.checkpoint_at,x.loss_level,x.loss_xp,x.loss_at,x.verified_high_level,x.checkpoint_ledger_id FROM players p JOIN progress g USING(habitica_id) JOIN balances b USING(habitica_id) JOIN sync_baselines x USING(habitica_id) WHERE p.habitica_id=?`, id).Scan(&s.HabiticaID, &s.DisplayName, &s.WorldID, &s.HabiticaPartyID, &s.Rev, &origin, &flagged, &s.LeaseID, &s.LeaseClient, &s.LeaseSeen, &doc, &s.State.Embers, &s.State.XPEmbers, &baseline, &s.State.EmberXP, &s.Pending, &s.VerifiedXP, &checkpoint, &s.CheckpointAt, &s.LossReference.Level, &s.LossReference.XP, &s.LossAt, &s.VerifiedHighLevel, &s.CheckpointLedgerID)
	if err != nil {
		return s, err
	}
	embers, xp, mark := s.State.Embers, s.State.XPEmbers, s.State.EmberXP
	if err = json.Unmarshal([]byte(doc), &s.State); err != nil {
		return s, err
	}
	s.State.Inventory = questInventory(s.State.Inventory)
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
	items, err := PackItems(ctx, tx, id)
	for _, v := range items {
		s.State.Inventory = rules.AddUnique(s.State.Inventory, v)
	}
	return s, err
}

// PackItems: the carried items that join the save's inventory list, every
// stack in the pack except materials (which the client counts on their own).
func PackItems(ctx context.Context, tx *sql.Tx, id string) ([]string, error) {
	rows, err := tx.QueryContext(ctx, "SELECT DISTINCT item_def FROM item_stacks WHERE location='pack' AND owner=? ORDER BY item_def", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var v string
		if err = rows.Scan(&v); err != nil {
			return nil, err
		}
		if d, ok := content.ItemFor(v); ok && d.Kind != "material" {
			out = append(out, v)
		}
	}
	return out, rows.Err()
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
	doc.Inventory = questInventory(s.State.Inventory)
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

// Legacy documents may contain loot copied before inventory was normalized.
// Filter on both read and write so revoking a table row takes effect immediately.
func questInventory(items []string) []string {
	out := []string{}
	for _, id := range items {
		if slices.Contains(rules.QuestItems, id) {
			out = rules.AddUnique(out, id)
		}
	}
	return out
}
