package api

import (
	"context"
	"glimway/server/internal/store"
	"testing"
)

func TestItemAndRepairProjectionIsReadOnlyBeforeAndAfterMaintenance(t *testing.T) {
	x := newRig(t)
	_, ready := x.ready("projection-phases")
	x.jumpToAs("projection-phases", "wick", "Haze")
	x.stack(ready.AccountID, "bloom-flowers", "", 5)
	ctx := context.Background()
	tx, err := x.db.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	// query_only is connection-local; restore it even when an assertion fails.
	defer tx.Exec("PRAGMA query_only=OFF")
	snapshot, err := store.Load(ctx, tx, ready.AccountID)
	if err != nil {
		t.Fatal(err)
	}
	before := store.JSON(snapshot)
	if _, err = tx.Exec("PRAGMA query_only=ON"); err != nil {
		t.Fatal(err)
	}
	items, err := projectItems(ctx, tx, &snapshot)
	if err != nil {
		t.Fatal("item projection attempted maintenance", err)
	}
	if stackQty(items, "bloom-flowers") != 5 || stackQty(items, "dried-flowers") != 0 {
		t.Fatal("projection dried flowers")
	}
	if _, err = projectRepairs(ctx, tx, snapshot); err != nil {
		t.Fatal("repair projection attempted progression", err)
	}
	if store.JSON(snapshot) != before {
		t.Fatal("projection changed snapshot")
	}
	if _, err = tx.Exec("PRAGMA query_only=OFF"); err != nil {
		t.Fatal(err)
	}
	items, err = maintainAndReadItems(ctx, tx, &snapshot, x.now.Load())
	if err != nil {
		t.Fatal(err)
	}
	if stackQty(items, "bloom-flowers") != 0 || stackQty(items, "dried-flowers") != 5 {
		t.Fatal("maintenance did not dry one for one")
	}
	repairs, err := maintainAndReadRepairs(ctx, tx, snapshot, x.now.Load())
	if err != nil {
		t.Fatal(err)
	}
	if len(repairs.Open) == 0 || repairs.Open[0].ID != "well-rope" {
		t.Fatal("maintenance did not create scripted progression", repairs)
	}
	if _, err = tx.Exec("PRAGMA query_only=ON"); err != nil {
		t.Fatal(err)
	}
	if _, err = projectItems(ctx, tx, &snapshot); err != nil {
		t.Fatal(err)
	}
	if _, err = projectRepairs(ctx, tx, snapshot); err != nil {
		t.Fatal(err)
	}
}
