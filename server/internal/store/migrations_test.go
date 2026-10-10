package store

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
)

// These deployed SQL pairs are independent literals: editing both a migration
// and history.json must still fail. New migrations may only append to this list.
var deployedMigrationHistory = []struct{ name, sha256 string }{
	{"001_core.sql", "8d251af61fac207051ee99cbdfa98b980c29a20e6216e9281152da70c534d38d"},
	{"002_fix_round.sql", "fc7c2574a6fb452bf7e86d859c0832f5d64e475307b021650f0aebce8dc26145"},
	{"003_loss_and_admission.sql", "03d7c0295dcf81caa0c670dc1c4eabf3aeef2b5426981e309856c54b30bdb457"},
	{"004_homestead_wilds.sql", "bccf874235052a7e66a94f12dd14c64b79a5d2c495c4b66f84a6d59c0802f3c7"},
	{"005_checkpoint_sessions_contract.sql", "e51bab32eef2b0f3a88d2493e26d752c8eddba81bf88f33eff0ef312de67ce8d"},
	{"006_lantern_creations.sql", "2124f9bb67d4b86135d4bfcef34a57e4e1059c5d8b3d992afb281633948ff688"},
	{"007_library_shelves.sql", "9b9c94c42bc6bf02ff5293635e6a36e9eaeab1cc69ce995a52f1f37a1ec6b225"},
	{"008_phase5.sql", "b095257a6ba64906781d119f3eec14dd9c39d95967e36440f866cd08aca6ec81"},
	{"009_mail_returns.sql", "691334b41483a1d87a215f27abb8bf4e7ba2d30f16a635b82885457e855981a9"},
	{"010_homesteads_v2.sql", "6f6c14f1c71df4ecd56d6866139c88391cf8dd301404b5fa7ff8d2716eff0785"},
	{"011_homestead_departures.sql", "6a351d0d4d3b06b147746b62f988ba6cbe76e3893a22b4f75d99bbc202f01991"},
	{"012_items.sql", "cd0fbe4233a21174fdd8fcc152281e1b3233e621255a7658ddf47522fa6ce7ef"},
	{"013_mail_instances.sql", "1c49670901a5430fb6446419662344ad889bb3062114870d7f46944fce54a894"},
	{"014_woodpile_seasoning.sql", "f532b1c1fd3547716365eab83879158582f592c63a48cea7f8da238a64fa25f8"},
	{"016_village_repairs.sql", "5ff2e84fdc1aa47366fc7b9da33aa541ed54b829aea30a0c26ca59377a050e2f"},
	{"017_warden_tools.sql", "e5eaa778f2f0da5c22eab128369e70ca0a736a8b80fd9010c19fa54c8e6dcf87"},
	{"018_warden_find_spacing.sql", "37c991042811dddd5b0a483473ea36e979f17cb65f39c2cadf99dd1093fe123b"},
	{"019_gathering.sql", "8d3c08761035dae922e0259d366c5139ad75dc5f84e635c73d3c6f668e3b5cc8"},
	{"020_gifts.sql", "3fdd183a9d63173d1c732556210c881af835605b76f598e3bd5cb772ecb4b562"},
	{"021_storm_finds.sql", "6fe650f856984afa59a53b1a96a1e780f9b45cf5eeaa6942082fe24d75046cfd"},
	{"022_party_worlds.sql", "3687da163aca2d304d403cb724582ba3944501369136be629f0e840dbf8f556e"},
	{"023_party_owned_worlds.sql", "b016f955f1cd28de8a415b342418c803bb3c1dd6eec60ce4ff803d3c1ea36e34"},
	{"024_party_admission.sql", "73350c4f225764acd62aabad30122d499c519b4686fc39e5a28f10e1e0fa7176"},
	{"025_world_choice.sql", "6604e5831add696cbd7353d7aa42e69d71bc7fb2bb609bf1d387c98962ad78e9"},
	{"026_accounts.sql", "3e7f7e5dd78e4874b54988f435ca64073bca6a3e489c2c7e47822c5b518c8055"},
	{"027_server_state.sql", "b63ad01f87910ac7d584742f533e483c920878a6a20736eb63bbcc89e731c29d"},
	{"028_story_move.sql", "cfb4aec0ba8d982306476395e5ae664d6504fd267463b025669fe514274a6d17"},
	{"029_quest_tree.sql", "1ac4d6841116fbad0b9acd83fa204524d9bac1650b84146968e5732f3e5e2b61"},
	{"030_crafts.sql", "3526f439d53c1d40ecc8d670834ee8d106d6e9394bc0bebae3d6d3d7df81a78a"},
	{"031_level_mark.sql", "ec3b602bfc0b5dbb84d79d02e9607e50fe8013a08ba7795934fd5e038880a79a"},
	{"032_purse_wardrobe.sql", "f825679bee5cdbe86e2cb0ab9c6cf1c6bde0b37dd0fe4baed3175d24fe5added"},
}

