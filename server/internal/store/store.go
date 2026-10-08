// Package store owns the single SQLite connection and ordered embedded migrations.
package store

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"glimway/content"
	"glimway/server/internal/profile"
	"glimway/server/internal/rules"
	"modernc.org/sqlite"
	"net/url"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
)

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
		return fmt.Errorf("invalid Habitica subject")
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
			"DELETE FROM sessions WHERE account_id IN (SELECT account_id FROM sign_ins WHERE method='habitica' AND subject=?)",
			"DELETE FROM pending_sessions WHERE habitica_id=?",
		} {
			if _, err = tx.ExecContext(ctx, q, id); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO access_removals VALUES(?,?) ON CONFLICT(habitica_id) DO UPDATE SET removed_at=excluded.removed_at", id, now); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE invites SET revoked_at=COALESCE(revoked_at,?) WHERE created_by IN (SELECT account_id FROM sign_ins WHERE method='habitica' AND subject=?) AND used_by IS NULL", now, id); err != nil {
			return err
		}
		// Return all of this recipient's unclaimed goods in the same transaction
		// as removal, including any legacy backlog beyond current admission caps.
		for {
			n, err := returnMailBatch(ctx, tx, now, "m.to_id IN (SELECT account_id FROM sign_ins WHERE method='habitica' AND subject=?) AND m.kind!='thanks'", []any{id})
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
	// Explicit server writes, including refills whose numeric value is unchanged.
	VitalsWritten      bool                `json:"-"`
	PlaceWritten       bool                `json:"-"`
	State              rules.State         `json:"state"`
	Version            int64               `json:"version"`
	VitalsSource       string              `json:"vitalsSource"`
	ImportedProfile    *rules.Profile      `json:"importedProfile,omitempty"`
	AccountID          string              `json:"accountId"`
	DisplayName        string              `json:"displayName"`
	HabiticaPartyID    *string             `json:"habiticaPartyId"`
	WorldID            string              `json:"worldId"`
	ProfileSource      string              `json:"profileSource"`
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
	var flagged sql.NullInt64
	var checkpoint string
	err := tx.QueryRowContext(ctx, `SELECT p.account_id,p.display_name,p.world_id,p.habitica_party_id,p.version,p.profile_source,p.flagged_at,p.lease_id,p.lease_client,p.lease_seen_at,g.doc_json,b.embers,b.xp_embers,x.xp_mark,x.pending,x.verified_xp,x.checkpoint_json,x.checkpoint_at,x.loss_level,x.loss_xp,x.loss_at,x.verified_high_level,x.checkpoint_ledger_id FROM players p JOIN progress g USING(account_id) JOIN balances b USING(account_id) JOIN sync_baselines x USING(account_id) WHERE p.account_id=?`, id).Scan(&s.AccountID, &s.DisplayName, &s.WorldID, &s.HabiticaPartyID, &s.Version, &s.ProfileSource, &flagged, &s.LeaseID, &s.LeaseClient, &s.LeaseSeen, &doc, &s.State.Embers, &s.State.XPEmbers, &s.State.EmberXP, &s.Pending, &s.VerifiedXP, &checkpoint, &s.CheckpointAt, &s.LossReference.Level, &s.LossReference.XP, &s.LossAt, &s.VerifiedHighLevel, &s.CheckpointLedgerID)
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
	if err = json.Unmarshal([]byte(checkpoint), &s.Checkpoint); err != nil {
		return s, err
	}
	s.ImportedProfile, err = profile.For(ctx, tx, profile.Account{ID: id, Source: s.ProfileSource})
	if err != nil {
		return s, err
	}
	s.VitalsSource = "demo"
	if s.ImportedProfile != nil {
		s.VitalsSource = "imported"
	}
	if p := s.ImportedProfile; p != nil {
		s.State.MaxHP = p.MaxHP
		s.State.MaxMana = p.MaxMP
	}
	rows, err := tx.QueryContext(ctx, "SELECT outcome_id FROM outcomes WHERE account_id=? ORDER BY at,outcome_id", id)
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
	_, err := tx.ExecContext(ctx, "INSERT INTO ledger(account_id,currency,delta,earned_delta,reason,ref,reported_xp,created_at) VALUES(?,'embers',?,?,?,?,?,?)", s.AccountID, n, earned, reason, ref, xp, now)
	return err
}
func Persist(ctx context.Context, tx *sql.Tx, s *Snapshot, now int64) error {
	// The bridge detects legacy numeric changes; B sets VitalsWritten for every
	// server refill/write and uses its report path for client damage/casts.
	var hp, mana float64
	err := tx.QueryRowContext(ctx, "SELECT hp,mana FROM player_vitals WHERE account_id=?", s.AccountID).Scan(&hp, &mana)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	writeVitals := s.VitalsWritten || err == sql.ErrNoRows || hp != s.State.HP || mana != s.State.Mana
	if err := BumpVersion(ctx, tx, s); err != nil {
		return err
	}
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
		{"UPDATE players SET last_seen_at=? WHERE account_id=?", []any{now, s.AccountID}},
		{"UPDATE progress SET rev=?,doc_json=?,updated_at=? WHERE account_id=?", []any{s.Version, JSON(doc), now, s.AccountID}},
		{"UPDATE balances SET embers=?,xp_embers=? WHERE account_id=?", []any{s.State.Embers, s.State.XPEmbers, s.AccountID}},
		{"UPDATE sync_baselines SET profile_json=?,xp_mark=?,pending=?,updated_at=? WHERE account_id=?", []any{p, s.State.EmberXP, s.Pending, now, s.AccountID}},
	} {
		if _, err := tx.ExecContext(ctx, q.sql, q.args...); err != nil {
			return err
		}
	}
	// Only server vitals writes advance the combat watermark and budget.
	if writeVitals {
		if _, err := tx.ExecContext(ctx, `INSERT INTO player_vitals(account_id,hp,mana,vitals_at,vitals_set_version,cast_ready_at) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET hp=excluded.hp,mana=excluded.mana,vitals_at=excluded.vitals_at,vitals_set_version=excluded.vitals_set_version,cast_ready_at=MAX(player_vitals.cast_ready_at,excluded.cast_ready_at)`, s.AccountID, s.State.HP, s.State.Mana, now, s.Version, now); err != nil {
			return err
		}
	}
	placeVersion := int64(0)
	if s.PlaceWritten {
		placeVersion = s.Version
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO player_place(account_id,area,x,y,place_set_version) VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET area=excluded.area,x=excluded.x,y=excluded.y,place_set_version=MAX(player_place.place_set_version,excluded.place_set_version)`, s.AccountID, s.State.Area, s.State.Position.X, s.State.Position.Y, placeVersion); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE players SET play_seconds=? WHERE account_id=?", s.State.PlaySeconds, s.AccountID); err != nil {
		return err
	}
	if s.State.Quest != "new" {
		if _, err := tx.ExecContext(ctx, `INSERT INTO quest_progress VALUES(?,'lantern-road',?) ON CONFLICT(account_id,quest) DO UPDATE SET step=excluded.step`, s.AccountID, s.State.Quest); err != nil {
			return err
		}
	}
	for _, mark := range s.State.Flags {
		if _, err := tx.ExecContext(ctx, `INSERT OR IGNORE INTO story_marks VALUES(?,?,'server',?)`, s.AccountID, mark, now); err != nil {
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
