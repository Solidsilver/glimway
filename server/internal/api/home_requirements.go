package api

import (
	"context"
	"database/sql"
	"glimway/server/internal/store"
)

// Membership always precedes tier/piece checks, preserving refusal precedence.
func memberHomeAtTier(ctx context.Context, tx *sql.Tx, s *store.Snapshot, minTier int) (string, error) {
	home, ok, err := memberOf(ctx, tx, s.AccountID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fail(409, "not-a-member")
	}
	var tier int
	if err = tx.QueryRowContext(ctx, "SELECT tier FROM homesteads WHERE id=?", home).Scan(&tier); err != nil {
		return "", err
	}
	if tier < minTier {
		return "", fail(409, "tier-required")
	}
	return home, nil
}

func memberHomeWithPiece(ctx context.Context, tx *sql.Tx, s *store.Snapshot, piece, refusal string) (string, error) {
	home, ok, err := memberOf(ctx, tx, s.AccountID)
	if err != nil {
		return "", err
	}
	if !ok {
		return "", fail(409, "not-a-member")
	}
	var placed bool
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM homestead_items WHERE homestead_id=? AND item_def=? AND location='placed')", home, piece).Scan(&placed); err != nil {
		return "", err
	}
	if !placed {
		return "", fail(409, refusal)
	}
	return home, nil
}
