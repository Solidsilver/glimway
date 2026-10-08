package api

import (
	"context"
	"database/sql"
	"fmt"
	"glimway/content"
	"glimway/server/internal/land"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"slices"
)

// ------------------------------------------------------------ gathering & planting

func gatherCaps(action string) (visit, day int) {
	c := content.GatheringRules.Caps
	switch action {
	case "chop":
		return c.Visit.Chop, c.Day.Chop
	case "break":
		return c.Visit.Break, c.Day.Break
	}
	return c.Visit.Dig, c.Day.Dig
}

// ownLand: the caller's homestead when `area` is its land (nil, refused,
// for anyone else's: visiting is read-only).
func ownLand(ctx context.Context, tx *sql.Tx, s *store.Snapshot, area string, now int64, refusal string) (*homeView, error) {
	gate := rules.HomeGate(area)
	if gate < 0 {
		return nil, fail(409, refusal)
	}
	id, ok, err := memberOf(ctx, tx, s.HabiticaID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fail(409, "not-your-land")
	}
	h, err := loadHome(ctx, tx, id, s.HabiticaID, now)
	if err != nil {
		return nil, err
	}
	if h.Gate != gate {
		return nil, fail(409, "not-your-land")
	}
	return &h, nil
}

// landKind is what stands on a home tile now: the generated land, with
// cleared tiles open and kept stumps (felled inside lamplight) counted.
func landKind(h homeView, x, y int) byte {
	g := groundOf(h)
	k := g.land.Effective(g.cleared, x, y)
	if k == land.Tree && slices.Contains(h.Stumps, [2]int{x, y}) {
		return land.Stump
	}
	return k
}

// homeTarget: whether a gathering target matches what stands on a home
// tile. Out on the unlit edge a tree felled this visit is drawn as a
// stump the server never kept, so a dig there may name a standing tree.
func homeTarget(k byte, target, action string, lit bool) bool {
	switch action {
	case "chop":
		return k == land.Tree && (target == "tree" || target == "iron-oak")
	case "break":
		return k == land.Boulder && (target == "boulder" || target == "lamp-stone")
	}
	return target == "stump" && (k == land.Stump || k == land.Tree && !lit)
}

// gatherReach: how far from a piece's foot you can work it, in px. The
// client prompts within 36 px and stops a swing past 46 (REACH and LEAVE
// in src/game/entities/gathering.ts), so the server never refuses a swing
// the client let you make.
const gatherReach = 48

// nearPiece measures as the client does: from a little above the hero's
// feet to the foot of the piece's tile (where its art stands).
func nearPiece(s *store.Snapshot, area string, tx, ty int) bool {
	if s.State.Area != area {
		return false
	}
	dx := s.State.Position.X - float64(tx*wildsTileSize+wildsTileSize/2)
	dy := s.State.Position.Y - 8 - float64((ty+1)*wildsTileSize)
	return dx*dx+dy*dy <= gatherReach*gatherReach
}

