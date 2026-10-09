package store

import (
	"glimway/server/internal/rules"
	"path/filepath"
	"strings"
	"testing"
)

// Seed rows in the schema an older binary used, then open the database through
// production's upgrade path. Check old values/defaults as well as writes to the
// newly introduced tables against those retained foreign-key parents.
func TestSchemaMigrationsWithExistingData(t *testing.T) {
	tests := []struct {
		migration, through, seed, after string
		checks                          []string
	}{
		{"007", "006_lantern_creations.sql", "", `INSERT INTO library_shelves VALUES('w','paper','alice',17);`, []string{"SELECT count(*) FROM library_shelves WHERE world_id='w' AND donor_id='alice' AND donated_at=17"}},
		{"011", "010_homesteads_v2.sql", seedUpgradeHome, `INSERT INTO homestead_departures VALUES('home','alice',17);`, []string{"SELECT count(*) FROM homestead_departures WHERE homestead_id='home' AND habitica_id='alice' AND left_at=17", checkUpgradeHome}},
		{"014", "013_mail_instances.sql", seedUpgradeHome, `INSERT INTO woodpile_stacks VALUES('wood','home','alice',3,17);`, []string{"SELECT count(*) FROM woodpile_stacks WHERE homestead_id='home' AND habitica_id='alice' AND qty=3 AND stacked_at=17", checkUpgradeHome}},
		{"016", "014_woodpile_seasoning.sql", seedUpgradeHome, `INSERT INTO village_repairs VALUES('w','bridge','alice',17,10); INSERT INTO village_repair_log VALUES('log','w','bridge','alice',17); INSERT INTO village_repair_clock VALUES('w',3);`, []string{"SELECT count(*) FROM village_repairs WHERE world_id='w' AND mended_by='alice' AND mended_at=17 AND created_at=10", "SELECT count(*) FROM village_repair_log WHERE world_id='w' AND mended_by='alice' AND mended_at=17", "SELECT count(*) FROM village_repair_clock WHERE world_id='w' AND last_break_wick=3", checkUpgradeHome}},
		{"017", "016_village_repairs.sql", seedUpgradeTool, "", []string{"SELECT count(*) FROM item_instances WHERE id='tool' AND worn_at=0 AND racked_at=0 AND worn_day=4 AND condition=7 AND maker_id='alice' AND owner='alice'"}},
		{"018", "017_warden_tools.sql", seedUpgradeTool + `UPDATE item_instances SET worn_at=123 WHERE id='tool'; INSERT INTO warden_finds VALUES('alice',20000),('alice',20007);`, "", []string{"SELECT count(*) FROM warden_finds WHERE habitica_id='alice' AND found_at=1728000000", "SELECT count(*) FROM warden_finds WHERE habitica_id='alice' AND found_at=1728604800", "SELECT count(*) FROM item_instances WHERE id='tool' AND worn_at=123 AND racked_at=0 AND worn_day=4 AND condition=7"}},
		{"021", "020_gifts.sql", seedUpgradeTool + `INSERT INTO warden_finds VALUES('alice',100);`, `INSERT INTO storm_finds VALUES('alice',17);`, []string{"SELECT count(*) FROM storm_finds WHERE habitica_id='alice' AND found_at=17", "SELECT count(*) FROM warden_finds WHERE habitica_id='alice' AND found_at=100"}},
		{"022", "021_storm_finds.sql", `UPDATE worlds SET habitica_party_id='party';`, `INSERT INTO party_prompts VALUES('alice','w',17);`, []string{"SELECT count(*) FROM worlds WHERE id='w' AND habitica_party_id='party' AND owner_id='alice'", "SELECT count(*) FROM party_prompts WHERE habitica_id='alice' AND world_id='w' AND seen_at=17"}},
		{"024", "023_party_owned_worlds.sql", `UPDATE worlds SET habitica_party_id='party';`, `INSERT INTO party_closures VALUES('party',17);`, []string{"SELECT count(*) FROM worlds WHERE id='w' AND habitica_party_id='party' AND opened_by IS NULL", "SELECT count(*) FROM party_closures WHERE party_id='party' AND closed_at=17", "SELECT count(*) FROM players WHERE habitica_id='alice' AND party_left_at IS NULL AND party_moved_out_at IS NULL"}},
		{"025", "024_party_admission.sql", `UPDATE worlds SET opened_by='alice'; UPDATE players SET party_left_at=12,party_moved_out_at=13;`, `INSERT INTO pending_sessions VALUES('pending','newcomer','New','party',10,20,'{"level":8}',123);`, []string{`SELECT count(*) FROM pending_sessions WHERE id_hash='pending' AND habitica_id='newcomer' AND display_name='New' AND habitica_party_id='party' AND created_at=10 AND expires_at=20 AND checkpoint_json='{"level":8}' AND checkpoint_xp=123`, "SELECT count(*) FROM players WHERE habitica_id='alice' AND party_left_at=12 AND party_moved_out_at=13", "SELECT count(*) FROM worlds WHERE id='w' AND opened_by='alice'"}},
		{"030", "029_quest_tree.sql", seedUpgradeHome + `
INSERT INTO homestead_items(id,item_def,location,account_id) VALUES('piece','tool-rack','inventory','alice');
INSERT INTO sync_baselines(account_id,profile_json,verified_xp,checkpoint_json,checkpoint_at,updated_at) VALUES('alice','{}',0,'{}',12,12);`, `
INSERT INTO homestead_items(id,item_def,location,account_id,stalls) VALUES('stable','stable','inventory','alice',1);
INSERT INTO homestead_stalls VALUES('home',1,'Wolf-Shade','alice');
INSERT INTO player_companions(account_id) VALUES('alice');
INSERT INTO yard_pets VALUES('alice',1,'Cat-Siamese');
INSERT INTO player_ability_ready VALUES('alice','kindle',17);
INSERT INTO world_changes(world_id,realm,layer,chunk,epoch,entity,kind,state,changed_at) VALUES('w','village',0,'','','water:village:mill-pond','fishery','{"stock":12}',17);
INSERT INTO fishing_casts(id,account_id,world_id,water,bank,rod,species,band,seq,started_at,ready_at,hold_until,state) VALUES('cast','alice','w','water:village:mill-pond','north','willow-rod','mill-roach','healthy',1,10,20,620,'open');
INSERT INTO player_fishing(account_id,cast_seq,last_start) VALUES('alice',2,10);`, []string{
			checkUpgradeHome,
			// Rows kept from before 030 read NULL in its new columns.
			"SELECT count(*) FROM homestead_items WHERE id='piece' AND homestead_id IS NULL AND stalls IS NULL",
			"SELECT count(*) FROM sync_baselines WHERE account_id='alice' AND class_mark IS NULL",
			// And each new table takes its rows against the retained world.
			"SELECT count(*) FROM homestead_items WHERE id='stable' AND stalls=1",
			"SELECT count(*) FROM homestead_stalls WHERE homestead_id='home' AND stall=1 AND mount_key='Wolf-Shade' AND owner_id='alice'",
			"SELECT count(*) FROM player_companions WHERE account_id='alice' AND follow_pet='' AND mount_out='' AND mount_home IS NULL",
			"SELECT count(*) FROM yard_pets WHERE account_id='alice' AND slot=1 AND pet_key='Cat-Siamese'",
			"SELECT count(*) FROM player_ability_ready WHERE account_id='alice' AND ability='kindle' AND ready_at=17",
			`SELECT count(*) FROM world_changes WHERE world_id='w' AND realm='village' AND layer=0 AND chunk='' AND epoch='' AND entity='water:village:mill-pond' AND kind='fishery' AND state='{"stock":12}' AND changed_at=17 AND ends_at IS NULL`,
			"SELECT count(*) FROM fishing_casts WHERE id='cast' AND account_id='alice' AND world_id='w' AND water='water:village:mill-pond' AND bank='north' AND rod='willow-rod' AND species='mill-roach' AND band='healthy' AND seq=1 AND started_at=10 AND ready_at=20 AND hold_until=620 AND state='open' AND closed_at IS NULL",
			"SELECT count(*) FROM player_fishing WHERE account_id='alice' AND cast_seq=2 AND last_start=10",
		}},
	}
	for _, tt := range tests {
		t.Run(tt.migration, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "upgrade.sqlite")
			old := newUpgradeFixture(t, path, tt.through, nil)
			seed := `INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','seed',10);
INSERT INTO players(account_id,display_name,world_id,created_at,last_seen_at,version) VALUES('alice','Alice','w',11,12,7);` + tt.seed
			if _, err := old.Exec(fixtureSchemaSQL(tt.through, seed)); err != nil {
				t.Fatal(err)
			}
			if tt.migration == "025" {
				p := rules.Profile{ID: "alice", Name: "Alice", Level: 1, HP: 20, MaxHP: 50, MP: 10, MaxMP: 30, Stats: rules.Stats{}}
				exp := 0.
				p.Exp = &exp
				if _, err := old.Exec(`INSERT INTO progress VALUES('alice',1,7,?,12);INSERT INTO balances VALUES('alice',0,0);INSERT INTO sync_baselines(habitica_id,profile_json,verified_xp,checkpoint_json,checkpoint_at,updated_at) VALUES('alice',?,0,?,12,12)`, JSON(rules.NewState()), JSON(p), JSON(p)); err != nil {
					t.Fatal(err)
				}
			} else if tt.through < "026_" {
				// 026 finished null origins and dropped the column; a
				// fixture from after it needs no marker.
				markFixtureOrigins(t, old)
			}
			if err := old.Close(); err != nil {
				t.Fatal(err)
			}
			upgraded, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer upgraded.Close()
			if tt.after != "" {
				if _, err := upgraded.DB.Exec(currentSchemaSQL(tt.after)); err != nil {
					t.Fatal(err)
				}
			}
			checks := append([]string{
				"SELECT count(*) FROM worlds WHERE id='w' AND owner_id='alice' AND seed='seed' AND created_at=10",
				"SELECT count(*) FROM players WHERE habitica_id='alice' AND display_name='Alice' AND world_id='w' AND created_at=11 AND last_seen_at=12 AND rev=7",
			}, tt.checks...)
			for _, query := range checks {
				query = currentSchemaSQL(query)
				if tt.migration == "025" {
					query = strings.ReplaceAll(query, "version=7", "version=9")
				}
				var got int
				if err := upgraded.DB.QueryRow(query).Scan(&got); err != nil || got != 1 {
					t.Fatalf("%s: got %d, %v", query, got, err)
				}
			}
			if tt.migration == "018" {
				var count int
				if err := upgraded.DB.QueryRow("SELECT count(*) FROM warden_finds").Scan(&count); err != nil || count != 2 {
					t.Fatal("finds lost or duplicated", count, err)
				}
				if err := upgraded.DB.QueryRow("SELECT count(*) FROM sqlite_master WHERE name='warden_finds_daily_legacy'").Scan(&count); err != nil || count != 0 {
					t.Fatal("legacy table retained", count, err)
				}
			}
			rows, err := upgraded.DB.Query("PRAGMA foreign_key_check")
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			if rows.Next() {
				t.Fatal("invalid upgraded foreign keys")
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
		})
	}
}

const seedUpgradeHome = `INSERT INTO homesteads(id,world_id,gate,tier,posts_bought,claimed_at) VALUES('home','w',2,1,3,15);
INSERT INTO homestead_members VALUES('alice','home',16);`
const checkUpgradeHome = "SELECT count(*) FROM homesteads WHERE id='home' AND world_id='w' AND gate=2 AND tier=1 AND posts_bought=3 AND claimed_at=15"
const seedUpgradeTool = `INSERT INTO item_instances(id,item_def,location,owner,condition,max_condition,maker_id,worn_day,created_at) VALUES('tool','axe','pack','alice',7,10,'alice',4,15);`

// fixtureSchemaSQL spells seed SQL the way the fixture's schema still does:
// 026 renamed habitica_id to account_id, 027 rev to version. Seeds are
// written in the current names and translated back for older fixtures.
func fixtureSchemaSQL(through, q string) string {
	if through < "026_" {
		q = strings.ReplaceAll(q, "account_id", "habitica_id")
	}
	if through < "027_" {
		q = strings.ReplaceAll(q, "version", "rev")
	}
	return q
}
