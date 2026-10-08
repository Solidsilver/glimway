package store

import (
	"bytes"
	"context"
	"database/sql"
	"fmt"
	"glimway/server/internal/rules"
	"log"
	"path/filepath"
	"strings"
	"testing"
)

func oldAccount026(t *testing.T, path string, nullOrigin bool, consistent bool) *sql.DB {
	db := newUpgradeFixture(t, path, "025_world_choice.sql", nil)
	p := rules.Profile{ID: "owner-subject", Name: "Owner", Level: 2, HP: 32, MaxHP: 50, MP: 12, MaxMP: 32, Stats: rules.Stats{}}
	exp := 5.0
	p.Exp = &exp
	xp := rules.LifetimeXP(p.Level, *p.Exp)
	if !consistent {
		xp++
	}
	state := rules.NewState()
	state.Area = "woodland"
	state.Flags = []string{"seen:retained", "seen:client-mark"}
	state.Inventory = append(state.Inventory, "beeswax-candle")
	origin := any("fresh")
	if nullOrigin {
		origin = nil
	}
	query := `INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','owner-subject','seed',1);
 INSERT INTO players(habitica_id,display_name,world_id,save_origin,created_at,last_seen_at,rev) VALUES('owner-subject','Owner','w',?,1,1,7);
 INSERT INTO progress VALUES('owner-subject',1,7,?,1);
 INSERT INTO balances VALUES('owner-subject',9,3);
 INSERT INTO sync_baselines(habitica_id,profile_json,xp_mark,verified_xp,checkpoint_json,checkpoint_at,updated_at) VALUES('owner-subject',?,0,?,?,1,1);
 INSERT INTO outcomes VALUES('owner-subject','embers:welcome','migration',1);
 INSERT INTO allowlist VALUES('owner-subject','cli',1);
 INSERT INTO warden_finds VALUES('owner-subject',100),('owner-subject',200);
 INSERT INTO storm_finds VALUES('owner-subject',100);
 INSERT INTO region_epochs(id,world_id,region_id,world_seed,generator_version,season,starts_at) VALUES('v1','w','inner-1','seed',1,'spring',1);
 INSERT INTO entity_state VALUES('v1','node:0:0:0',0,'harvested',10,'owner-subject',1);
 INSERT INTO personal_claims VALUES('v1','chest:0:0:0','owner-subject',1);
 INSERT INTO lanterns VALUES('lamp','v1','w','inner-1','owner-subject',3,4,NULL,1,NULL);
 INSERT INTO lantern_rewards VALUES('owner-subject',1,1);
 INSERT INTO ledger(habitica_id,currency,delta,earned_delta,reason,ref,created_at) VALUES('owner-subject','embers',9,3,'test','',1);`
	for _, v := range []any{origin, JSON(state), JSON(p), xp, JSON(p)} {
		literal := "NULL"
		if v != nil {
			literal = "'" + strings.ReplaceAll(fmt.Sprint(v), "'", "''") + "'"
		}
		query = strings.Replace(query, "?", literal, 1)
	}
	_, err := db.Exec(query)
	if err != nil {
		t.Fatal(err)
	}
	return db
}
func TestAccounts026NoSessionAndStateBridge027(t *testing.T) {
	for _, nullOrigin := range []bool{false, true} {
		t.Run(map[bool]string{false: "chosen", true: "unfinished-no-sessions"}[nullOrigin], func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "upgrade.sqlite")
			db := oldAccount026(t, path, nullOrigin, true)
			if err := db.Close(); err != nil {
				t.Fatal(err)
			}
			s, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			tx, err := s.DB.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			snap, err := Load(context.Background(), tx, "owner-subject")
			if err != nil {
				t.Fatal(err)
			}
			wire, err := PlayerState(context.Background(), tx, snap)
			if err != nil {
				t.Fatal(err)
			}
			if snap.ProfileSource != "habitica" || wire.Account.AccountId != "owner-subject" || snap.State.Embers != 9 || snap.State.XPEmbers != 3 {
				t.Fatal("identity or balances changed")
			}
			if nullOrigin {
				if snap.State.Area != "village" || snap.State.HP != 32 || snap.Version != 9 || snap.State.EmberXP != rules.LifetimeXP(2, 5) {
					t.Fatal("fresh checkpoint baseline", JSON(snap))
				}
			} else if snap.State.Area != "woodland" || !strings.Contains(JSON(snap.State.Flags), "seen:retained") || snap.Version != 8 {
				t.Fatal("chosen owner data changed", JSON(snap))
			}
			for _, q := range []string{"SELECT count(*) FROM region_epochs", "SELECT count(*) FROM entity_state", "SELECT count(*) FROM personal_claims", "SELECT count(*) FROM lanterns", "SELECT count(*) FROM lantern_rewards"} {
				var n int
				if err = tx.QueryRow(q).Scan(&n); err != nil || n != 0 {
					t.Fatal("v1 reset", q, n, err)
				}
			}
			for q, want := range map[string]int{"SELECT count(*) FROM warden_finds": 2, "SELECT count(*) FROM storm_finds": 1, "SELECT count(*) FROM ledger": 1, "SELECT count(*) FROM player_vitals": 1, "SELECT count(*) FROM player_place": 1, "SELECT count(*) FROM sign_ins WHERE method='habitica' AND subject='owner-subject'": 1} {
				var n int
				if err = tx.QueryRow(q).Scan(&n); err != nil || n != want {
					t.Fatal(q, n, err)
				}
			}
			if err = foreignKeysClean(tx); err != nil {
				t.Fatal(err)
			}
			if _, err = tx.Exec("INSERT INTO sign_ins VALUES('owner-subject','habitica','owner-subject',NULL,1)"); err == nil {
				t.Fatal("duplicate subject accepted")
			}
		})
	}
}
func TestAccounts026InconsistentCheckpointFallsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "fallback.sqlite")
	db := oldAccount026(t, path, true, false)
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	snap, err := Load(context.Background(), tx, "owner-subject")
	if err != nil {
		t.Fatal(err)
	}
	if snap.State.EmberXP != rules.LifetimeXP(2, 5)+1 || snap.State.HP != 32 || snap.Version != 9 {
		t.Fatal("fallback lost verified mark/profile", JSON(snap))
	}
	if err = foreignKeysClean(tx); err != nil {
		t.Fatal(err)
	}
}
func TestForeignKeysCleanAssertsRows(t *testing.T) {
	db, err := sql.Open("sqlite", ":memory:")
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	if _, err = db.Exec("CREATE TABLE parent(id TEXT PRIMARY KEY);CREATE TABLE child(id TEXT REFERENCES parent(id));INSERT INTO child VALUES('missing')"); err != nil {
		t.Fatal(err)
	}
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	if foreignKeysClean(tx) == nil {
		t.Fatal("foreign key violation ignored")
	}
}

