// Package ports fixes the transaction-aware handoffs between server domains.
package ports

import (
	"context"
	"database/sql"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

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
// affected account once. StoryRules owns story grants; Placement owns saved positions.
type StoryRules interface {
	Echoes(ctx context.Context, tx *sql.Tx, snapshot store.Snapshot, input EchoInput) ([]*contract.EchoAssignment, error)
	Eligible(ctx context.Context, tx *sql.Tx, snapshot store.Snapshot, input PaperInput) (bool, error)
	Grant(ctx context.Context, tx *sql.Tx, snapshot *store.Snapshot, paper string, now int64) (Grant, error)
}
type Placement interface {
	Record(ctx context.Context, tx *sql.Tx, snapshot *store.Snapshot, where *contract.Where, now int64) error
}

type HomeLandSource interface {
	Land(ctx context.Context, tx *sql.Tx, world string, gate int32) (*contract.HomesteadLand, error)
}

// Lanterns owns fallen-lantern placement. It validates geometry and the daily cap in the same tx;
// it never creates epochs or bumps versions. FallLantern has exactly the reasons
// not-wilds, invalid-place, epoch-missing, daily-cap, or placed with empty reason.
type Lanterns interface {
	PlaceFallen(ctx context.Context, tx *sql.Tx, snapshot *store.Snapshot, epoch *contract.WildsEpoch, where *contract.Where, now int64) (FallLantern, error)
}
type FallLantern struct{ Lantern, Reason, ID, Epoch string }
