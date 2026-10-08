// Package profile is the profile-source boundary for account readers.
package profile

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"glimway/server/internal/rules"
)

type Account struct{ ID, Source string }

type Reader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}

// For is the only reader of the mapped profile in storage. None is reserved
// for server guest accounts; 0.3 creates only Habitica accounts.
func For(ctx context.Context, db Reader, account Account) (*rules.Profile, error) {
	switch account.Source {
	case "none":
		return nil, nil
	case "habitica":
		var raw sql.NullString
		if err := db.QueryRowContext(ctx, "SELECT profile_json FROM sync_baselines WHERE account_id=?", account.ID).Scan(&raw); err != nil {
			return nil, err
		}
		if !raw.Valid {
			return nil, fmt.Errorf("missing Habitica profile for account %s", account.ID)
		}
		var p rules.Profile
		if err := json.Unmarshal([]byte(raw.String), &p); err != nil {
			return nil, err
		}
		return &p, nil
	default:
		return nil, fmt.Errorf("unknown profile source %q", account.Source)
	}
}

func EarnsXP(source string) bool { return source == "habitica" }
