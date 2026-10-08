package api

import (
	"context"
	"database/sql"
	"fmt"
	"glimway/content"
	"glimway/server/internal/land"
	"glimway/server/internal/store"
	"slices"
)

// ground is a homestead's land as the server validates it.
type ground struct {
	land    land.Land
	cleared map[[2]int]bool
}

func groundOf(h homeView) ground {
	g := ground{land.Generate(h.LandSeed, content.HomeRules.Land), map[[2]int]bool{}}
	for _, c := range h.Cleared {
		g.cleared[c] = true
	}
	return g
}

type rect struct{ x, y, w, h int }

func (a rect) overlaps(b rect) bool {
	return a.x < b.x+b.w && a.x+a.w > b.x && a.y < b.y+b.h && a.y+a.h > b.y
}

func footprint(id string, rotation int) (int, int) {
	v, _ := content.HomeItemFor(id)
	w, h := v.Footprint[0], v.Footprint[1]
	if rotation == 90 || rotation == 270 {
		return h, w
	}
	return w, h
}

func placedRect(v homeInstance) (rect, bool) {
	if v.Scene == nil || v.X == nil || v.Y == nil || v.Rotation == nil {
		return rect{}, false
	}
	if _, ok := content.HomeItemFor(v.ItemDef); !ok {
		return rect{}, false
	}
	w, h := footprint(v.ItemDef, *v.Rotation)
	return rect{*v.X, *v.Y, w, h}, true
}

// connectedLights: the home's own light and every placed post (but
// `except`) whose light connects back to it: a post counts once its tile
// stands in the home's light or in the light of a post that already counts.
// Posts can't hold each other up out in the dark.
func connectedLights(items []homeInstance, except string) []land.Light {
	s := content.HomeRules.Land.StartLight
	out := []land.Light{{X: s.X, Y: s.Y, Radius: s.Radius}}
	waiting := []homeInstance{}
	for _, v := range items {
		if v.ItemDef == content.HomeRules.LanternPosts.Item && v.ID != except && v.Scene != nil && *v.Scene == "outdoor" && v.X != nil && v.Y != nil {
			waiting = append(waiting, v)
		}
	}
	for grew := true; grew; {
		grew = false
		for i := 0; i < len(waiting); i++ {
			v := waiting[i]
			if land.Lit(out, *v.X, *v.Y) {
				out = append(out, land.Light{X: *v.X, Y: *v.Y, Radius: content.HomeRules.LanternPosts.Radius})
				waiting = append(waiting[:i], waiting[i+1:]...)
				i--
				grew = true
			}
		}
	}
	return out
}

func rectLit(lights []land.Light, r rect) bool {
	for y := r.y; y < r.y+r.h; y++ {
		for x := r.x; x < r.x+r.w; x++ {
			if !land.Lit(lights, x, y) {
				return false
			}
		}
	}
	return true
}

// everythingLit: every outdoor piece stands in light connected to the home's
// own lamp (a post by light other than its own), so land never floats.
func everythingLit(items []homeInstance) bool {
	all := connectedLights(items, "")
	for _, v := range items {
		if v.Scene == nil || *v.Scene != "outdoor" {
			continue
		}
		lights := all
		if v.ItemDef == content.HomeRules.LanternPosts.Item {
			lights = connectedLights(items, v.ID)
		}
		if r, ok := placedRect(v); ok && !rectLit(lights, r) {
			return false
		}
	}
	return true
}

func placedItems(h homeView) []homeInstance {
	out := []homeInstance{}
	for _, v := range h.Items {
		if v.Scene != nil {
			out = append(out, v)
		}
	}
	return out
}

// validatePlacement mirrors checkPlacement in src/lib/homestead.ts; the
// server owns the buildable area.
func validatePlacement(h homeView, item homeInstance, r homeRequest) error {
	def, ok := content.HomeItemFor(item.ItemDef)
	if !ok {
		return fail(400, "invalid-item")
	}
	if r.Scene == "gate" {
		if !slices.Contains(def.Where, "gate") {
			return fail(400, "invalid-placement")
		}
		if h.Tier < def.MinTier {
			return fail(409, "tier-required")
		}
		for _, v := range placedItems(h) {
			if v.ID != item.ID && v.Scene != nil && *v.Scene == "gate" {
				return fail(409, "placement-overlap")
			}
		}
		return nil
	}
	if r.X == nil || r.Y == nil || r.Rotation == nil || !slices.Contains([]int{0, 90, 180, 270}, *r.Rotation) || !slices.Contains(def.Where, r.Scene) {
		return fail(400, "invalid-placement")
	}
	if h.Tier < def.MinTier || (r.Scene == "indoor" && h.Indoor == nil) {
		return fail(409, "tier-required")
	}
	grid, reserved := h.Outdoor, content.HomeRules.OutdoorReserved
	if r.Scene == "indoor" {
		grid, reserved = *h.Indoor, content.HomeRules.IndoorReserved
	}
	w, ht := footprint(def.ID, *r.Rotation)
	here := rect{*r.X, *r.Y, w, ht}
	if here.x < 0 || here.y < 0 || here.x > grid.Width-w || here.y > grid.Height-ht {
		return fail(409, "out-of-bounds")
	}
	// The home site, the gate path and the doorway are kept clear.
	for _, v := range reserved {
		if here.overlaps(rect{v.X, v.Y, v.W, v.H}) {
			return fail(409, "placement-overlap")
		}
	}
	placed := placedItems(h)
	for _, v := range placed {
		if v.ID == item.ID || *v.Scene != r.Scene {
			continue
		}
		if o, ok := placedRect(v); ok && here.overlaps(o) {
			return fail(409, "placement-overlap")
		}
	}
	if r.Scene != "outdoor" {
		return nil
	}
	// Nothing goes down on top of something growing.
	for _, p := range h.Plants {
		if here.overlaps(rect{p.X, p.Y, 1, 1}) {
			return fail(409, "plant-in-the-way")
		}
	}
	g := groundOf(h)
	for y := here.y; y < here.y+here.h; y++ {
		for x := here.x; x < here.x+here.w; x++ {
			if !land.Buildable(g.land.Effective(g.cleared, x, y)) {
				return fail(409, "land-blocked")
			}
		}
	}
	if !rectLit(connectedLights(placed, item.ID), here) {
		return fail(409, "unlit")
	}
	if def.ID == content.HomeRules.LanternPosts.Item {
		scene, x, y, rot := r.Scene, *r.X, *r.Y, *r.Rotation
		moved := append(slices.DeleteFunc(slices.Clone(placed), func(v homeInstance) bool { return v.ID == item.ID }), homeInstance{ID: item.ID, ItemDef: item.ItemDef, Scene: &scene, X: &x, Y: &y, Rotation: &rot})
		if !everythingLit(moved) {
			return fail(409, "post-holds-land")
		}
	}
	return nil
}