func checkDeployedHistory(history []migrationRecord) error {
	if len(history) < len(deployedMigrationHistory) {
		return fmt.Errorf("deployed migration history shortened")
	}
	for i, want := range deployedMigrationHistory {
		if history[i].Name != want.name || history[i].SHA256 != want.sha256 {
			return fmt.Errorf("deployed migration history changed: %s", want.name)
		}
	}
	return nil
}

// Integrity belongs in tests, not startup: cosmetic source edits must not prevent
// opening an already-migrated database. Registration and source metadata are
// checked here too; production reads only the bundle's names and count.
func checkMigrationIntegrity(source fs.FS) error {
	history, err := readMigrationHistory(source)
	if err != nil {
		return err
	}
	check := func(path, expected string) error {
		raw, err := fs.ReadFile(source, path)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(raw)
		if hex.EncodeToString(digest[:]) != expected {
			return fmt.Errorf("migration history checksum mismatch: %s", path)
		}
		return nil
	}
	if err := checkDeployedHistory(history); err != nil {
		return err
	}
	usedBackfills := map[string]bool{}
	for _, m := range history {
		if err := check("migrations/"+m.Name, m.SHA256); err != nil {
			return err
		}
		if m.Backfill != "" {
			if migrationBackfills[m.Backfill] == nil || usedBackfills[m.Backfill] {
				return fmt.Errorf("unregistered or duplicate backfill: %s", m.Backfill)
			}
			if err := check(m.Backfill, m.BackfillSHA256); err != nil {
				return err
			}
			usedBackfills[m.Backfill] = true
		} else if m.BackfillSHA256 != "" {
			return fmt.Errorf("backfill checksum without source: %s", m.Name)
		}
	}
	if len(usedBackfills) != len(migrationBackfills) {
		return fmt.Errorf("migration history omits a registered backfill")
	}
	return checkDeployedHistory(history)
}

