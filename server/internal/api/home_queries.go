package api

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/land"
	"glimway/server/internal/store"
	"net/http"
	"slices"
	"strconv"
	"strings"
)

func members(ctx context.Context, tx *sql.Tx, home string) ([]homeMember, error) {
	rows, err := tx.QueryContext(ctx, "SELECT p.account_id,p.display_name FROM homestead_members m JOIN players p USING(account_id) WHERE m.homestead_id=? ORDER BY m.joined_at,p.account_id", home)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []homeMember{}
	for rows.Next() {
		var m homeMember
		if err = rows.Scan(&m.ID, &m.DisplayName); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func scanInstances(rows *sql.Rows, out []homeInstance) ([]homeInstance, error) {
	defer rows.Close()
	for rows.Next() {
		var v homeInstance
		if err := rows.Scan(&v.ID, &v.ItemDef, &v.Scene, &v.X, &v.Y, &v.Rotation, &v.Name); err != nil {
			return out, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// loadHome is a homestead as `caller` sees it: everything placed, and the
// caller's own pack decorations when they are a member (to set out).
func loadHome(ctx context.Context, tx *sql.Tx, id, caller string, now int64) (homeView, error) {
	h := homeView{ID: id, Outdoor: content.HomeRules.Outdoor(), Items: []homeInstance{}, Cleared: [][2]int{}, Stumps: [][2]int{}, Plants: []homePlantView{}}
	err := tx.QueryRowContext(ctx, "SELECT world_id,gate,tier,posts_bought,vacant_since FROM homesteads WHERE id=?", id).Scan(&h.WorldID, &h.Gate, &h.Tier, &h.PostsBought, &h.VacantSince)
	if err != nil {
		return h, err
	}
	h.Desolate = desolate(h.VacantSince, now)
	h.LandSeed = land.Seed(h.WorldID, h.Gate, content.HomeRules.Land)
	h.NextPost = content.HomeRules.PostCost(h.PostsBought)
	if h.Tier >= 1 {
		g := content.HomeRules.Indoor
		h.Indoor = &g
	}
	if h.Members, err = members(ctx, tx, id); err != nil {
		return h, err
	}
	h.Member = slices.ContainsFunc(h.Members, func(m homeMember) bool { return m.ID == caller })
	rows, err := tx.QueryContext(ctx, "SELECT x,y FROM homestead_cleared WHERE homestead_id=? ORDER BY y,x", id)
	if err != nil {
		return h, err
	}
	for rows.Next() {
		var c [2]int
		if err = rows.Scan(&c[0], &c[1]); err != nil {
			rows.Close()
			return h, err
		}
		h.Cleared = append(h.Cleared, c)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return h, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT x,y FROM homestead_stumps WHERE homestead_id=? ORDER BY y,x", id)
	if err != nil {
		return h, err
	}
	for rows.Next() {
		var st [2]int
		if err = rows.Scan(&st[0], &st[1]); err != nil {
			rows.Close()
			return h, err
		}
		h.Stumps = append(h.Stumps, st)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return h, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT id,item_def,scene,x,y,rotation,name FROM homestead_items WHERE homestead_id=? AND location='placed' ORDER BY id", id)
	if err != nil {
		return h, err
	}
	if h.Items, err = scanInstances(rows, h.Items); err != nil {
		return h, err
	}
	plants, err := homePlants(ctx, tx, id)
	if err != nil {
		return h, err
	}
	h.Plants = plantsOf(h, plants, now)
	if !h.Member {
		return h, nil
	}
	rows, err = tx.QueryContext(ctx, "SELECT id,item_def,scene,x,y,rotation,name FROM homestead_items WHERE account_id=? AND location='inventory' ORDER BY id", caller)
	if err != nil {
		return h, err
	}
	h.Items, err = scanInstances(rows, h.Items)
	return h, err
}

// homePlants reads the land's plants as planted (plantsOf says where they
// stand today).
func homePlants(ctx context.Context, tx *sql.Tx, id string) ([]homePlantView, error) {
	rows, err := tx.QueryContext(ctx, "SELECT id,item_def,x,y,planted_at,planted_day FROM homestead_plants WHERE homestead_id=? ORDER BY planted_at,id", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []homePlantView{}
	for rows.Next() {
		var p homePlantView
		if err = rows.Scan(&p.ID, &p.ItemDef, &p.X, &p.Y, &p.PlantedAt, &p.PlantedDay); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// myHome is the caller's homestead view, or nil.
func myHome(ctx context.Context, tx *sql.Tx, caller string, now int64) (*homeView, error) {
	id, ok, err := memberOf(ctx, tx, caller)
	if err != nil || !ok {
		return nil, err
	}
	h, err := loadHome(ctx, tx, id, caller, now)
	return &h, err
}

func (a *Server) homeRead(w http.ResponseWriter, r *http.Request) error {
	raw, ok := strings.CutPrefix(r.URL.Path, "/api/homestead/gate/")
	gate, err := strconv.Atoi(raw)
	if !ok || err != nil || gate < 0 || strconv.Itoa(gate) != raw {
		return fail(404, "not-found")
	}
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
	if gate >= n {
		return fail(404, "invalid-gate")
	}
	var home *homeView
	var id string
	err = tx.QueryRowContext(ctx, "SELECT id FROM homesteads WHERE world_id=? AND gate=?", s.WorldID, gate).Scan(&id)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == nil {
		h, err := loadHome(ctx, tx, id, s.AccountID, now)
		if err != nil {
			return err
		}
		home = &h
	}
	m, err := materials(ctx, tx, s.AccountID)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Gate      int            `json:"gate"`
		LandSeed  uint32         `json:"landSeed"`
		Home      *homeView      `json:"home"`
		Materials map[string]int `json:"materials"`
	}{s, gate, land.Seed(s.WorldID, gate, content.HomeRules.Land), home, m})
}
