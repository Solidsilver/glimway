package store

import (
	"database/sql"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"testing/fstest"
)

func TestMigrationHistoryRejectsChangedSources(t *testing.T) {
	for _, name := range []string{"migrations/001_core.sql", "migration_003_backfill.go", "migrations/history.json"} {
		t.Run(name, func(t *testing.T) {
			copyFS := fstest.MapFS{}
			err := fs.WalkDir(migrations, ".", func(path string, entry fs.DirEntry, err error) error {
				if err != nil {
					return err
				}
				if !entry.IsDir() {
					b, err := migrations.ReadFile(path)
					if err != nil {
						return err
					}
					copyFS[path] = &fstest.MapFile{Data: b}
				}
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			copyFS[name].Data = append(copyFS[name].Data, []byte("\nchanged history")...)
			if _, err = readMigrationHistory(copyFS); err == nil {
				t.Fatal("changed source accepted")
			}
		})
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
		"SELECT SUM(delta) FROM ledger WHERE habitica_id='alice' AND currency='embers'":                     12,
		"SELECT rev FROM players WHERE habitica_id='alice'":                                                 7,
		"SELECT last_seen_at FROM players WHERE habitica_id='alice'":                                        100,
	} {
		var got int
		if err = upgraded.DB.QueryRow(query).Scan(&got); err != nil || got != want {
			t.Fatalf("%s: %d, want %d (%v)", query, got, want, err)
		}
	}
	var gotReplay string
	if err = upgraded.DB.QueryRow("SELECT response_json FROM idempotency WHERE key='reset'").Scan(&gotReplay); err != nil || gotReplay != replay {
		t.Fatal("replay changed", gotReplay, err)
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
