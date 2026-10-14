package store

import (
	"context"
	"glimway/content"
	"glimway/server/internal/location"
	"glimway/server/internal/rules"
	"path/filepath"
	"testing"
	"time"

	"google.golang.org/protobuf/proto"
)

func TestQuestTree029Upgrade(t *testing.T) {
	for _, stage := range []string{"", "accepted", "clue-found", "guardian-defeated", "lantern-lit", "complete"} {
		t.Run(stage, func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "upgrade.sqlite")
			db := oldAccount026(t, path, false, true)
			advanceUpgradeFixture(t, db, "026_accounts.sql", "028_story_move.sql")
			var err error
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
			if s.State.Glims != balance || s.State.XPGlims != earned || s.State.Area != "home:0" || s.State.Position != (rules.Position{X: 320, Y: 160}) {
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
			if room.GetId() != "in:village:mill:2" && room.GetId() != "in:village:bakery" {
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
		want := "outdoors"
		if area == "in:village:bakery" || area == "in:village:removed" {
			want = "outdoors"
		}
		if area == "in:village:mill:2" {
			want = "in:village:mill"
		}
		if loaded.State.Area != want {
			t.Fatal(area, loaded.State.Area)
		}
		if area == "in:village:bakery" && loaded.State.Position != (rules.Position{X: -168, Y: 952}) {
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

// A removed Commons room comes back onto the outdoors grid (location-seam.md
// §3): a surviving door to the Commons lands on its doorstep, resolved
// through the footprint's origin (the Yard's is anchor hearthwick:yard-door),
// and a room with no door left lands on anchor hearthwick:arch.
func TestRemovedCommonsRoomRecoversToAnchors(t *testing.T) {
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
	yard, ok := content.RoomFor("in:commons:yard")
	if !ok {
		t.Fatal("no yard")
	}
	var front *content.RoomDoor
	for _, door := range yard.GetDoors() {
		if door.GetTo() == "hearthwick" {
			front = door
		}
	}
	if front == nil {
		t.Fatal("the yard has no door to the Commons")
	}
	// The Yard is retired; its office survives and keeps the front door.
	content.RoomRules.Rooms = nil
	for _, room := range original {
		switch room.GetId() {
		case "in:commons:yard":
		case "in:commons:yard:deeds":
			office := proto.Clone(room).(*content.Room)
			office.Doors = append(office.Doors, front)
			content.RoomRules.Rooms = append(content.RoomRules.Rooms, office)
		default:
			content.RoomRules.Rooms = append(content.RoomRules.Rooms, room)
		}
	}
	doorstep := func() (string, float64, float64) {
		space, x, y, ok := location.Anchor("hearthwick:yard-door")
		if !ok {
			t.Fatal("no yard-door anchor")
		}
		return string(space), x, y
	}
	arch := func() (string, float64, float64) {
		space, x, y, ok := location.Anchor("hearthwick:spawn")
		if !ok {
			t.Fatal("no arch anchor")
		}
		return string(space), x, y
	}
	for area, want := range map[string]func() (string, float64, float64){"in:commons:yard": doorstep, "in:commons:gone": arch} {
		if _, err = s.DB.Exec("UPDATE player_place SET area=?,x=80,y=80", area); err != nil {
			t.Fatal(err)
		}
		space, x, y := want()
		if space != "outdoors" {
			t.Fatal(area, space)
		}
		for pass := 0; pass < 2; pass++ {
			tx, _ := s.DB.Begin()
			loaded, err := Load(context.Background(), tx, "owner-subject")
			if err != nil {
				tx.Rollback()
				t.Fatal(err)
			}
			if loaded.State.Area != space || loaded.State.Position != (rules.Position{X: x, Y: y}) {
				t.Fatal(area, pass, loaded.State.Area, loaded.State.Position)
			}
			if err = tx.Commit(); err != nil {
				t.Fatal(err)
			}
		}
	}
	// The yard's doorstep is the door's entry carried onto the grid.
	if _, x, y := doorstep(); x != float64(34*16+8) || y != float64(35*16+8) {
		t.Fatal("yard-door anchor moved", x, y)
	}
}
