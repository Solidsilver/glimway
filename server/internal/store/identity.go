package store

import (
	"context"
	"database/sql"
)

// AccountForSubject resolves a sign-in identity; sql.ErrNoRows means a newcomer.
func AccountForSubject(ctx context.Context, db interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, method, subject string) (string, error) {
	var id string
	err := db.QueryRowContext(ctx, "SELECT account_id FROM sign_ins WHERE method=? AND subject=?", method, subject).Scan(&id)
	return id, err
}

func HabiticaSubject(ctx context.Context, tx *sql.Tx, account string) (string, error) {
	var subject string
	err := tx.QueryRowContext(ctx, "SELECT subject FROM sign_ins WHERE account_id=? AND method='habitica'", account).Scan(&subject)
	return subject, err
}

// BumpVersion reads the increment back from SQLite: another write in the same
// transaction (mail settlement, for example) may already have advanced it.
func BumpVersion(ctx context.Context, tx *sql.Tx, s *Snapshot) error {
	return tx.QueryRowContext(ctx, "UPDATE players SET version=version+1 WHERE account_id=? RETURNING version", s.AccountID).Scan(&s.Version)
}
