package chunks

import (
	"context"
	"database/sql"
)

// MakeGuard has a say over which chunks a read may make (generate and
// store): the API's guard keeps each reader's reads to land round them
// (api/sight.go). A read without one makes whatever it reads (the server's
// own work: turnings, the world lab).
type MakeGuard interface {
	// AllowMake answers nil to let the read make chunk (cx, cy) of an epoch
	// of kind, else the error the read fails with.
	AllowMake(ctx context.Context, tx *sql.Tx, kind string, cx, cy int32) error
}

type makeGuardKey struct{}

// WithMakeGuard gives ctx's reads a guard.
func WithMakeGuard(ctx context.Context, g MakeGuard) context.Context {
	return context.WithValue(ctx, makeGuardKey{}, g)
}

// MakeGuardOf is ctx's guard, or nil.
func MakeGuardOf(ctx context.Context) MakeGuard {
	g, _ := ctx.Value(makeGuardKey{}).(MakeGuard)
	return g
}
