package ports

import (
	"context"
	"database/sql"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"path/filepath"
	"testing"
)

func TestFakesUseCallerTransactionAndCloneViews(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "ports.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	ctx := context.Background()
	snap := store.Snapshot{AccountID: "account", WorldID: "world"}
	called := 0
	story := FakeStory{Assign: func(_ context.Context, got *sql.Tx, snapshot store.Snapshot, in EchoInput) ([]*contract.EchoAssignment, error) {
		if got != tx || snapshot.AccountID != "account" {
			t.Fatal("assignment boundary")
		}
		called++
		return []*contract.EchoAssignment{{Site: "site", Member: "member"}}, nil
	}, Check: func(_ context.Context, got *sql.Tx, _ store.Snapshot, in PaperInput) (bool, error) {
		if got != tx || in.Site != "site" {
			t.Fatal("eligibility boundary")
		}
		called++
		return true, nil
	}, Give: func(_ context.Context, got *sql.Tx, s *store.Snapshot, paper string, _ int64) (Grant, error) {
		if got != tx {
			t.Fatal("grant boundary")
		}
		called++
		s.State.Inventory = append(s.State.Inventory, paper)
		return Grant{true, paper}, nil
	}}
	assignments, err := story.Echoes(ctx, tx, snap, EchoInput{})
	if err != nil || len(assignments) != 1 {
		t.Fatal(err)
	}
	if yes, err := story.Eligible(ctx, tx, snap, PaperInput{Site: "site"}); err != nil || !yes {
		t.Fatal(err)
	}
	if grant, err := story.Grant(ctx, tx, &snap, "paper", 1); err != nil || !grant.Added || called != 3 {
		t.Fatal(grant, err)
	}
	if snap.Version != 0 {
		t.Fatal("story fake owns version")
	}
	if err = (FakePlacement{}).Record(ctx, tx, &snap, &contract.Where{Area: "commons", X: 2, Y: 3}, 1); err != nil || snap.State.Area != "commons" {
		t.Fatal(err)
	}
	regions := FakeRegions{Views: map[RegionKey]*contract.WildsRegionResult{{"world", "outer-1", "account"}: {Epoch: &contract.WildsEpoch{Id: "epoch"}}}}
	v, err := regions.Region(ctx, tx, snap, "outer-1", 1)
	if err != nil {
		t.Fatal(err)
	}
	v.Epoch.Id = "changed"
	v, err = regions.Region(ctx, tx, snap, "outer-1", 1)
	if err != nil || v.Epoch.Id != "epoch" {
		t.Fatal("region fake mutation")
	}
	land := FakeLand{Views: map[LandKey]*contract.HomesteadLand{{"world", 0}: {Width: 1, Height: 1, Cells: []string{"grass"}}}}
	if v, err := land.Land(ctx, tx, "world", 0); err != nil || v.Cells[0] != "grass" {
		t.Fatal(v, err)
	}
	loaded := false
	state := store.FakeState{LoadFunc: func(_ context.Context, got *sql.Tx, id string) (store.Snapshot, error) {
		if got != tx || id != "account" {
			t.Fatal("state boundary")
		}
		loaded = true
		return snap, nil
	}, PersistFunc: func(_ context.Context, got *sql.Tx, s *store.Snapshot, now int64) error {
		if got != tx || now != 1 {
			t.Fatal("persist boundary")
		}
		s.Version++
		return nil
	}}
	copy, err := state.Load(ctx, tx, "account")
	if err != nil || !loaded {
		t.Fatal(err)
	}
	if err = state.Persist(ctx, tx, &copy, 1); err != nil || copy.Version != 1 {
		t.Fatal(err)
	}
}

func TestFallLanternPortUsesSnapshotAndCallerTransaction(t *testing.T) {
	s, err := store.Open(filepath.Join(t.TempDir(), "fall.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	tx, err := s.DB.Begin()
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback()
	snapshot := store.Snapshot{AccountID: "account", WorldID: "world"}
	epoch := &contract.WildsEpoch{Id: "epoch"}
	where := &contract.Where{Area: "wilds:outer-1"}
	for _, reason := range []string{"not-wilds", "invalid-place", "epoch-missing", "daily-cap", ""} {
		fake := FakeLanterns{Put: func(_ context.Context, got *sql.Tx, player *store.Snapshot, e *contract.WildsEpoch, w *contract.Where, now int64) (FallLantern, error) {
			if got != tx || player != &snapshot || e != epoch || w != where || now != 10 {
				t.Fatal("fall composition boundary")
			}
			if reason == "" {
				return FallLantern{Lantern: "placed", ID: "lamp", Epoch: "epoch"}, nil
			}
			return FallLantern{Lantern: "none", Reason: reason}, nil
		}}
		result, err := fake.PlaceFallen(context.Background(), tx, &snapshot, epoch, where, 10)
		if err != nil || result.Reason != reason {
			t.Fatal(result, err)
		}
	}
}
