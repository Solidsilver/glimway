package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/store"
	"net/http"
	"slices"
	"strings"
)

type plotRect struct {
	X      int `json:"x"`
	Y      int `json:"y"`
	Width  int `json:"width"`
	Height int `json:"height"`
}

func plotBounds(index int) plotRect {
	h := content.HomeRules
	c := h.Commons
	return plotRect{(c.OriginX + index%c.Columns*(h.Outdoor.Width+c.Gap)) * c.TileSize, (c.OriginY + index/c.Columns*(h.Outdoor.Height+c.Gap)) * c.TileSize, h.Outdoor.Width * c.TileSize, h.Outdoor.Height * c.TileSize}
}

type homeInstance struct {
	ID       string  `json:"id"`
	ItemDef  string  `json:"itemDef"`
	Scene    *string `json:"scene"`
	X        *int    `json:"x"`
	Y        *int    `json:"y"`
	Rotation *int    `json:"rotation"`
}
type homeView struct {
	OwnerID     string            `json:"ownerId"`
	DisplayName string            `json:"displayName"`
	WorldID     string            `json:"worldId"`
	PlotIndex   *int              `json:"plotIndex"`
	Tier        int               `json:"tier"`
	Bounds      *plotRect         `json:"bounds"`
	Outdoor     content.HomeGrid  `json:"outdoor"`
	Indoor      *content.HomeGrid `json:"indoor"`
	Items       []homeInstance    `json:"items"`
}

func ensureHome(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (bool, error) {
	var n int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM homesteads WHERE habitica_id=?", s.HabiticaID).Scan(&n); err != nil {
		return false, err
	}
	if n > 0 {
		return false, nil
	}
	_, err := tx.ExecContext(ctx, `INSERT INTO homesteads(habitica_id,world_id,plot_index) SELECT ?,?,COALESCE(MAX(plot_index)+1,0) FROM homesteads WHERE world_id=?`, s.HabiticaID, s.WorldID, s.WorldID)
	if err != nil {
		return false, err
	}
	return true, store.Credit(ctx, tx, s, 0, 0, "homestead-grant", "tier-0", nil, now)
}
func loadHome(ctx context.Context, tx *sql.Tx, id string) (homeView, error) {
	h := homeView{OwnerID: id, Outdoor: content.HomeRules.Outdoor, Items: []homeInstance{}}
	err := tx.QueryRowContext(ctx, "SELECT p.display_name,p.world_id,h.plot_index,COALESCE(h.tier,0) FROM players p LEFT JOIN homesteads h USING(habitica_id) WHERE p.habitica_id=?", id).Scan(&h.DisplayName, &h.WorldID, &h.PlotIndex, &h.Tier)
	if err != nil {
		return h, err
	}
	if h.PlotIndex != nil {
		b := plotBounds(*h.PlotIndex)
		h.Bounds = &b
	}
	if h.Tier >= 1 {
		g := content.HomeRules.Indoor
		h.Indoor = &g
	}
	rows, err := tx.QueryContext(ctx, "SELECT id,item_def,scene,x,y,rotation FROM homestead_items WHERE habitica_id=? ORDER BY id", id)
	if err != nil {
		return h, err
	}
	defer rows.Close()
	for rows.Next() {
		var v homeInstance
		if err = rows.Scan(&v.ID, &v.ItemDef, &v.Scene, &v.X, &v.Y, &v.Rotation); err != nil {
			return h, err
		}
		h.Items = append(h.Items, v)
	}
	return h, rows.Err()
}
func (a *Server) homeRead(w http.ResponseWriter, r *http.Request) error {
	id := strings.TrimPrefix(r.URL.Path, "/api/homestead/")
	if id == "" || len(id) > 128 || strings.Contains(id, "/") {
		return fail(404, "not-found")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	var world string
	err = tx.QueryRowContext(ctx, "SELECT world_id FROM players WHERE habitica_id=?", id).Scan(&world)
	if err == sql.ErrNoRows {
		return fail(404, "not-found")
	}
	if err != nil {
		return err
	}
	if world != s.WorldID {
		return fail(403, "world-access-denied")
	}
	if s.SaveOrigin == nil {
		return fail(409, "origin-required")
	}
	// Reads allocate only the caller's plot. The zero-delta campsite audit does
	// not change progress, balances or revisions, including for visiting members.
	if _, err = ensureHome(ctx, tx, &s, a.Config.Now().Unix()); err != nil {
		return err
	}
	h, err := loadHome(ctx, tx, id)
	if err != nil {
		return err
	}
	m, err := materials(ctx, tx, s.HabiticaID)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Home      homeView       `json:"home"`
		Materials map[string]int `json:"materials"`
	}{s, h, m})
}
func (a *Server) commons(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now().Unix()
	if s.SaveOrigin == nil {
		return fail(409, "origin-required")
	}
	if _, err = ensureHome(ctx, tx, &s, now); err != nil {
		return err
	}
	type plot struct {
		OwnerID     string    `json:"ownerId"`
		DisplayName string    `json:"displayName"`
		Tier        int       `json:"tier"`
		PlotIndex   *int      `json:"plotIndex"`
		Bounds      *plotRect `json:"bounds"`
	}
	plots := []plot{}
	rows, err := tx.QueryContext(ctx, "SELECT p.habitica_id,p.display_name,COALESCE(h.tier,0),h.plot_index FROM players p LEFT JOIN homesteads h USING(habitica_id) WHERE p.world_id=? ORDER BY h.plot_index IS NULL,h.plot_index,p.habitica_id", s.WorldID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var p plot
		if err = rows.Scan(&p.OwnerID, &p.DisplayName, &p.Tier, &p.PlotIndex); err != nil {
			rows.Close()
			return err
		}
		if p.PlotIndex != nil {
			b := plotBounds(*p.PlotIndex)
			p.Bounds = &b
		}
		plots = append(plots, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Plots []plot `json:"plots"`
	}{s, plots})
}

