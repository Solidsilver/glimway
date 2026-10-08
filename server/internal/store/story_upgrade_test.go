package store

import (
	"context"
	"glimway/server/internal/rules"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestStory028Upgrade(t *testing.T) {
	for _, kind := range []string{"complete", "wilds", "home-valid", "home-invalid", "unknown", "unknown-stage", "over-max"} {
		t.Run(kind, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "upgrade.sqlite")
			db := oldAccount026(t, path, false, true)
			state := rules.NewState()
			state.Quest = "complete"
			state.Flags = []string{"paper:eleven-days", "echo:nan", "heirloom:nans-pole", "wilds:turned", "lit:road-1", "opened:shrine-chest", "met:mara@accepted", "heard:mara@intro", "witness:echo-nan:old-id:Olive", "donated:eleven-days@2026-10-07"}
			state.Inventory = append(state.Inventory, "warden-seal", "warden-seal", "timber")
			state.Discoveries = []string{"old-route-marker"}
			state.DefeatedEnemies = []string{"stone-warden"}
			state.PlaySeconds = 123
			if kind == "wilds" {
				state.Area = "wilds"
			}
			if kind == "home-valid" || kind == "home-invalid" {
				state.Area = "home:0"
				if kind == "home-valid" {
					if _, e := db.Exec("INSERT INTO homesteads(id,world_id,gate,claimed_at) VALUES('home','w',0,1)"); e != nil {
						t.Fatal(e)
					}
				}
			}
			if kind == "unknown-stage" {
				state.Quest = "future-stage"
			}
			if kind == "over-max" {
				state.HP = 500
				state.Mana = 500
			}
			if kind == "unknown" {
				state.Flags = append(state.Flags, "future:stop")
			}
			if _, e := db.Exec("UPDATE progress SET doc_json=?", JSON(state)); e != nil {
				t.Fatal(e)
			}
			if _, e := db.Exec("INSERT INTO outcomes VALUES('owner-subject','quest-gift:defeat-guardian','quest',1),('owner-subject','quest-gift:return-village','quest',1)"); e != nil {
				t.Fatal(e)
			}
			if _, e := db.Exec("INSERT INTO outcomes VALUES('owner-subject','lit:road-1','spend',1),('owner-subject','opened:shrine-chest','spend',1)"); e != nil {
				t.Fatal(e)
			}
			db.Close()
			before := float64(time.Now().Unix())
			s, e := Open(path)
			if kind == "unknown" || kind == "unknown-stage" {
				want := "future:stop"
				if kind == "unknown-stage" {
					want = "future-stage"
				}
				if e == nil || !strings.Contains(e.Error(), want) || !strings.Contains(e.Error(), "owner-subject") {
					t.Fatal(e)
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			defer s.Close()
			tx, _ := s.DB.Begin()
			defer tx.Rollback()
			snap, e := Load(context.Background(), tx, "owner-subject")
			if e != nil {
				t.Fatal(e)
			}
			if snap.State.Quests["lantern-road"] != "complete" || snap.State.PlaySeconds != 123 || snap.Version != 8 || len(questInventory(snap.State.Inventory)) != 3 {
				t.Fatal(JSON(snap))
			}
			if kind == "wilds" && (snap.State.Area != "commons" || snap.State.Position != (rules.Position{X: 23*16 + 8, Y: 2*16 + 8})) {
				t.Fatal(snap.State.Area)
			}
			if kind == "home-valid" && snap.State.Area != "home:0" || kind == "home-invalid" && snap.State.Area != "village" {
				t.Fatal("home normalization", snap.State.Area)
			}
			if kind == "over-max" && (snap.State.HP != 50 || snap.State.Mana != 32) {
				t.Fatal("unclamped", snap.State)
			}
			var at float64
			var version int64
			if e = tx.QueryRow("SELECT vitals_at,vitals_set_version FROM player_vitals").Scan(&at, &version); e != nil || at < before || version != snap.Version {
				t.Fatal("vitals migration", at, version, e)
			}
			for _, mark := range []string{"lit:road-1", "opened:shrine-chest", "met:mara@accepted", "heard:mara@intro", "witness:echo-nan:old-id:Olive", "donated:eleven-days@2026-10-07"} {
				if !strings.Contains(JSON(snap.State.Flags), mark) {
					t.Fatal("mark lost", mark)
				}
			}
			for q, want := range map[string]int{"SELECT count(*) FROM story_marks WHERE writer='quest-item'": 3, "SELECT count(*) FROM outcomes WHERE outcome_id IN ('quest-gift:lantern-road:guardian-defeated','quest-gift:lantern-road:complete')": 2, "SELECT SUM(delta) FROM ledger": 9} {
				var got int
				if e = tx.QueryRow(q).Scan(&got); e != nil || got != want {
					t.Fatal(q, got, e)
				}
			}
			if e = foreignKeysClean(tx); e != nil {
				t.Fatal(e)
			}
		})
	}
}

func TestStory028BadJSONNamesAccount(t *testing.T) {
	path := filepath.Join(t.TempDir(), "bad-story.sqlite")
	db := oldAccount026(t, path, false, true)
	history, err := migrationHistory()
	if err != nil {
		t.Fatal(err)
	}
	for _, m := range history {
		if m.Name != "026_accounts.sql" && m.Name != "027_server_state.sql" {
			continue
		}
		tx, e := db.Begin()
		if e != nil {
			t.Fatal(e)
		}
		if e = applyMigration(tx, m, 0); e != nil {
			tx.Rollback()
			t.Fatal(e)
		}
		if e = tx.Commit(); e != nil {
			t.Fatal(e)
		}
	}
	if _, err = db.Exec("UPDATE progress SET doc_json='bad JSON'"); err != nil {
		t.Fatal(err)
	}
	db.Close()
	if _, err = Open(path); err == nil || !strings.Contains(err.Error(), "owner-subject") || !strings.Contains(err.Error(), "bad story JSON") {
		t.Fatal(err)
	}
}
