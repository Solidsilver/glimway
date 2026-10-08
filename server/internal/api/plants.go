package api

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/land"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
)

// plantGround: the tiles a plant can stand on (or wander onto): open
// grass, off the home site and gate path, clear of placed pieces. Worked
// out once per read of the land.
func plantGround(h homeView) map[[2]int]bool {
	g := groundOf(h)
	blocked := map[[2]int]bool{}
	mark := func(r rect) {
		for y := r.y; y < r.y+r.h; y++ {
			for x := r.x; x < r.x+r.w; x++ {
				blocked[[2]int{x, y}] = true
			}
		}
	}
	for _, v := range content.HomeRules.OutdoorReserved {
		mark(rect{v.X, v.Y, v.W, v.H})
	}
	for _, v := range placedItems(h) {
		if r, ok := placedRect(v); ok && *v.Scene == "outdoor" {
			mark(r)
		}
	}
	open := map[[2]int]bool{}
	for y := 0; y < g.land.Height; y++ {
		for x := 0; x < g.land.Width; x++ {
			if g.land.Effective(g.cleared, x, y) == land.Grass && !blocked[[2]int{x, y}] {
				open[[2]int{x, y}] = true
			}
		}
	}
	return open
}

// plantWanderDays and plantWanderReach: an unlit plant takes at most one
// step a day, never more than a couple of tiles from where it was set.
const (
	plantWanderDays  = 60
	plantWanderReach = 2
)

// plantsOf: where the land's plants stand today. A plant in lamplight
// stays put; one outside it wanders a little each day (docs/items/
// overview.md, "The drift and your things"). Worked out from the planting
// and the day alone, so reading the land never writes it.
//
// The walk is replayed against today's land (its lamps, pieces and other
// plants) over the last plantWanderDays days, so when the land changes
// (a post set, a bench placed, a plant set nearby) or the window slides
// on, a plant can jump to another spot within its reach at once rather
// than a step. Harmless, and in keeping with the drift.
func plantsOf(h homeView, raw []homePlantView, now int64) []homePlantView {
	lights := connectedLights(placedItems(h), "")
	open := plantGround(h)
	// How many plants stand on each tile (a new plant can go where an old
	// one started out; counting keeps one from stepping back onto it).
	taken := map[[2]int]int{}
	for _, p := range raw {
		taken[[2]int{p.X, p.Y}]++
	}
	today := utcDay(now)
	dirs := [][2]int{{0, 1}, {0, -1}, {1, 0}, {-1, 0}}
	out := make([]homePlantView, 0, len(raw))
	for _, p := range raw {
		x, y := p.X, p.Y
		for d := max(p.PlantedDay+1, today-plantWanderDays+1); d <= today; d++ {
			if land.Lit(lights, x, y) {
				break
			}
			step := dirs[wilds.NewRng(wilds.Hash(p.ID, "plant-wander", int(d))).NextInt(len(dirs))]
			to := [2]int{x + step[0], y + step[1]}
			if abs(to[0]-p.X) > plantWanderReach || abs(to[1]-p.Y) > plantWanderReach || !open[to] || taken[to] > 0 {
				continue
			}
			if taken[[2]int{x, y}]--; taken[[2]int{x, y}] <= 0 {
				delete(taken, [2]int{x, y})
			}
			taken[to]++
			x, y = to[0], to[1]
		}
		p.X, p.Y, p.Lit = x, y, land.Lit(lights, x, y)
		out = append(out, p)
	}
	return out
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// plant: a seed or sapling set into your own land at a tile beside you.
func (a *Server) plant(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest, now int64, out *itemResult) error {
	if !content.IsGatheringSeed(req.ItemDef) {
		return fail(400, "not-a-seed")
	}
	h, err := ownLand(ctx, tx, s, s.State.Area, now, "cannot-plant-here")
	if err != nil {
		return err
	}
	if req.Tile == nil {
		return fail(400, "tile-required")
	}
	x, y := (*req.Tile)[0], (*req.Tile)[1]
	if !nearTile(s, s.State.Area, x, y, 2) {
		return fail(409, "too-far-away")
	}
	// A home tends so many plants, then the ground is full.
	if len(h.Plants) >= content.GatheringRules.PlantsPerHome || !plantGround(*h)[[2]int{x, y}] {
		return fail(409, "land-blocked")
	}
	for _, p := range h.Plants {
		if p.X == x && p.Y == y {
			return fail(409, "land-blocked")
		}
	}
	if _, err = packTake(ctx, tx, s.AccountID, req.ItemDef, nil, 1, "plant", req.ItemDef, now); err != nil {
		return err
	}
	id, err := store.Random()
	if err != nil {
		return err
	}
	day := utcDay(now)
	if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_plants VALUES(?,?,?,?,?,?,?)", id, h.ID, req.ItemDef, x, y, now, day); err != nil {
		return err
	}
	out.Plant = &homePlantView{ID: id, ItemDef: req.ItemDef, X: x, Y: y, PlantedAt: now, PlantedDay: day, Lit: land.Lit(connectedLights(placedItems(*h), ""), x, y)}
	return nil
}