func copyMigrationFS(t *testing.T) fstest.MapFS {
	t.Helper()
	out := fstest.MapFS{}
	if err := fs.WalkDir(migrations, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if !entry.IsDir() {
			raw, err := migrations.ReadFile(path)
			if err != nil {
				return err
			}
			out[path] = &fstest.MapFile{Data: raw}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	return out
}

func TestMigrationHistoryIntegrity(t *testing.T) {
	if err := checkMigrationIntegrity(migrations); err != nil {
		t.Fatal(err)
	}
}

func TestMigrationHistoryRefusals(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(fstest.MapFS, *[]migrationRecord)
		want   string
	}{
		{"missing manifest", func(f fstest.MapFS, _ *[]migrationRecord) { delete(f, "migrations/history.json") }, "file does not exist"},
		{"invalid JSON", func(f fstest.MapFS, _ *[]migrationRecord) { f["migrations/history.json"].Data = []byte("invalid") }, "invalid character"},
		{"unlisted SQL", func(f fstest.MapFS, _ *[]migrationRecord) {
			f["migrations/026_unlisted.sql"] = &fstest.MapFile{Data: []byte("SELECT 1;")}
		}, "does not match SQL files"},
		{"missing SQL", func(f fstest.MapFS, _ *[]migrationRecord) { delete(f, "migrations/001_core.sql") }, "does not match SQL files"},
		{"reordered entries", func(_ fstest.MapFS, h *[]migrationRecord) { (*h)[0], (*h)[1] = (*h)[1], (*h)[0] }, "unexpected name"},
		{"renamed entry", func(_ fstest.MapFS, h *[]migrationRecord) { (*h)[0].Name = "001_renamed.sql" }, "unexpected name"},
		{"changed SQL", func(f fstest.MapFS, _ *[]migrationRecord) {
			f["migrations/001_core.sql"].Data = append(f["migrations/001_core.sql"].Data, []byte("-- changed\n")...)
		}, "checksum mismatch: migrations/001_core.sql"},
		{"valid JSON changed hash", func(_ fstest.MapFS, h *[]migrationRecord) { (*h)[0].SHA256 = strings.Repeat("0", 64) }, "deployed migration history changed"},
		{"coordinated SQL and hash edit", func(f fstest.MapFS, h *[]migrationRecord) {
			raw := append(f["migrations/001_core.sql"].Data, []byte("-- changed\n")...)
			f["migrations/001_core.sql"].Data = raw
			digest := sha256.Sum256(raw)
			(*h)[0].SHA256 = hex.EncodeToString(digest[:])
		}, "deployed migration history changed"},
		{"changed backfill", func(f fstest.MapFS, _ *[]migrationRecord) {
			f["migration_003_backfill.go"].Data = append(f["migration_003_backfill.go"].Data, []byte("// changed\n")...)
		}, "checksum mismatch: migration_003_backfill.go"},
		{"missing backfill source", func(f fstest.MapFS, _ *[]migrationRecord) { delete(f, "migration_003_backfill.go") }, "file does not exist"},
		{"backfill hash without source", func(_ fstest.MapFS, h *[]migrationRecord) { (*h)[0].BackfillSHA256 = "hash" }, "backfill checksum without source"},
		{"unregistered backfill", func(_ fstest.MapFS, h *[]migrationRecord) { (*h)[2].Backfill = "unknown.go" }, "unregistered or duplicate backfill"},
		{"duplicate backfill", func(_ fstest.MapFS, h *[]migrationRecord) {
			(*h)[3].Backfill = (*h)[2].Backfill
			(*h)[3].BackfillSHA256 = (*h)[2].BackfillSHA256
		}, "unregistered or duplicate backfill"},
		{"shortened deployed history", func(f fstest.MapFS, h *[]migrationRecord) {
			delete(f, "migrations/"+(*h)[len(*h)-1].Name)
			*h = (*h)[:len(*h)-1]
		}, "deployed migration history shortened"},
		{"omitted registered backfill", func(_ fstest.MapFS, h *[]migrationRecord) { (*h)[2].Backfill = ""; (*h)[2].BackfillSHA256 = "" }, "omits a registered backfill"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			source := copyMigrationFS(t)
			history, err := readMigrationHistory(source)
			if err != nil {
				t.Fatal(err)
			}
			tt.mutate(source, &history)
			if tt.name != "missing manifest" && tt.name != "invalid JSON" {
				raw, err := json.Marshal(history)
				if err != nil {
					t.Fatal(err)
				}
				source["migrations/history.json"].Data = raw
			}
			if err := checkMigrationIntegrity(source); err == nil || !strings.Contains(err.Error(), tt.want) {
				t.Fatalf("got %v, want %q", err, tt.want)
			}
		})
	}
}

func TestMigrationStartupIgnoresContentHashes(t *testing.T) {
	source := copyMigrationFS(t)
	for _, path := range []string{"migrations/001_core.sql", "migration_003_backfill.go"} {
		source[path].Data = append(source[path].Data, []byte("// cosmetic edit\n")...)
	}
	if _, err := readMigrationHistory(source); err != nil {
		t.Fatal(err)
	}
}