func arrange(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, op string, req homeRequest, now int64) (string, error) {
	var item *homeInstance
	for i := range h.Items {
		if h.Items[i].ID == req.ItemID {
			item = &h.Items[i]
			break
		}
	}
	if item == nil {
		return "", fail(404, "item-not-owned")
	}
	if op == "place" && item.Scene != nil {
		return "", fail(409, "already-placed")
	}
	if (op == "move" || op == "remove") && item.Scene == nil {
		return "", fail(409, "not-placed")
	}
	var err error
	post := item.ItemDef == content.HomeRules.LanternPosts.Item
	switch op {
	case "remove":
		if item.Scene != nil && *item.Scene == "gate" {
			var n int
			if err = tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM gate_shelf_slots WHERE homestead_id=?", h.ID).Scan(&n); err != nil {
				return "", err
			}
			if n > 0 {
				return "", fail(409, "shelf-not-empty")
			}
		}
		rest := slices.DeleteFunc(placedItems(h), func(v homeInstance) bool { return v.ID == item.ID })
		if post && !everythingLit(rest) {
			return "", fail(409, "post-holds-land")
		}
		// Whoever puts it away carries it.
		_, err = tx.ExecContext(ctx, "UPDATE homestead_items SET location='inventory',habitica_id=?,homestead_id=NULL,scene=NULL,x=NULL,y=NULL,rotation=NULL,name=NULL WHERE id=?", s.HabiticaID, item.ID)
		if err == nil {
			err = currency(ctx, tx, s.HabiticaID, "decoration:"+item.ItemDef, 1, "homestead-remove", item.ID, now)
		}
	case "place":
		var name any
		if post {
			n, ok := "", false
			if req.Name != nil {
				n, ok = cleanPostName(*req.Name)
			}
			if !ok {
				return "", fail(400, "name-required")
			}
			name = n
		}
		if err = validatePlacement(h, *item, req); err != nil {
			return "", err
		}
		x, y, rot := 0, 0, 0
		if req.X != nil {
			x = *req.X
		}
		if req.Y != nil {
			y = *req.Y
		}
		if req.Rotation != nil {
			rot = *req.Rotation
		}
		_, err = tx.ExecContext(ctx, "UPDATE homestead_items SET location='placed',habitica_id=NULL,homestead_id=?,scene=?,x=?,y=?,rotation=?,name=? WHERE id=? AND location='inventory' AND habitica_id=?", h.ID, req.Scene, x, y, rot, name, item.ID, s.HabiticaID)
		if err == nil {
			err = currency(ctx, tx, s.HabiticaID, "decoration:"+item.ItemDef, -1, "homestead-place", item.ID, now)
		}
	case "move":
		if req.Scene == "gate" {
			return "", fail(400, "invalid-placement")
		}
		if err = validatePlacement(h, *item, req); err != nil {
			return "", err
		}
		_, err = tx.ExecContext(ctx, "UPDATE homestead_items SET scene=?,x=?,y=?,rotation=? WHERE id=?", req.Scene, *req.X, *req.Y, *req.Rotation, item.ID)
		if err == nil {
			err = currency(ctx, tx, s.HabiticaID, "decoration:"+item.ItemDef, 0, "homestead-move", item.ID, now)
		}
	}
	return item.ID, err
}

func clearTile(ctx context.Context, tx *sql.Tx, s *store.Snapshot, h homeView, req homeRequest, now int64) error {
	if req.X == nil || req.Y == nil {
		return fail(400, "invalid-placement")
	}
	x, y := *req.X, *req.Y
	g := groundOf(h)
	if x < 0 || y < 0 || x >= g.land.Width || y >= g.land.Height || !land.Clearable(g.land.At(x, y)) {
		return fail(409, "not-clearable")
	}
	if g.cleared[[2]int{x, y}] {
		return fail(409, "already-cleared")
	}
	if !land.Lit(connectedLights(placedItems(h), ""), x, y) {
		return fail(409, "unlit")
	}
	if err := debitEmbers(ctx, tx, s, content.HomeRules.ClearTileEmbers, "homestead-clear", fmt.Sprintf("%s:%d,%d", h.ID, x, y), now); err != nil {
		return err
	}
	// Cleared ground has no stump: drop a kept one with it.
	if _, err := tx.ExecContext(ctx, "DELETE FROM homestead_stumps WHERE homestead_id=? AND x=? AND y=?", h.ID, x, y); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "INSERT INTO homestead_cleared VALUES(?,?,?)", h.ID, x, y)
	return err
}
