package api

import (
	"context"
	"database/sql"
	"fmt"
	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/land"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"math"
	"slices"
	"strings"
)

// ------------------------------------------------------------ gathering & planting

func gatherCaps(action string) (visit, day int) {
	c := content.GatheringRules.GetCaps()
	switch action {
	case "chop":
		return int(c.GetVisit().GetChop()), int(c.GetDay().GetChop())
	case "break":
		return int(c.GetVisit().GetBreak()), int(c.GetDay().GetBreak())
	}
	return int(c.GetVisit().GetDig()), int(c.GetDay().GetDig())
}

// ownLand: the caller's homestead when `area` is its land (nil, refused,
// for anyone else's: visiting is read-only).
func ownLand(ctx context.Context, tx *sql.Tx, s *store.Snapshot, area string, now int64, refusal string) (*homeView, error) {
	gate := rules.HomeGate(area)
	if gate < 0 {
		return nil, fail(409, refusal)
	}
	id, ok, err := memberOf(ctx, tx, s.AccountID)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fail(409, "not-your-land")
	}
	h, err := loadHome(ctx, tx, id, s.AccountID, now)
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

// gather checks stored Wilds decor or home land before charging wear and caps.
// Curated scenery retains its area rules.
func (a *Server) gather(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.ItemsRequest, now int64, out *contract.ItemsResult) error {
	if strings.HasPrefix(s.State.Area, "in:") {
		return fail(409, "cannot-gather-here")
	}
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
	if !content.GatheringTargetInSeason(target, calDay) {
		return fail(409, "not-in-season")
	}
	if len(req.VisitId) > 64 {
		return fail(400, "invalid-visit")
	}
	// Where the player is, from this operation's where, and
	// whether that place has such a piece at all.
	area := s.State.Area
	offeredArea := area
	if strings.HasPrefix(area, "wilds:") {
		offeredArea = "wilds"
	}
	if !content.GatheringOffered(offeredArea, req.Target) {
		return fail(409, "cannot-gather-here")
	}
	// The Wilds: the request names its region (the progress area is
	// "wilds" for both). The Tangle's own trees, and their Amberfall sap,
	// stand in the Tangle only ("on trees in the Tangle"); the outer
	// drift's trees are plain trees.
	if strings.HasPrefix(area, "wilds:") {
		req.Region = strings.TrimPrefix(area, "wilds:")
		if _, ok := regionDefinition(req.Region); !ok {
			return fail(400, "invalid-region")
		}
		if req.Target == "tangle-tree" && req.Region != tangleRegion {
			return fail(409, "cannot-gather-here")
		}
	}
	if strings.HasPrefix(area, "wilds:") {
		if a.Config.Epochs == nil {
			return fail(503, "generator-unavailable")
		}
		epoch, err := a.Config.Epochs.Current(ctx, tx, s.WorldID, req.Region, now)
		if err != nil {
			return chunkError(err)
		}
		if len(req.Tile) != 2 {
			return fail(400, "tile-required")
		}
		size := int(content.WildsRules.GetChunkSize())
		cx, cy := int(math.Floor(float64(req.Tile[0])/float64(size))), int(math.Floor(float64(req.Tile[1])/float64(size)))
		chunk, err := a.Config.Chunks.Chunk(ctx, tx, s.WorldID, epoch.Id, 0, int32(cx), int32(cy))
		if err != nil {
			return chunkError(err)
		}
		if !nearPiece(s, area, int(req.Tile[0]), int(req.Tile[1])) {
			return fail(409, "too-far-away")
		}
		matched, tree := false, false
		for _, i := range chunks.DecorAt(chunk, uint32(int(req.Tile[0])-cx*size), uint32(int(req.Tile[1])-cy*size)) {
			kind := chunk.Decor.Kinds[chunk.Decor.Kind[i]]
			if slices.Contains([]string{"oak", "pine", "birch", "iron-oak", "snag"}, kind) {
				tree = true
			}
			if gatherDecor(req.Target, kind) {
				matched = true
			}
		}
		// Felling changes this player's local piece into a stump for the visit.
		// The prior committed chop proves that transition without changing shared
		// chunk geometry or trusting a client-supplied stump on a standing tree.
		if !matched && tree && req.Target == "stump" {
			err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM idempotency WHERE account_id=? AND op='/api/items/gather' AND json_extract(result_json,'$.refused') IS NULL AND created_at>=? AND json_extract(payload_json,'$.action')='chop' AND json_extract(payload_json,'$.where.area')=? AND COALESCE(json_extract(payload_json,'$.visitId'),'')=? AND json_extract(payload_json,'$.tile[0]')=? AND json_extract(payload_json,'$.tile[1]')=?)`, s.AccountID, epoch.StartsAt, area, req.VisitId, req.Tile[0], req.Tile[1]).Scan(&matched)
			if err != nil {
				return err
			}
		}
		if !matched {
			return fail(409, "cannot-gather-here")
		}
	}
	var home *homeView
	var tile [2]int
	lit := false
	if rules.HomeGate(area) >= 0 {
		var err error
		if home, err = ownLand(ctx, tx, s, area, now, "cannot-gather-here"); err != nil {
			return chunkError(err)
		}
		if len(req.Tile) != 2 {
			return fail(400, "tile-required")
		}
		tile = [2]int{int(req.Tile[0]), int(req.Tile[1])}
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
	visit := req.VisitId
	if visit == "" {
		visit = area
	}
	var capDay int64
	var dayCount, visitCount int
	var capArea, capVisit string
	err := tx.QueryRowContext(ctx, "SELECT day,day_count,area,visit_id,visit_count FROM gathering_caps WHERE account_id=? AND action=?", s.AccountID, req.Action).Scan(&capDay, &dayCount, &capArea, &capVisit, &visitCount)
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
	out.Wear = wearProto(&res)
	// A made tool that wears out on this swing thanks its maker, as any use does.
	if (res.Broke || res.WoreOut) && res.MakerID != "" {
		if err = a.thankMaker(ctx, tx, s, res.MakerID, res.ItemDef, now); err != nil {
			return err
		}
	}
	dayCount++
	visitCount++
	_, err = tx.ExecContext(ctx, `INSERT INTO gathering_caps(account_id,action,day,day_count,area,visit_id,visit_count,updated_at) VALUES(?,?,?,?,?,?,?,?)
ON CONFLICT(account_id,action) DO UPDATE SET day=excluded.day,day_count=excluded.day_count,area=excluded.area,visit_id=excluded.visit_id,visit_count=excluded.visit_count,updated_at=excluded.updated_at`,
		s.AccountID, req.Action, day, dayCount, area, visit, visitCount, now)
	if err != nil {
		return err
	}

	// The yields. A pocketed keepsake's gather-more help adds one of what it
	// names. Seeded per player and gather, so a replay rolls the same.
	more := map[string]bool{}
	slotList, err := slots(ctx, tx, s.AccountID)
	if err != nil {
		return err
	}
	for _, sl := range slotList {
		d, ok := content.ItemFor(sl.def)
		if !ok {
			return fmt.Errorf("gathering slot names unknown item %q", sl.def)
		}
		for _, e := range d.GetPocket() {
			if e.GetType() == "gather-more" {
				more[e.GetTarget()] = true
			}
		}
	}
	rng := wilds.NewRng(wilds.Hash(s.AccountID, req.Target, int(now), int(day), dayCount))
	out.Gathered = []*contract.Stack{}
	for _, y := range target.Yields {
		if !content.GatheringYieldInSeason(y, calDay) {
			continue
		}
		if y.GetChancePermille() > 0 && rng.NextInt(1000) >= int(y.GetChancePermille()) {
			continue
		}
		qty := int(y.GetMin()) + rng.NextInt(int(y.GetMax()-y.GetMin())+1)
		if more[y.GetItem()] {
			qty++
		}
		def, ok := content.ItemFor(y.Item)
		if !ok {
			return fmt.Errorf("gathering yield names unknown item %q", y.Item)
		}
		if content.ItemInstanced(def) {
			for range qty {
				id, err := newInstance(ctx, tx, def, instanceAt{"pack", s.AccountID}, "", -1, now)
				if err != nil {
					return err
				}
				if err = currency(ctx, tx, s.AccountID, content.StackCurrency(def.GetId()), 1, "gather", req.Target, now); err != nil {
					return err
				}
				out.Created = append(out.Created, id)
			}
		} else if err = packPut(ctx, tx, s.AccountID, y.Item, []makerQty{{Maker: "", Qty: qty}}, "gather", req.Target, now); err != nil {
			return err
		}
		out.Gathered = append(out.Gathered, &contract.Stack{ItemDef: y.Item, Qty: int32(qty)})
	}

	// Home land inside lamplight remembers: a felled tree stays a stump, a
	// broken boulder or a dug stump leaves open ground. The unlit edge
	// regrows like the Tangle, so nothing is kept there.
	if home == nil || !lit {
		return nil
	}
	change := &contract.HomeLandChange{Tile: []int32{int32(tile[0]), int32(tile[1])}}
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
	out.Land = change
	return err
}

// Species and seasonal patches must exist in the stored decor.
func gatherDecor(target, kind string) bool {
	switch target {
	case "tree", "tangle-tree":
		return slices.Contains([]string{"oak", "pine", "birch"}, kind)
	case "willow":
		return kind == "snag"
	case "iron-oak":
		return kind == "iron-oak"
	case "boulder":
		return kind == "boulder"
	case "lamp-stone":
		return kind == "cairn"
	case "stump":
		return slices.Contains([]string{"stump", "ring-stump", "turncaps"}, kind)
	case "herbs", "bloom-patch":
		return kind == "flowers"
	case "sapling":
		return kind == "fern"
	case "hollow-tree":
		return kind == "log"
	default:
		return false
	}
}
