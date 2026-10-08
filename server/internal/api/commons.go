package api

import (
	"context"
	"database/sql"
	"net/http"
)

type gateView struct {
	Gate     int          `json:"gate"`
	HomeID   *string      `json:"homeId"`
	Names    []string     `json:"names"`
	Members  []homeMember `json:"members"`
	Tier     int          `json:"tier"`
	Desolate bool         `json:"desolate"`
	Mine     bool         `json:"mine"`
	Price    *int         `json:"price"`
	// Reclaim: the caller was on this vacant home's deed and can take it back.
	Reclaim      bool `json:"reclaim"`
	Shelf        bool `json:"shelf"`
	ShelfStocked bool `json:"shelfStocked"`
}

type person struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type inviteView struct {
	HomeID          string `json:"homeId"`
	Gate            int    `json:"gate"`
	From            person `json:"from"`
	To              person `json:"to"`
	ExpiresAt       int64  `json:"expiresAt"`
	FromConfirmedAt *int64 `json:"fromConfirmedAt"`
	ToConfirmedAt   *int64 `json:"toConfirmedAt"`
}

func (a *Server) commons(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now().Unix()
	if err = settleHomes(ctx, tx, s.WorldID, now); err != nil {
		return err
	}
	n, err := gateCount(ctx, tx, s.WorldID)
	if err != nil {
		return err
	}
	mineID, _, err := memberOf(ctx, tx, s.AccountID)
	if err != nil {
		return err
	}
	gates := make([]gateView, n)
	for g := range gates {
		gates[g] = gateView{Gate: g, Names: []string{}, Members: []homeMember{}}
	}
	rows, err := tx.QueryContext(ctx, "SELECT id,gate,tier,vacant_since FROM homesteads WHERE world_id=? ORDER BY gate", s.WorldID)
	if err != nil {
		return err
	}
	type claimed struct {
		id          string
		gate, tier  int
		vacantSince *int64
	}
	all := []claimed{}
	for rows.Next() {
		var v claimed
		if err = rows.Scan(&v.id, &v.gate, &v.tier, &v.vacantSince); err != nil {
			rows.Close()
			return err
		}
		all = append(all, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	var mine *struct {
		HomeID string `json:"homeId"`
		Gate   int    `json:"gate"`
	}
	for _, v := range all {
		g := &gates[v.gate]
		id := v.id
		g.HomeID, g.Tier, g.Desolate, g.Mine = &id, v.tier, desolate(v.vacantSince, now), v.id == mineID
		g.Reclaim = v.vacantSince != nil && mineID == "" && departed(ctx, tx, v.id, s.AccountID)
		if g.Members, err = members(ctx, tx, v.id); err != nil {
			return err
		}
		for _, m := range g.Members {
			g.Names = append(g.Names, m.DisplayName)
		}
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM homestead_items WHERE homestead_id=? AND scene='gate')", v.id).Scan(&g.Shelf); err != nil {
			return err
		}
		if g.Shelf {
			if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM gate_shelf_slots WHERE homestead_id=?)", v.id).Scan(&g.ShelfStocked); err != nil {
				return err
			}
		}
		if g.Mine {
			mine = &struct {
				HomeID string `json:"homeId"`
				Gate   int    `json:"gate"`
			}{v.id, v.gate}
		}
	}
	for g := range gates {
		if gates[g].HomeID == nil {
			p, err := deedPrice(ctx, tx, s.AccountID, s.WorldID, g)
			if err != nil {
				return err
			}
			gates[g].Price = &p
		}
	}
	invites, err := invitesFor(ctx, tx, s.WorldID, s.AccountID, mineID, now)
	if err != nil {
		return err
	}
	return a.finishRead(w, r, tx, s, struct {
		Gates     []gateView   `json:"gates"`
		GateCount int          `json:"gateCount"`
		Mine      any          `json:"mine"`
		Invites   []inviteView `json:"invites"`
	}{gates, n, mine, invites})
}

// invitesFor lists unexpired invites to the caller or from their homestead.
func invitesFor(ctx context.Context, tx *sql.Tx, world, caller, home string, now int64) ([]inviteView, error) {
	rows, err := tx.QueryContext(ctx, `SELECT i.homestead_id,h.gate,i.from_id,f.display_name,i.to_id,t.display_name,i.expires_at,i.from_confirmed_at,i.to_confirmed_at
FROM homestead_invites i JOIN homesteads h ON h.id=i.homestead_id JOIN players f ON f.account_id=i.from_id JOIN players t ON t.account_id=i.to_id
WHERE h.world_id=? AND i.expires_at>? AND (i.to_id=? OR i.homestead_id=?) ORDER BY i.created_at,i.to_id`, world, now, caller, home)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []inviteView{}
	for rows.Next() {
		var v inviteView
		if err = rows.Scan(&v.HomeID, &v.Gate, &v.From.ID, &v.From.Name, &v.To.ID, &v.To.Name, &v.ExpiresAt, &v.FromConfirmedAt, &v.ToConfirmedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
