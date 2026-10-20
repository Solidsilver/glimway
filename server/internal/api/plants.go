package api

import (
	"context"
	"database/sql"
	"errors"
	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/land"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"slices"
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
	for _, v := range content.HomeOutdoorReserved(h.Gate) {
		mark(rect{int(v.GetX()), int(v.GetY()), int(v.GetW()), int(v.GetH())})
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
		// The backland's plants stand in the lot lantern's light.
		if chunks.InBackland(x, y, h.Gate) {
			p.Lit = h.Lantern.Lit
			out = append(out, p)
			continue
		}
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
		// Still on its start, which a newer plant shares (it was set there
		// once this one had stepped off): boxed in or lit, this one never
		// left it today. The newer keeps the tile it was set on; this one
		// stands aside. raw is in planting order, so the newer comes later.
		if taken[[2]int{x, y}] > 1 {
			if to, ok := standAside(open, taken, p.X, p.Y); ok {
				taken[[2]int{x, y}]--
				taken[to]++
				x, y = to[0], to[1]
			}
		}
		p.X, p.Y, p.Lit = x, y, land.Lit(lights, x, y)
		out = append(out, p)
	}
	return out
}

// standAside: the nearest free plant tile to a plant's start, within its
// reach if one is free there, otherwise anywhere on the ground. Nearest by
// steps, then the top-most, then the left-most.
func standAside(open map[[2]int]bool, taken map[[2]int]int, x0, y0 int) ([2]int, bool) {
	far := 0
	for t := range open {
		far = max(far, abs(t[0]-x0)+abs(t[1]-y0))
	}
	for _, reach := range []int{plantWanderReach, far} {
		for r := 1; r <= far; r++ {
			for dy := -r; dy <= r; dy++ {
				dx := r - abs(dy)
				for _, to := range [][2]int{{x0 - dx, y0 + dy}, {x0 + dx, y0 + dy}} {
					if abs(to[0]-x0) <= reach && abs(to[1]-y0) <= reach && open[to] && taken[to] == 0 {
						return to, true
					}
				}
			}
		}
	}
	return [2]int{}, false
}

func abs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// plant: a seed or sapling set into your own land at a tile beside you, or
// a carried plant (req.Instance) set in again, its growth kept.
func (a *Server) plant(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.ItemsRequest, now int64, out *contract.ItemsResult) error {
	p, err := plantingFor(ctx, tx, s.AccountID, req.Instance, req.ItemDef)
	if err != nil {
		return err
	}
	h, err := a.ownLand(ctx, tx, s, s.State.Area, now, "cannot-plant-here")
	if err != nil {
		return err
	}
	if len(req.Tile) != 2 {
		return fail(400, "tile-required")
	}
	x, y := int(req.Tile[0]), int(req.Tile[1])
	if !nearTile(s, s.State.Area, x, y, 2) {
		return fail(409, "too-far-away")
	}
	x, y = localHomeTile(s, x, y)
	// A home tends so many plants, then the ground is full.
	if len(h.Plants) >= int(content.GatheringRules.GetPlantsPerHome()) {
		return fail(409, "land-blocked")
	}
	if chunks.InBackland(x, y, h.Gate) {
		back, err := a.backlandOf(ctx, tx, s.WorldID, h.Gate, now)
		if err != nil {
			return err
		}
		if back == nil || !back.buildable(x, y) || slices.ContainsFunc(placedItems(*h), func(v homeInstance) bool {
			r, ok := placedRect(v)
			return ok && *v.Scene == "outdoor" && r.overlaps(rect{x, y, 1, 1})
		}) {
			return fail(409, "land-blocked")
		}
	} else if !plantGround(*h)[[2]int{x, y}] {
		return fail(409, "land-blocked")
	}
	for _, p := range h.Plants {
		if p.X == x && p.Y == y {
			return fail(409, "land-blocked")
		}
	}
	if err = takePlanting(ctx, tx, s.AccountID, &p, "plant", p.def, now); err != nil {
		return err
	}
	day := utcDay(now)
	if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_plants VALUES(?,?,?,?,?,?,?)", p.id, h.ID, p.def, x, y, p.at, day); err != nil {
		return err
	}
	out.Plant = &contract.HomePlant{Id: p.id, ItemDef: p.def, X: int32(x), Y: int32(y), PlantedAt: float64(p.at), PlantedDay: float64(day), Lit: chunks.InBackland(x, y, h.Gate) || land.Lit(connectedLights(placedItems(*h), ""), x, y)}
	return nil
}

// uprootHomePlant digs a plant on your own land up with a trowel, from
// beside where it stands today, into your pack whole, its growth kept
// (camp_teardown.go digUpPlant). Whoever may plant there may dig: a
// member, on the lot or in its lit backland (ownLand, which judges a
// turning due first). The plant is req.Target.
func (a *Server) uprootHomePlant(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.ItemsRequest, now int64, out *contract.ItemsResult) error {
	h, err := a.ownLand(ctx, tx, s, s.State.Area, now, "not-your-land")
	if err != nil {
		return err
	}
	i := slices.IndexFunc(h.Plants, func(p homePlantView) bool { return p.ID == req.Target })
	if i < 0 {
		return fail(409, "not-placed")
	}
	p := h.Plants[i]
	x, y := worldHomeTile(s, h.Gate, p.X, p.Y)
	if !nearTile(s, s.State.Area, x, y, 2) {
		return fail(409, "too-far-away")
	}
	out.Wear, err = a.digUpPlant(ctx, tx, s, "homestead_plants", p.ID, p.ItemDef, now)
	return err
}

// planting is what a plant request sets in the ground: one seed from the
// pack (a new plant), or a carried plant taken from Pell's crate (lamps.md
// 2.7), its own id and first planting kept.
type planting struct {
	id, def string
	at      int64
}

// plantingFor is what a plant request names: the carried plant `carried`,
// or else one seed `seed`. Nothing leaves the pack yet (takePlanting).
func plantingFor(ctx context.Context, tx *sql.Tx, account, carried, seed string) (planting, error) {
	if carried == "" {
		if !content.IsGatheringSeed(seed) {
			return planting{}, fail(400, "not-a-seed")
		}
		return planting{def: seed}, nil
	}
	p := planting{id: carried}
	err := tx.QueryRowContext(ctx, "SELECT item_def,planted_at FROM carried_plants WHERE id=? AND account_id=?", carried, account).Scan(&p.def, &p.at)
	if errors.Is(err, sql.ErrNoRows) {
		return p, fail(409, "item-not-available")
	}
	return p, err
}

// takePlanting takes it out of the pack, once the ground is checked: the
// carried plant, or a seed, which becomes a new plant now.
func takePlanting(ctx context.Context, tx *sql.Tx, account string, p *planting, reason, ref string, now int64) error {
	if p.id != "" {
		res, err := tx.ExecContext(ctx, "DELETE FROM carried_plants WHERE id=? AND account_id=?", p.id, account)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err != nil || n != 1 {
			if err == nil {
				err = fail(409, "item-not-available")
			}
			return err
		}
		return nil
	}
	if _, err := packTake(ctx, tx, account, p.def, nil, 1, reason, ref, now); err != nil {
		return err
	}
	id, err := store.Random()
	p.id, p.at = id, now
	return err
}
