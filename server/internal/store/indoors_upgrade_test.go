package store

import (
	"context"
	"glimway/content"
	"glimway/server/internal/rules"
	"path/filepath"
	"testing"
	"time"
)

func TestQuestTree029Upgrade(t *testing.T) {
	for _, stage := range []string{"", "accepted", "clue-found", "guardian-defeated", "lantern-lit", "complete"} {
		t.Run(stage, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "upgrade.sqlite")
			db := oldAccount026(t, path, false, true)
			history, err := migrationHistory()
			if err != nil {
				t.Fatal(err)
			}
			for _, m := range history {
				if m.Name < "026" || m.Name >= "029" {
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
			if stage != "" {
				if _, err = db.Exec("INSERT INTO quest_progress VALUES('owner-subject','lantern-road',?)", stage); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = db.Exec("UPDATE player_place SET area='home:0',x=320,y=160"); err != nil {
				t.Fatal(err)
			}
			var balance, earned, ledger, outcomes, ledgerSum int
			if err = db.QueryRow("SELECT embers,xp_embers FROM balances").Scan(&balance, &earned); err != nil {
				t.Fatal(err)
			}
			db.QueryRow("SELECT count(*) FROM ledger").Scan(&ledger)
			db.QueryRow("SELECT COALESCE(SUM(delta),0) FROM ledger").Scan(&ledgerSum)
			db.QueryRow("SELECT count(*) FROM outcomes").Scan(&outcomes)
			db.Close()
			before := time.Now().Unix()
			upgraded, err := Open(path)
			if err != nil {
				t.Fatal(err)
			}
			defer upgraded.Close()
			tx, _ := upgraded.DB.Begin()
			defer tx.Rollback()
			s, err := Load(context.Background(), tx, "owner-subject")
			if err != nil {
				t.Fatal(err)
			}
			if s.State.Embers != balance || s.State.XPEmbers != earned || s.State.Area != "home:0" || s.State.Position != (rules.Position{X: 320, Y: 160}) {
				t.Fatal(s)
			}
			for query, want := range map[string]int{"SELECT count(*) FROM ledger": ledger, "SELECT count(*) FROM outcomes": outcomes, "SELECT COALESCE(SUM(delta),0) FROM ledger": ledgerSum} {
				var got int
				if err = tx.QueryRow(query).Scan(&got); err != nil || got != want {
					t.Fatal(query, got, err)
				}
			}
			if stage == "" {
				if len(s.State.Quests) != 0 {
					t.Fatal(s.State.Quests)
				}
				return
			}
			if s.State.Quests["lantern-road"] != stage || s.State.Quests["signpost"] != "light-first-lamp" || len(s.State.Quests) != 2 {
				t.Fatal(s.State.Quests)
			}
			for _, quest := range []string{"signpost", "lantern-road"} {
				if s.State.ReachedAt[quest] < before || s.State.ReachedAt[quest] > time.Now().Unix() || s.State.GateAt[quest] != s.State.ReachedAt[quest] {
					t.Fatal(s.State.ReachedAt, s.State.GateAt)
				}
			}
			if err = foreignKeysClean(tx); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestRemovedRoomReadRecovery(t *testing.T) {
	path := filepath.Join(t.TempDir(), "rooms.sqlite")
	db := oldAccount026(t, path, false, true)
	db.Close()
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	original := content.RoomRules.Rooms
	t.Cleanup(func() { content.RoomRules.Rooms = original })
	for _, area := range []string{"in:village:mill:2", "in:village:bakery", "in:village:removed", "in:unknown:missing"} {
		content.RoomRules.Rooms = nil
		for _, room := range original {
			if room.ID != "in:village:mill:2" && room.ID != "in:village:bakery" {
				content.RoomRules.Rooms = append(content.RoomRules.Rooms, room)
			}
		}
		if _, err = s.DB.Exec("UPDATE player_place SET area=?,x=80,y=80", area); err != nil {
			t.Fatal(err)
		}
		tx, _ := s.DB.Begin()
		loaded, err := Load(context.Background(), tx, "owner-subject")
		if err != nil {
			tx.Rollback()
			t.Fatal(err)
		}
		want := "village"
		if area == "in:village:mill:2" {
			want = "in:village:mill"
		}
		if loaded.State.Area != want {
			t.Fatal(area, loaded.State.Area)
		}
		if area == "in:village:bakery" && loaded.State.Position != (rules.Position{X: 120, Y: 136}) {
			t.Fatal("lost doorstep", loaded.State.Position)
		}
		version := loaded.Version
		if err = tx.Commit(); err != nil {
			t.Fatal(err)
		}
		tx, _ = s.DB.Begin()
		again, err := Load(context.Background(), tx, "owner-subject")
		tx.Rollback()
		if err != nil || again.Version != version || again.State.Position != loaded.State.Position {
			t.Fatal(again, err)
		}
	}
}