type homeRequest struct {
	Mutation
	Key      string          `json:"key"`
	Progress json.RawMessage `json:"progress,omitempty"`
	ItemDef  string          `json:"itemDef,omitempty"`
	ItemID   string          `json:"itemId,omitempty"`
	Tier     *int            `json:"tier,omitempty"`
	Scene    string          `json:"scene,omitempty"`
	X        *int            `json:"x,omitempty"`
	Y        *int            `json:"y,omitempty"`
	Rotation *int            `json:"rotation,omitempty"`
}

func (a *Server) homeMutation(w http.ResponseWriter, r *http.Request) error {
	var req homeRequest
	if err := decode(w, r, &req); err != nil {
		return err
	}
	return a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if _, err := ensureHome(ctx, tx, s, now); err != nil {
			return nil, err
		}
		h, err := loadHome(ctx, tx, s.HabiticaID)
		if err != nil {
			return nil, err
		}
		op := strings.TrimPrefix(r.URL.Path, "/api/homestead/")
		instanceID := ""
		switch op {
		case "upgrade":
			if req.Tier == nil || *req.Tier != h.Tier+1 || *req.Tier >= len(content.HomeRules.Tiers) || !content.HomeRules.Tiers[*req.Tier].Purchasable {
				return nil, fail(409, "tier-unavailable")
			}
			if err = debitEmbers(ctx, tx, s, content.HomeRules.Tiers[*req.Tier].Embers, "homestead-upgrade", content.HomeRules.Tiers[*req.Tier].ID, now); err != nil {
				return nil, err
			}
			_, err = tx.ExecContext(ctx, "UPDATE homesteads SET tier=? WHERE habitica_id=?", *req.Tier, s.HabiticaID)
		case "buy":
			def, ok := content.HomeItemFor(req.ItemDef)
			if !ok {
				return nil, fail(400, "invalid-item")
			}
			if def.MinTier > h.Tier {
				return nil, fail(409, "tier-required")
			}
			if def.Embers > 0 {
				err = debitEmbers(ctx, tx, s, def.Embers, "homestead-buy", def.ID, now)
			} else {
				var m map[string]int
				m, err = materials(ctx, tx, s.HabiticaID)
				if err != nil {
					return nil, err
				}
				for material, n := range def.Materials {
					if m[material] < n {
						return nil, fail(409, "insufficient-materials")
					}
				}
				// Stable ledger order makes audits and replay comparisons straightforward.
				for _, material := range content.WildsRules.Materials {
					if n := def.Materials[material]; n > 0 {
						if err = materialChange(ctx, tx, s.HabiticaID, material, -n, "homestead-buy", def.ID, now); err != nil {
							return nil, err
						}
					}
				}
			}
			if err != nil {
				return nil, err
			}
			instanceID, err = store.Random()
			if err == nil {
				_, err = tx.ExecContext(ctx, "INSERT INTO homestead_items(id,habitica_id,item_def) VALUES(?,?,?)", instanceID, s.HabiticaID, def.ID)
			}
			if err == nil {
				err = currency(ctx, tx, s.HabiticaID, "decoration:"+def.ID, 1, "homestead-buy", instanceID, now)
			}
		case "place", "move", "remove":
			var item *homeInstance
			for i := range h.Items {
				if h.Items[i].ID == req.ItemID {
					item = &h.Items[i]
					break
				}
			}
			if item == nil {
				return nil, fail(404, "item-not-owned")
			}
			instanceID = item.ID
			if op == "place" && item.Scene != nil {
				return nil, fail(409, "already-placed")
			}
			if (op == "move" || op == "remove") && item.Scene == nil {
				return nil, fail(409, "not-placed")
			}
			if op == "remove" {
				_, err = tx.ExecContext(ctx, "UPDATE homestead_items SET scene=NULL,x=NULL,y=NULL,rotation=NULL WHERE id=?", item.ID)
			} else {
				if err = validatePlacement(h, *item, req); err != nil {
					return nil, err
				}
				_, err = tx.ExecContext(ctx, "UPDATE homestead_items SET scene=?,x=?,y=?,rotation=? WHERE id=?", req.Scene, *req.X, *req.Y, *req.Rotation, item.ID)
			}
			if err == nil {
				err = currency(ctx, tx, s.HabiticaID, "decoration:"+item.ItemDef, 0, "homestead-"+op, item.ID, now)
			}
		}
		if err != nil {
			return nil, err
		}
		h, err = loadHome(ctx, tx, s.HabiticaID)
		if err != nil {
			return nil, err
		}
		m, err := materials(ctx, tx, s.HabiticaID)
		if err != nil {
			return nil, err
		}
		return struct {
			Home      homeView       `json:"home"`
			Materials map[string]int `json:"materials"`
			ItemID    string         `json:"itemId,omitempty"`
		}{h, m, instanceID}, nil
	})
}
func footprint(id string, rotation int) (int, int) {
	v, _ := content.HomeItemFor(id)
	w, h := v.Footprint[0], v.Footprint[1]
	if rotation == 90 || rotation == 270 {
		return h, w
	}
	return w, h
}
func validatePlacement(h homeView, item homeInstance, r homeRequest) error {
	def, ok := content.HomeItemFor(item.ItemDef)
	if !ok {
		return fail(400, "invalid-item")
	}
	if r.X == nil || r.Y == nil || r.Rotation == nil || !slices.Contains([]int{0, 90, 180, 270}, *r.Rotation) || !slices.Contains(def.Where, r.Scene) {
		return fail(400, "invalid-placement")
	}
	if h.Tier < 1 || h.Tier < def.MinTier || (r.Scene == "indoor" && h.Indoor == nil) {
		return fail(409, "tier-required")
	}
	grid := h.Outdoor
	if r.Scene == "indoor" {
		grid = *h.Indoor
	}
	w, ht := footprint(def.ID, *r.Rotation)
	x, y := *r.X, *r.Y
	if x < 0 || y < 0 || x > grid.Width-w || y > grid.Height-ht {
		return fail(409, "out-of-bounds")
	}
	for _, v := range h.Items {
		if v.ID == item.ID || v.Scene == nil || *v.Scene != r.Scene {
			continue
		}
		vw, vh := footprint(v.ItemDef, *v.Rotation)
		if x < *v.X+vw && x+w > *v.X && y < *v.Y+vh && y+ht > *v.Y {
			return fail(409, "placement-overlap")
		}
	}
	return nil
}
func checkHomeRest(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) error {
	if s.State.Area != "commons" {
		return fail(409, "not-at-own-plot")
	}
	if _, err := ensureHome(ctx, tx, s, now); err != nil {
		return err
	}
	h, err := loadHome(ctx, tx, s.HabiticaID)
	if err != nil {
		return err
	}
	b := h.Bounds
	if s.State.Position.X < float64(b.X) || s.State.Position.Y < float64(b.Y) || s.State.Position.X >= float64(b.X+b.Width) || s.State.Position.Y >= float64(b.Y+b.Height) {
		return fail(409, "not-at-own-plot")
	}
	return nil
}
