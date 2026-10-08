package itemmove_test

import (
	"context"
	"database/sql"
	"errors"
	"glimway/server/internal/itemmove"
	"glimway/server/internal/store"
	"path/filepath"
	"reflect"
	"testing"
)

func fixture(t *testing.T) *sql.DB {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "items.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	_, err = s.DB.Exec(`INSERT INTO worlds(id,owner_id,seed,created_at) VALUES('w','alice','s',0);
INSERT INTO players(habitica_id,display_name,world_id,created_at,last_seen_at) VALUES('alice','Alice','w',0,0);
INSERT INTO homesteads(id,world_id,gate,claimed_at) VALUES('home','w',1,0);
INSERT INTO item_instances(id,item_def,location,owner,condition,max_condition,created_at) VALUES('tool','axe','pack','alice',7,10,0),('fit','stone','fitted','tool',1,1,0);
INSERT INTO homestead_items(id,item_def,location,habitica_id) VALUES('chair','chair','mail','alice');`)
	if err != nil {
		t.Fatal(err)
	}
	return s.DB
}

func transaction(t *testing.T, db *sql.DB) *sql.Tx {
	t.Helper()
	tx, err := db.Begin()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tx.Rollback() })
	return tx
}

func TestMoveInstanceGuards(t *testing.T) {
	db := fixture(t)
	for _, tt := range []struct{ name, id, def, location, owner string }{
		{"wrong owner", "tool", "axe", "pack", "bob"},
		{"wrong def", "tool", "chair", "pack", "alice"},
		{"wrong location", "tool", "axe", "mail", "alice"},
		{"missing id", "missing", "axe", "pack", "alice"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			tx := transaction(t, db)
			err := itemmove.MoveInstance(context.Background(), tx, tt.id, tt.def, tt.location, tt.owner, "storage", "home", 42)
			if !errors.Is(err, itemmove.ErrUnavailable) {
				t.Fatalf("got %v", err)
			}
			var owner string
			if err := tx.QueryRow("SELECT owner FROM item_instances WHERE id='tool'").Scan(&owner); err != nil || owner != "alice" {
				t.Fatal("changed unavailable instance", owner, err)
			}
		})
	}
	t.Run("exactly one, fittings stay attached", func(t *testing.T) {
		tx := transaction(t, db)
		if err := itemmove.MoveInstance(context.Background(), tx, "tool", "axe", "pack", "alice", "storage", "home", 42); err != nil {
			t.Fatal(err)
		}
		var location, owner, fitOwner string
		var rack, condition int
		if err := tx.QueryRow("SELECT location,owner,racked_at,condition FROM item_instances WHERE id='tool'").Scan(&location, &owner, &rack, &condition); err != nil {
			t.Fatal(err)
		}
		if err := tx.QueryRow("SELECT owner FROM item_instances WHERE id='fit'").Scan(&fitOwner); err != nil {
			t.Fatal(err)
		}
		if location != "storage" || owner != "home" || rack != 42 || condition != 7 || fitOwner != "tool" {
			t.Fatal(location, owner, rack, condition, fitOwner)
		}
		if err := itemmove.MoveInstance(context.Background(), tx, "tool", "axe", "pack", "alice", "storage", "home", 42); !errors.Is(err, itemmove.ErrUnavailable) {
			t.Fatal("second move accepted", err)
		}
	})
}

func TestReturnDecorationGuards(t *testing.T) {
	db := fixture(t)
	for _, tt := range []struct{ name, id, owner, def, setup string }{
		{"wrong owner", "chair", "bob", "chair", ""},
		{"wrong def", "chair", "alice", "lamp", ""},
		{"missing id", "missing", "alice", "chair", ""},
		{"wrong location", "chair", "alice", "chair", "UPDATE homestead_items SET location='inventory'"},
		{"placed scene", "chair", "alice", "chair", "UPDATE homestead_items SET location='placed',habitica_id=NULL,homestead_id='home',scene='outdoor',x=0,y=0,rotation=0"},
	} {
		t.Run(tt.name, func(t *testing.T) {
			tx := transaction(t, db)
			if tt.setup != "" {
				if _, err := tx.Exec(tt.setup); err != nil {
					t.Fatal(err)
				}
			}
			if err := itemmove.ReturnDecoration(context.Background(), tx, tt.id, tt.owner, tt.def); !errors.Is(err, itemmove.ErrUnavailable) {
				t.Fatal(err)
			}
		})
	}
	t.Run("return once", func(t *testing.T) {
		tx := transaction(t, db)
		if err := itemmove.ReturnDecoration(context.Background(), tx, "chair", "alice", "chair"); err != nil {
			t.Fatal(err)
		}
		var location string
		if err := tx.QueryRow("SELECT location FROM homestead_items WHERE id='chair'").Scan(&location); err != nil || location != "inventory" {
			t.Fatal(location, err)
		}
		if err := itemmove.ReturnDecoration(context.Background(), tx, "chair", "alice", "chair"); !errors.Is(err, itemmove.ErrUnavailable) {
			t.Fatal(err)
		}
	})
}

func TestMoveDecorationsGuardsAndNullOwners(t *testing.T) {
	db := fixture(t)
	to := itemmove.DecorationPlace{Location: "storage", Home: "home"}
	for _, from := range []itemmove.DecorationPlace{
		{Location: "mail", Player: "bob"}, {Location: "inventory", Player: "alice"}, {Location: "mail", Player: "alice", Home: "home"},
	} {
		t.Run(from.Location+from.Player+from.Home, func(t *testing.T) {
			tx := transaction(t, db)
			if err := itemmove.MoveDecorations(context.Background(), tx, []string{"chair"}, from, to); !errors.Is(err, itemmove.ErrUnavailable) {
				t.Fatal(err)
			}
		})
	}
	tx := transaction(t, db)
	if err := itemmove.MoveDecorations(context.Background(), tx, []string{"chair"}, itemmove.DecorationPlace{Location: "mail", Player: "alice"}, to); err != nil {
		t.Fatal(err)
	}
	var player sql.NullString
	var home, location string
	if err := tx.QueryRow("SELECT habitica_id,homestead_id,location FROM homestead_items WHERE id='chair'").Scan(&player, &home, &location); err != nil || player.Valid || home != "home" || location != "storage" {
		t.Fatal(player, home, location, err)
	}
	if err := itemmove.MoveDecorations(context.Background(), tx, []string{"chair"}, to, itemmove.DecorationPlace{Location: "personal", Player: "alice"}); err != nil {
		t.Fatal(err)
	}
}

func TestFittedLedgerOrder(t *testing.T) {
	db := fixture(t)
	tx := transaction(t, db)
	if _, err := tx.Exec(`DELETE FROM item_instances WHERE location='fitted';
INSERT INTO item_instances(id,item_def,location,owner,condition,max_condition,created_at) VALUES
('z','zeta','fitted','tool',0,0,0),('a2','alpha','fitted','tool',0,0,0),('b','beta','fitted','tool',0,0,0),('a1','alpha','fitted','tool',0,0,0),('other','ignored','fitted','other-tool',0,0,0),('loose','ignored','pack','tool',0,0,0);`); err != nil {
		t.Fatal(err)
	}
	if err := itemmove.FittedLedger(context.Background(), tx, "alice", "tool", -1, "send", "parcel", 99); err != nil {
		t.Fatal(err)
	}
	rows, err := tx.Query("SELECT currency,delta,earned_delta,reason,ref,created_at FROM ledger ORDER BY id")
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var currency, reason, ref string
		var delta, earned, at int
		if err := rows.Scan(&currency, &delta, &earned, &reason, &ref, &at); err != nil {
			t.Fatal(err)
		}
		if delta != -1 || earned != 0 || reason != "send" || ref != "parcel" || at != 99 {
			t.Fatal(delta, earned, reason, ref, at)
		}
		got = append(got, currency)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if want := []string{"fitted:alpha", "fitted:alpha", "fitted:beta", "fitted:zeta"}; !reflect.DeepEqual(got, want) {
		t.Fatal(got, want)
	}
}
