// Package ports fixes the transaction-aware handoffs between the server lanes.
package ports

import (
	"context"
	"database/sql"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/proto"
)

type PaperRule struct {
	Kind    string `json:"kind"`
	Area    string `json:"area,omitempty"`
	TX      int    `json:"tx,omitempty"`
	TY      int    `json:"ty,omitempty"`
	After   string `json:"after,omitempty"`
	Stage   string `json:"stage,omitempty"`
	From    string `json:"from,omitempty"`
	Project string `json:"project,omitempty"`
	Fact    string `json:"fact,omitempty"`
	POI     string `json:"poi,omitempty"`
	Site    string `json:"site,omitempty"`
	Member  string `json:"member,omitempty"`
	Paper   string `json:"paper,omitempty"`
	RoadLit bool   `json:"roadLit,omitempty"`
	East    bool   `json:"east,omitempty"`
	Mark    string `json:"mark,omitempty"`
	Tier    int    `json:"tier,omitempty"`
	Unbuilt bool   `json:"unbuilt,omitempty"`
}
type QuestStep struct {
	ID      string   `json:"id"`
	At      string   `json:"at"`
	Items   []string `json:"items"`
	Marks   []string `json:"marks"`
	Papers  []string `json:"papers"`
	Glims   int      `json:"glims"`
	Witness string   `json:"witness"`
}

// EchoSite includes the chunk column for the east-only assignment rule.
type EchoSite struct {
	Site   *contract.StorySite
	CX, CY int32
}
type EchoInput struct {
	Epoch *contract.WildsEpoch
	Sites []EchoSite
}
type PaperInput struct {
	Paper, Epoch, Site, Entity string
	Cycle                      int64
	Where                      *contract.Where
}
type Grant struct {
	Added bool
	Paper string
}

// All now parameters are Unix seconds. Where coordinates are pixels.
// All methods use the caller's tx. Read methods do not write; grant and placement
// change Snapshot/rows but never bump versions. The outer operation bumps each
// affected account once. B owns StoryRules and Placement; D owns Region/HomeLand.
type StoryRules interface {
	Echoes(ctx context.Context, tx *sql.Tx, snapshot store.Snapshot, input EchoInput) ([]*contract.EchoAssignment, error)
	Eligible(ctx context.Context, tx *sql.Tx, snapshot store.Snapshot, input PaperInput) (bool, error)
	Grant(ctx context.Context, tx *sql.Tx, snapshot *store.Snapshot, paper string, now int64) (Grant, error)
}
type Placement interface {
	Record(ctx context.Context, tx *sql.Tx, snapshot *store.Snapshot, where *contract.Where, now int64) error
}

// Region creates an absent epoch through EpochComposition, otherwise reads only.
// sql.ErrNoRows means an unknown region/epoch; chunks.ErrEpochEnded is terminal
// for that epoch; chunks.ErrUnavailable is transient while D is not installed.
type RegionSource interface {
	Region(ctx context.Context, tx *sql.Tx, snapshot store.Snapshot, region string, now int64) (*contract.WildsRegionResult, error)
}
type HomeLandSource interface {
	Land(ctx context.Context, tx *sql.Tx, world string, gate int32) (*contract.HomesteadLand, error)
}

// Fakes use the same signatures and transaction as production. Callbacks can
// assert reads/grants share the transaction; returned messages are cloned.
type FakeStory struct {
	Assign func(context.Context, *sql.Tx, store.Snapshot, EchoInput) ([]*contract.EchoAssignment, error)
	Check  func(context.Context, *sql.Tx, store.Snapshot, PaperInput) (bool, error)
	Give   func(context.Context, *sql.Tx, *store.Snapshot, string, int64) (Grant, error)
}

func (f FakeStory) Echoes(ctx context.Context, tx *sql.Tx, snapshot store.Snapshot, in EchoInput) ([]*contract.EchoAssignment, error) {
	if f.Assign == nil {
		return []*contract.EchoAssignment{}, nil
	}
	return f.Assign(ctx, tx, snapshot, in)
}
func (f FakeStory) Eligible(ctx context.Context, tx *sql.Tx, s store.Snapshot, in PaperInput) (bool, error) {
	if f.Check == nil {
		return false, nil
	}
	return f.Check(ctx, tx, s, in)
}
func (f FakeStory) Grant(ctx context.Context, tx *sql.Tx, s *store.Snapshot, paper string, now int64) (Grant, error) {
	if f.Give == nil {
		return Grant{}, nil
	}
	return f.Give(ctx, tx, s, paper, now)
}

type FakePlacement struct {
	Put func(context.Context, *sql.Tx, *store.Snapshot, *contract.Where, int64) error
}

func (f FakePlacement) Record(ctx context.Context, tx *sql.Tx, s *store.Snapshot, w *contract.Where, now int64) error {
	if f.Put == nil {
		s.State.Area = w.Area
		s.State.Position.X = w.X
		s.State.Position.Y = w.Y
		return nil
	}
	return f.Put(ctx, tx, s, w, now)
}

type RegionKey struct{ World, Region, Account string }
type FakeRegions struct {
	Views map[RegionKey]*contract.WildsRegionResult
	Err   error
}

func (f FakeRegions) Region(ctx context.Context, _ *sql.Tx, s store.Snapshot, id string, _ int64) (*contract.WildsRegionResult, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.Err != nil {
		return nil, f.Err
	}
	v := f.Views[RegionKey{s.WorldID, id, s.AccountID}]
	if v == nil {
		return nil, sql.ErrNoRows
	}
	return proto.Clone(v).(*contract.WildsRegionResult), nil
}

type LandKey struct {
	World string
	Gate  int32
}
type FakeLand struct {
	Views map[LandKey]*contract.HomesteadLand
	Err   error
}

func (f FakeLand) Land(ctx context.Context, _ *sql.Tx, world string, gate int32) (*contract.HomesteadLand, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if f.Err != nil {
		return nil, f.Err
	}
	v := f.Views[LandKey{world, gate}]
	if v == nil {
		return nil, sql.ErrNoRows
	}
	return proto.Clone(v).(*contract.HomesteadLand), nil
}

// Lanterns is D-owned. It validates geometry and the daily cap in the same tx;
// it never creates epochs or bumps versions. FallLantern has exactly the reasons
// not-wilds, invalid-place, epoch-missing, daily-cap, or placed with empty reason.
type Lanterns interface {
	PlaceFallen(ctx context.Context, tx *sql.Tx, snapshot *store.Snapshot, epoch *contract.WildsEpoch, where *contract.Where, now int64) (FallLantern, error)
}
type FallLantern struct{ Lantern, Reason, ID, Epoch string }
type FakeLanterns struct {
	Put    func(context.Context, *sql.Tx, *store.Snapshot, *contract.WildsEpoch, *contract.Where, int64) (FallLantern, error)
	Result FallLantern
	Err    error
}

func (f FakeLanterns) PlaceFallen(ctx context.Context, tx *sql.Tx, snapshot *store.Snapshot, epoch *contract.WildsEpoch, where *contract.Where, now int64) (FallLantern, error) {
	if err := ctx.Err(); err != nil {
		return FallLantern{}, err
	}
	if f.Put != nil {
		return f.Put(ctx, tx, snapshot, epoch, where, now)
	}
	return f.Result, f.Err
}