func TestUpgradeFixtureRunsRegisteredBackfill(t *testing.T) {
	db := newUpgradeFixture(t, filepath.Join(t.TempDir(), "loss.sqlite"), "003_loss_and_admission.sql", func(name string, tx *sql.Tx) {
		if name != "003_loss_and_admission.sql" {
			return
		}
		if _, err := tx.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','s',0);
INSERT INTO players(habitica_id,display_name,world_id,created_at,last_seen_at) VALUES('alice','Hero','w',0,0);
INSERT INTO sync_baselines(habitica_id,verified_xp,checkpoint_json,checkpoint_at,updated_at) VALUES('alice',123,'{"level":8}',40,40);`); err != nil {
			t.Fatal(err)
		}
	})
	var level, xp, at int
	if err := db.QueryRow("SELECT loss_level,loss_xp,loss_at FROM sync_baselines WHERE habitica_id='alice'").Scan(&level, &xp, &at); err != nil || level != 8 || xp != 123 || at != 40 {
		t.Fatal("registered backfill omitted", level, xp, at, err)
	}
}

func TestPre010ResetPreservesCarriedGoodsAuditAndReplay(t *testing.T) {
	path := filepath.Join(t.TempDir(), "reset.sqlite")
	old := newUpgradeFixture(t, path, "009_mail_returns.sql", nil)
	replay := `{"state":{},"rev":7,"displayName":"Hero"}`
	if _, err := old.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','s',0);
INSERT INTO players(habitica_id,display_name,world_id,created_at,last_seen_at,rev) VALUES('alice','Hero','w',1,100,7),('bob','Bob','w',1,100,2);
INSERT INTO homesteads VALUES('alice','w',0,1);
INSERT INTO homestead_items(id,habitica_id,item_def,location) VALUES('pack-chair','alice','reading-chair','inventory'),('parcel-chair','alice','reading-chair','mail');
INSERT INTO home_storage VALUES('alice','material','timber',20);
INSERT INTO materials VALUES('alice','timber',40);
INSERT INTO inventory VALUES('alice','beeswax-candle',3);
INSERT INTO ledger(habitica_id,currency,delta,earned_delta,reason,ref,created_at) VALUES('alice','embers',12,0,'test','reset',1);
INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,sent_at) VALUES('decoration','w','alice','bob','decoration','reading-chair',1,'["parcel-chair"]',1),('stack','w','alice','bob','material','timber',5,'[]',1);`); err != nil {
		t.Fatal(err)
	}
	if _, err := old.Exec("INSERT INTO idempotency VALUES('alice','spend','reset','hash',?,1)", replay); err != nil {
		t.Fatal(err)
	}
	markFixtureOrigins(t, old)
	old.Close()
	upgraded, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer upgraded.Close()
	for query, want := range map[string]int{
		"SELECT count(*) FROM homesteads":                                                                   0,
		"SELECT count(*) FROM homestead_items":                                                              0,
		"SELECT count(*) FROM item_stacks WHERE location='storage'":                                         0,
		"SELECT count(*) FROM mail WHERE kind='decoration'":                                                 0,
		"SELECT count(*) FROM mail WHERE id='stack'":                                                        1,
		"SELECT qty FROM item_stacks WHERE location='pack' AND owner='alice' AND item_def='timber'":         40,
		"SELECT qty FROM item_stacks WHERE location='pack' AND owner='alice' AND item_def='beeswax-candle'": 3,
		"SELECT SUM(delta) FROM ledger WHERE account_id='alice' AND currency='embers'":                      12,
		"SELECT version FROM players WHERE account_id='alice'":                                              7,
		"SELECT last_seen_at FROM players WHERE account_id='alice'":                                         100,
	} {
		var got int
		if err = upgraded.DB.QueryRow(query).Scan(&got); err != nil || got != want {
			t.Fatalf("%s: %d, want %d (%v)", query, got, want, err)
		}
	}
	var replayCount int
	if err = upgraded.DB.QueryRow("SELECT count(*) FROM idempotency").Scan(&replayCount); err != nil || replayCount != 0 {
		t.Fatal("old replay survived contract reset", replayCount, err)
	}
	rows, err := upgraded.DB.Query("PRAGMA foreign_key_check")
	if err != nil {
		t.Fatal(err)
	}
	if rows.Next() {
		t.Fatal("invalid foreign keys after reset")
	}
	if err = rows.Err(); err != nil {
		t.Fatal(err)
	}
	rows.Close()
	fresh, err := Open(filepath.Join(t.TempDir(), "fresh.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer fresh.Close()
	schema := func(db *sql.DB) []string {
		rows, err := db.Query("SELECT type,name,COALESCE(sql,'') FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")
		if err != nil {
			t.Fatal(err)
		}
		defer rows.Close()
		var out []string
		for rows.Next() {
			var kind, name, sql string
			if err = rows.Scan(&kind, &name, &sql); err != nil {
				t.Fatal(err)
			}
			out = append(out, kind+":"+name+":"+strings.Join(strings.Fields(sql), " "))
		}
		if err = rows.Err(); err != nil {
			t.Fatal(err)
		}
		return out
	}
	if a, b := schema(upgraded.DB), schema(fresh.DB); !reflect.DeepEqual(a, b) {
		t.Fatal("fresh and upgraded schemas differ", a, b)
	}
}
