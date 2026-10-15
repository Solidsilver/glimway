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

// WorldMember batches optional companion evidence for public home overlays.
// Missing or malformed profiles read as absent for this projection.
type WorldMember struct {
	ID, Home, Name, Mount, MountHome string
	Profile                          *rules.Profile
}

func WorldMembers(ctx context.Context, db interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}, world string) ([]WorldMember, error) {
	rows, err := db.QueryContext(ctx, `SELECT m.homestead_id,p.account_id,p.display_name,p.profile_source,p.world_id,b.profile_json,COALESCE(c.mount_out,''),COALESCE(c.mount_home,'') FROM homestead_members m JOIN homesteads h ON h.id=m.homestead_id JOIN players p ON p.account_id=m.account_id LEFT JOIN sync_baselines b ON b.account_id=p.account_id LEFT JOIN player_companions c ON c.account_id=p.account_id WHERE h.world_id=? ORDER BY m.joined_at,p.account_id`, world)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []WorldMember{}
	for rows.Next() {
		var m WorldMember
		var source, pworld string
		var raw sql.NullString
		if err = rows.Scan(&m.Home, &m.ID, &m.Name, &source, &pworld, &raw, &m.Mount, &m.MountHome); err != nil {
			return nil, err
		}
		if source == "habitica" && pworld == world && raw.Valid {
			var p rules.Profile
			if json.Unmarshal([]byte(raw.String), &p) == nil {
				m.Profile = &p
			}
		}
		out = append(out, m)
	}
	return out, rows.Err()
}
