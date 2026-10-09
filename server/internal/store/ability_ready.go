package store

import (
	"context"
	"database/sql"
)

// queryer is a transaction or a database: the shared readers take either.
type queryer interface {
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
}

// AbilityReady is each move's cooldown budget (docs/design/crafts.md 4.4,
// `player_ability_ready`): what the report persists and the state serves.
func AbilityReady(ctx context.Context, q queryer, account string) (map[string]float64, error) {
	out := map[string]float64{}
	rows, err := q.QueryContext(ctx, "SELECT ability,ready_at FROM player_ability_ready WHERE account_id=?", account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var id string
		var ready float64
		if err = rows.Scan(&id, &ready); err != nil {
			return nil, err
		}
		out[id] = ready
	}
	return out, rows.Err()
}
