package store

import (
	"context"
	"database/sql"

	"glimway/server/internal/rules"
)

// MovePlace saves a place the world chose for the player (a saved place
// past the world border, api/border_settle.go). It takes a new version and
// sets the place at it, so older reports from where they stood are dropped
// and the client follows (it is a move: place_moved_version).
func MovePlace(ctx context.Context, tx *sql.Tx, s *Snapshot, area string, x, y float64) error {
	if err := BumpVersion(ctx, tx, s); err != nil {
		return err
	}
	s.State.Area, s.State.Position = area, rules.Position{X: x, Y: y}
	_, err := tx.ExecContext(ctx, "UPDATE player_place SET area=?,x=?,y=?,place_set_version=?,place_moved_version=? WHERE account_id=?", area, x, y, s.Version, s.Version, s.AccountID)
	return err
}