func TestAccounts026FallbacksNeverRequirePerfectEvidence(t *testing.T) {
	for _, kind := range []string{"missing-baseline", "invalid-both", "invalid-imported", "missing-exp"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "fallback.sqlite")
			old := oldAccount026(t, path, true, true)
			queries := map[string]string{
				"missing-baseline": "DELETE FROM sync_baselines",
				"invalid-both":     "UPDATE sync_baselines SET profile_json='invalid',checkpoint_json='invalid'",
				"invalid-imported": "UPDATE sync_baselines SET profile_json='invalid'",
				"missing-exp":      "UPDATE sync_baselines SET profile_json=json_remove(profile_json,'$.exp'),checkpoint_json=json_remove(checkpoint_json,'$.exp')",
			}
			if _, err := old.Exec(queries[kind]); err != nil {
				t.Fatal(err)
			}
			old.Close()
			var logs bytes.Buffer
			previous := log.Writer()
			log.SetOutput(&logs)
			defer log.SetOutput(previous)
			s, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer s.Close()
			tx, err := s.DB.Begin()
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback()
			snap, err := Load(context.Background(), tx, "owner-subject")
			if err != nil {
				t.Fatal(err)
			}
			if snap.State.Embers != 9 || snap.State.XPEmbers != 3 || snap.Version != 9 {
				t.Fatal("fallback lost existing entitlements")
			}
			if kind == "missing-baseline" || kind == "invalid-both" {
				if snap.ImportedProfile != nil || snap.ProfileSource != "none" || !strings.Contains(logs.String(), "owner-subject fallback:") {
					t.Fatal("fallback not logged or profile retained", logs.String())
				}
			}
			if err = foreignKeysClean(tx); err != nil {
				t.Fatal(err)
			}
		})
	}
}