// gather: one chop, break or dig (docs/items/crafting-and-repair.md,
// "Gathering"). Trees are client scenery: the server checks the tool, the
// area, the caps and rolls the yields, not the individual tree, except on
// home land, where the land is the server's own and a change inside
// lamplight is kept (the drift: a stump stays, open ground stays open).
func (a *Server) gather(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest, now int64, out *itemResult) error {
	if req.Tool == "" {
		return fail(400, "invalid-tool")
	}
	target, ok := content.GatheringTargetFor(req.Target)
	if !ok {
		return fail(400, "invalid-target")
	}
	if target.Action != req.Action {
		return fail(409, "wrong-tool")
	}
	// The seasons are the server's own reading of its clock and the
	// calendar (docs/items/crafting-and-repair.md, "Seasonal materials"):
	// a seasonal piece only stands in its mark or wick, whatever the
	// client's map says.
	calDay := content.CalendarAt(content.CalendarRules, now)
	if !target.InSeason(calDay) {
		return fail(409, "not-in-season")
	}
	if len(req.VisitID) > 64 {
		return fail(400, "invalid-visit")
	}
	// Where the player is, from the progress this mutation carried, and
	// whether that place has such a piece at all.
	area := s.State.Area
	if !content.GatheringOffered(area, req.Target) {
		return fail(409, "cannot-gather-here")
	}
	// The Wilds: the request names its region (the progress area is
	// "wilds" for both). The Tangle's own trees, and their Amberfall sap,
	// stand in the Tangle only ("on trees in the Tangle"); the outer
	// drift's trees are plain trees.
	if area == "wilds" {
		if _, ok := regionDefinition(req.Region); !ok {
			return fail(400, "invalid-region")
		}
		if req.Target == "tangle-tree" && req.Region != tangleRegion {
			return fail(409, "cannot-gather-here")
		}
	}
	var home *homeView
	var tile [2]int
	lit := false
	if rules.HomeGate(area) >= 0 {
		var err error
		if home, err = ownLand(ctx, tx, s, area, now, "cannot-gather-here"); err != nil {
			return err
		}
		if req.Tile == nil {
			return fail(400, "tile-required")
		}
		tile = *req.Tile
		if !nearPiece(s, area, tile[0], tile[1]) {
			return fail(409, "too-far-away")
		}
		lit = land.Lit(connectedLights(placedItems(*home), ""), tile[0], tile[1])
		if !homeTarget(landKind(*home, tile[0], tile[1]), req.Target, req.Action, lit) {
			return fail(409, "cannot-gather-here")
		}
	}

	// The caps: per area visit and per day, per kind of work.
	day := utcDay(now)
	visit := req.VisitID
	if visit == "" {
		visit = area
	}
	var capDay int64
	var dayCount, visitCount int
	var capArea, capVisit string
	err := tx.QueryRowContext(ctx, "SELECT day,day_count,area,visit_id,visit_count FROM gathering_caps WHERE habitica_id=? AND action=?", s.HabiticaID, req.Action).Scan(&capDay, &dayCount, &capArea, &capVisit, &visitCount)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if capDay != day {
		dayCount = 0
	}
	if capArea != area || capVisit != visit {
		visitCount = 0
	}
	visitCap, dayCap := gatherCaps(req.Action)
	if dayCount >= dayCap || visitCount >= visitCap {
		return fail(409, "gathered-enough")
	}

	res, err := useTool(ctx, tx, s, req.Tool, target.ToolAction, now)
	if err != nil {
		return err
	}
	out.Wear = &res
	// A made tool that wears out on this swing thanks its maker, as any use does.
	if (res.Broke || res.WoreOut) && res.MakerID != "" {
		if err = a.thankMaker(ctx, tx, s, res.MakerID, res.ItemDef, now); err != nil {
			return err
		}
	}
	dayCount++
	visitCount++
	_, err = tx.ExecContext(ctx, `INSERT INTO gathering_caps(habitica_id,action,day,day_count,area,visit_id,visit_count,updated_at) VALUES(?,?,?,?,?,?,?,?)
ON CONFLICT(habitica_id,action) DO UPDATE SET day=excluded.day,day_count=excluded.day_count,area=excluded.area,visit_id=excluded.visit_id,visit_count=excluded.visit_count,updated_at=excluded.updated_at`,
		s.HabiticaID, req.Action, day, dayCount, area, visit, visitCount, now)
	if err != nil {
		return err
	}

	// The yields. A pocketed keepsake's gather-more help adds one of what it
	// names. Seeded per player and gather, so a replay rolls the same.
	more := map[string]bool{}
	slotList, err := slots(ctx, tx, s.HabiticaID)
	if err != nil {
		return err
	}
	for _, sl := range slotList {
		d, ok := content.ItemFor(sl.def)
		if !ok {
			return fmt.Errorf("gathering slot names unknown item %q", sl.def)
		}
		for _, e := range d.Pocket {
			if e.Type == "gather-more" {
				more[e.Target] = true
			}
		}
	}
	rng := wilds.NewRng(wilds.Hash(s.HabiticaID, req.Target, int(now), int(day), dayCount))
	out.Gathered = []stackView{}
	for _, y := range target.Yields {
		if !y.InSeason(calDay) {
			continue
		}
		if y.ChancePermille > 0 && rng.NextInt(1000) >= y.ChancePermille {
			continue
		}
		qty := y.Min + rng.NextInt(y.Max-y.Min+1)
		if more[y.Item] {
			qty++
		}
		def, ok := content.ItemFor(y.Item)
		if !ok {
			return fmt.Errorf("gathering yield names unknown item %q", y.Item)
		}
		if def.Instanced() {
			for range qty {
				id, err := newInstance(ctx, tx, def, instanceAt{"pack", s.HabiticaID}, "", -1, now)
				if err != nil {
					return err
				}
				if err = currency(ctx, tx, s.HabiticaID, content.StackCurrency(def.ID), 1, "gather", req.Target, now); err != nil {
					return err
				}
				out.Created = append(out.Created, id)
			}
		} else if err = packPut(ctx, tx, s.HabiticaID, y.Item, []makerQty{{Maker: "", Qty: qty}}, "gather", req.Target, now); err != nil {
			return err
		}
		out.Gathered = append(out.Gathered, stackView{ItemDef: y.Item, Qty: qty})
	}

	// Home land inside lamplight remembers: a felled tree stays a stump, a
	// broken boulder or a dug stump leaves open ground. The unlit edge
	// regrows like the Tangle, so nothing is kept there.
	if home == nil || !lit {
		return nil
	}
	change := homeLandChange{Tile: tile}
	switch {
	case req.Action == "chop":
		_, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO homestead_stumps VALUES(?,?,?,?)", home.ID, tile[0], tile[1], now)
		change.Stump = true
	default:
		if _, err = tx.ExecContext(ctx, "DELETE FROM homestead_stumps WHERE homestead_id=? AND x=? AND y=?", home.ID, tile[0], tile[1]); err == nil {
			_, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO homestead_cleared VALUES(?,?,?)", home.ID, tile[0], tile[1])
		}
		change.Cleared = true
	}
	out.Land = &change
	return err
}
