package api

// Paths players make (open-map.md section 3, decisions 5, 7, 12, 23): the
// world-changes layer's first users. A chunk and epoch's ground changes are
// one world_changes row (entity "ground", kind "ground", a GroundChanges
// message); a named way is one row (entity its id, kind "way", a WildsWay)
// under the wick epoch, so both go when their land turns and last for good
// in the Tangle's still epoch.

import (
	"context"
	"database/sql"
	"fmt"
	"glimway/server/internal/location"
	"net/http"
	"slices"
	"sort"
	"strings"

	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/frontier"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"glimway/server/internal/worldchange"

	"google.golang.org/protobuf/encoding/protojson"
)

const (
	groundKind   = "ground"
	groundEntity = "ground"
	wayKind      = "way"
)

func epochEnds(e *contract.WildsEpoch) *int64 {
	if e.EndsAt == nil {
		return nil
	}
	v := int64(e.EndsAt.Value)
	return &v
}

func groundKey(world string, e *contract.WildsEpoch, cx, cy int) worldchange.Key {
	return worldchange.Key{WorldID: world, Realm: content.WildsRules.GetRealm(), Chunk: chunkName(cx, cy), Epoch: e.Id, Entity: groundEntity}
}

func decodeGround(b []byte) (*contract.GroundChanges, error) {
	g := &contract.GroundChanges{Changes: []*contract.GroundChange{}}
	if len(b) == 0 {
		return g, nil
	}
	return g, protojson.Unmarshal(b, g)
}

// groundChanges is a chunk's changes under its epoch (none: empty).
func groundChanges(ctx context.Context, tx *sql.Tx, world string, e *contract.WildsEpoch, cx, cy int, now int64) (*contract.GroundChanges, error) {
	if location.SourceOf(cx, cy).Kind != location.SourceGenerated {
		return &contract.GroundChanges{}, nil
	}
	row, err := worldchange.Get(ctx, tx, groundKey(world, e, cx, cy), groundKind, now)
	if err != nil || row == nil {
		return &contract.GroundChanges{Changes: []*contract.GroundChange{}}, err
	}
	return decodeGround(row.State)
}

// putGround stores a chunk's changes, one a tile in row-major order; none
// left deletes the row.
func putGround(ctx context.Context, tx *sql.Tx, world string, e *contract.WildsEpoch, cx, cy int, g *contract.GroundChanges, by string, now int64) error {
	if location.SourceOf(cx, cy).Kind != location.SourceGenerated {
		return fail(409, "not-in-wilds")
	}
	key := groundKey(world, e, cx, cy)
	if len(g.Changes) == 0 {
		return worldchange.Delete(ctx, tx, key)
	}
	sort.Slice(g.Changes, func(i, j int) bool {
		a, b := g.Changes[i], g.Changes[j]
		return a.Ty < b.Ty || a.Ty == b.Ty && a.Tx < b.Tx
	})
	b, err := protojson.Marshal(g)
	if err != nil {
		return err
	}
	// A held chunk's changes last as long as the hold (store.Chunks.Hold).
	ends := epochEnds(e)
	held, err := store.HeldEpoch(ctx, tx, world, cx, cy)
	if err != nil {
		return err
	}
	if held != nil && held.Id == e.Id {
		ends = nil
	}
	return worldchange.Put(ctx, tx, worldchange.Row{Key: key, Kind: groundKind, State: b, ChangedBy: by, EndsAt: ends}, now)
}

// ---------------------------------------------------------------- the tile

// pathSpot is the tile an operation names, with its chunk and changes.
type pathSpot struct {
	epoch          *contract.WildsEpoch
	x, y           int // world tile
	cx, cy, lx, ly int
	changes        *contract.GroundChanges
	eff            chunks.Effective
}

// spotFor reads the world tile (x, y) for a path operation: inside the
// frontier, within reach of the player (paths.reachTiles).
func (a *Server) spotFor(ctx context.Context, tx *sql.Tx, s *store.Snapshot, x, y int32, targetEpoch string, now int64) (*pathSpot, error) {
	S := chunkSize()
	p := &pathSpot{x: int(x), y: int(y)}
	p.cx, p.cy = wilds.FloorDiv(p.x, S), wilds.FloorDiv(p.y, S)
	p.lx, p.ly = p.x-p.cx*S, p.y-p.cy*S
	if location.SourceOf(p.cx, p.cy).Kind != location.SourceGenerated {
		return nil, fail(409, "not-in-wilds")
	}
	if !frontier.Inside(s.WorldID, p.cx, p.cy) {
		return nil, fail(409, "beyond-frontier")
	}
	if err := nearWithin(*s, p.x, p.y, int(content.WildsRules.GetPaths().GetReachTiles())); err != nil {
		return nil, err
	}
	var err error
	if p.epoch, err = a.epochAt(ctx, tx, s.WorldID, p.cx, p.cy, now); err != nil {
		return nil, chunkError(err)
	}
	// The captured target must still be this tile's epoch before reading
	// its chunk or spending any materials. Keyed replay happens before apply.
	if targetEpoch != p.epoch.Id {
		return nil, fail(409, "epoch-ended")
	}
	m, err := a.Config.Chunks.Chunk(ctx, tx, s.WorldID, p.epoch.Id, 0, int32(p.cx), int32(p.cy))
	if err != nil {
		return nil, chunkError(err)
	}
	if p.changes, err = groundChanges(ctx, tx, s.WorldID, p.epoch, p.cx, p.cy, now); err != nil {
		return nil, err
	}
	p.eff = chunks.NewEffective(m, p.changes)
	return p, nil
}

// occupied: a site, an entity or a place's landmark stands on the tile.
func (p *pathSpot) occupied() bool {
	c := p.eff.Chunk
	x, y := uint32(p.lx), uint32(p.ly)
	return slices.ContainsFunc(c.Sites, func(s *contract.StorySite) bool { return s.Tx == x && s.Ty == y }) ||
		slices.ContainsFunc(c.Entities, func(e *contract.WildsEntity) bool { return e.Tx == x && e.Ty == y }) ||
		slices.ContainsFunc(c.Places, func(m *contract.WildsPlaceMark) bool { return m.Tx == x && m.Ty == y })
}

// onLand: the generated ground is land (not water, a ford, the road or a
// laid ground).
func (p *pathSpot) onLand() bool {
	g := p.eff.BaseGround(p.lx, p.ly)
	return g != nil && g.GetSurface() == "land"
}

// set replaces the tile's change (nil removes it).
func (p *pathSpot) set(c *contract.GroundChange) {
	p.changes.Changes = slices.DeleteFunc(p.changes.Changes, func(g *contract.GroundChange) bool {
		return int(g.Tx) == p.lx && int(g.Ty) == p.ly
	})
	if c != nil {
		p.changes.Changes = append(p.changes.Changes, c)
	}
}

func (p *pathSpot) put(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) error {
	return putGround(ctx, tx, s.WorldID, p.epoch, p.cx, p.cy, p.changes, s.AccountID, now)
}

func (p *pathSpot) ground() *contract.ChunkGroundChanges {
	return &contract.ChunkGroundChanges{Chunk: chunkKeyProto(p.cx, p.cy), Epoch: p.epoch.Id, Changes: p.changes}
}

// packHasTool: a tool in the pack does the action (no wear: clearing is a
// short, free action).
func packHasTool(ctx context.Context, tx *sql.Tx, account, action string) (bool, error) {
	rows, err := tx.QueryContext(ctx, "SELECT DISTINCT item_def FROM item_instances WHERE location='pack' AND owner=?", account)
	if err != nil {
		return false, err
	}
	found := false
	for rows.Next() {
		var def string
		if err = rows.Scan(&def); err != nil {
			rows.Close()
			return false, err
		}
		if d, ok := content.ItemFor(def); ok && d.GetKind() == "tool" && slices.Contains(d.GetActions(), action) {
			found = true
		}
	}
	return found, closeRows(rows)
}

// ---------------------------------------------------------------- operations

// wildsClear is POST /api/wilds/clear: clear a thicket with a spade or a
// fallen trunk with an axe (paths.clearTools). Free, and it yields nothing:
// gathering stays at nodes.
func (a *Server) wildsClear(w http.ResponseWriter, r *http.Request) error {
	req := &contract.WildsClearRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	var changedWorld, changedEpoch string
	var changedCX, changedCY int32
	changedGround := false
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		p, err := a.spotFor(ctx, tx, s, req.X, req.Y, req.Epoch, now)
		if err != nil {
			return nil, err
		}
		if err = a.backlandBuilder(ctx, tx, s, p.cx, p.cy); err != nil {
			return nil, err
		}
		if err = a.campBuilderAt(ctx, tx, s, p.cx, p.cy); err != nil {
			return nil, err
		}
		if p.eff.Change(p.lx, p.ly) != nil {
			return nil, fail(409, "already-cleared")
		}
		action := ""
		for _, kind := range chunks.DecorKindsAt(p.eff.Chunk, p.lx, p.ly) {
			for _, t := range content.WildsRules.GetPaths().GetClearTools() {
				if t.GetDecor() == kind {
					action = t.GetAction()
				}
			}
		}
		if action == "" || !p.onLand() || p.occupied() || len(p.changes.Changes) >= int(content.WildsRules.GetPaths().GetMaxChanges()) {
			return nil, fail(409, "not-clearable")
		}
		ok, err := packHasTool(ctx, tx, s.AccountID, action)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, fail(409, "wrong-tool")
		}
		p.set(&contract.GroundChange{Tx: uint32(p.lx), Ty: uint32(p.ly), Change: chunks.ChangeCleared, By: s.AccountID, At: float64(now)})
		if err = p.put(ctx, tx, s, now); err != nil {
			return nil, err
		}
		changedWorld, changedEpoch, changedCX, changedCY, changedGround = s.WorldID, p.epoch.Id, int32(p.cx), int32(p.cy), true
		m, err := materialsProto(ctx, tx, s.AccountID)
		return &contract.WildsClearResult{Ground: p.ground(), Materials: m}, err
	}, func() {
		if changedGround {
			a.presence.invalidateFightGround(changedWorld, changedEpoch, changedCX, changedCY)
		}
	})
}

// wildsLay is POST /api/wilds/lay: a stone or plank path on a walkable land
// tile, for its material from the pack. A lay that newly joins two places
// makes a named way for each pair it joins.
func (a *Server) wildsLay(w http.ResponseWriter, r *http.Request) error {
	req := &contract.WildsLayRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	var changedWorld, changedEpoch string
	var changedCX, changedCY int32
	changedGround := false
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		lay := chunks.LayKind(req.Kind)
		if lay == nil {
			return nil, fail(400, "invalid-request")
		}
		p, err := a.spotFor(ctx, tx, s, req.X, req.Y, req.Epoch, now)
		if err != nil {
			return nil, err
		}
		if err = a.backlandBuilder(ctx, tx, s, p.cx, p.cy); err != nil {
			return nil, err
		}
		if err = a.campBuilderAt(ctx, tx, s, p.cx, p.cy); err != nil {
			return nil, err
		}
		if p.eff.Laid(p.lx, p.ly) {
			return nil, fail(409, "already-laid")
		}
		if !p.eff.Walkable(p.lx, p.ly) || !p.onLand() || p.occupied() ||
			p.eff.Change(p.lx, p.ly) == nil && len(p.changes.Changes) >= int(content.WildsRules.GetPaths().GetMaxChanges()) {
			return nil, fail(409, "cannot-lay-here")
		}
		have, err := materials(ctx, tx, s.AccountID)
		if err != nil {
			return nil, err
		}
		if have[lay.GetMaterial()] < int(lay.GetCost()) {
			return nil, fail(409, "insufficient-materials")
		}
		ref := fmt.Sprintf("%s:%d:%d", p.epoch.Id, p.x, p.y)
		if err = itemChange(ctx, tx, s, lay.GetMaterial(), -int(lay.GetCost()), "wilds-lay", ref, now); err != nil {
			return nil, err
		}
		p.set(&contract.GroundChange{Tx: uint32(p.lx), Ty: uint32(p.ly), Change: lay.GetKind(), By: s.AccountID, At: float64(now)})
		if err = p.put(ctx, tx, s, now); err != nil {
			return nil, err
		}
		changedWorld, changedEpoch, changedCX, changedCY, changedGround = s.WorldID, p.epoch.Id, int32(p.cx), int32(p.cy), true
		made, err := a.waysAfterLay(ctx, tx, s, p.x, p.y, now)
		if err != nil {
			return nil, err
		}
		m, err := materialsProto(ctx, tx, s.AccountID)
		return &contract.WildsLayResult{Ground: p.ground(), Materials: m, WaysMade: made}, err
	}, func() {
		if changedGround {
			a.presence.invalidateFightGround(changedWorld, changedEpoch, changedCX, changedCY)
		}
	})
}

// wildsLift is POST /api/wilds/lift: lift a path you laid, its material
// back in the same transaction. A tile that needed clearing stays cleared.
// Every way whose path ran over it is rerouted, or broken when its two
// places no longer join.
func (a *Server) wildsLift(w http.ResponseWriter, r *http.Request) error {
	req := &contract.WildsLiftRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	var changedWorld, changedEpoch string
	var changedCX, changedCY int32
	changedGround := false
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		p, err := a.spotFor(ctx, tx, s, req.X, req.Y, req.Epoch, now)
		if err != nil {
			return nil, err
		}
		c := p.eff.Change(p.lx, p.ly)
		if c == nil || chunks.LayKind(c.Change) == nil || c.By != s.AccountID {
			return nil, fail(409, "not-your-path")
		}
		lay := chunks.LayKind(c.Change)
		ref := fmt.Sprintf("%s:%d:%d", p.epoch.Id, p.x, p.y)
		if err = itemChange(ctx, tx, s, lay.GetMaterial(), int(lay.GetCost()), "wilds-lift", ref, now); err != nil {
			return nil, err
		}
		if p.eff.BaseSolid(p.lx, p.ly) {
			p.set(&contract.GroundChange{Tx: uint32(p.lx), Ty: uint32(p.ly), Change: chunks.ChangeCleared, By: s.AccountID, At: float64(now)})
		} else {
			p.set(nil)
		}
		if err = p.put(ctx, tx, s, now); err != nil {
			return nil, err
		}
		changedWorld, changedEpoch, changedCX, changedCY, changedGround = s.WorldID, p.epoch.Id, int32(p.cx), int32(p.cy), true
		broken, rerouted, err := a.waysAfterLift(ctx, tx, s, p.x, p.y, now)
		if err != nil {
			return nil, err
		}
		m, err := materialsProto(ctx, tx, s.AccountID)
		return &contract.WildsLiftResult{Ground: p.ground(), Materials: m, WaysBroken: broken, WaysRerouted: rerouted}, err
	}, func() {
		if changedGround {
			a.presence.invalidateFightGround(changedWorld, changedEpoch, changedCX, changedCY)
		}
	})
}

// ---------------------------------------------------------------- named ways

// The footprints' openings in world tiles: a way touches a footprint on a
// tile of one of its openings (open-map.md section 3).
type openingTile struct {
	footprint, opening string
	x, y               int
}

var openingTiles = func() []openingTile {
	S := int(content.WildsRules.GetChunkSize())
	out := []openingTile{}
	for _, p := range content.WildsRules.Places {
		for _, o := range p.GetOpenings() {
			x0, y0 := int(o.GetCx())*S, int(o.GetCy())*S
			for i := 0; i < int(o.GetWidth()); i++ {
				x, y := x0+int(o.GetOffset())+i, y0+int(o.GetOffset())+i
				switch o.GetEdge() {
				case "north":
					y = y0
				case "south":
					y = y0 + S - 1
				case "west":
					x = x0
				case "east":
					x = x0 + S - 1
				}
				out = append(out, openingTile{p.GetId(), o.GetId(), x, y})
			}
		}
	}
	return out
}()

// wayPlace is a place a way can join: a cell place (its landmark and find
// radius, Chebyshev) or a footprint (its opening tiles).
type wayPlace struct {
	id     string
	foot   bool
	x, y   int
	radius int
}

func (p wayPlace) touches(x, y int) bool {
	if p.foot {
		return slices.ContainsFunc(openingTiles, func(o openingTile) bool { return o.footprint == p.id && o.x == x && o.y == y })
	}
	return max(intAbs(x-p.x), intAbs(y-p.y)) <= p.radius
}

// touchTiles are the tiles on which a way meets the place.
func (p wayPlace) touchTiles() [][2]int {
	out := [][2]int{}
	if p.foot {
		for _, o := range openingTiles {
			if o.footprint == p.id {
				out = append(out, [2]int{o.x, o.y})
			}
		}
		return out
	}
	for y := p.y - p.radius; y <= p.y+p.radius; y++ {
		for x := p.x - p.radius; x <= p.x+p.radius; x++ {
			out = append(out, [2]int{x, y})
		}
	}
	return out
}

// pathWorld reads the effective tiles of an operation's world, chunk by
// chunk, each under its epoch, after the operation's own change.
type pathWorld struct {
	a     *Server
	ctx   context.Context
	tx    *sql.Tx
	world string
	now   int64
	ep    openEpochs
	effs  map[[2]int]*chunks.Effective
	err   error
}

func (a *Server) pathWorld(ctx context.Context, tx *sql.Tx, world string, now int64) (*pathWorld, error) {
	ep, err := a.openEpochs(ctx, tx, world, now)
	if err != nil {
		return nil, err
	}
	return &pathWorld{a: a, ctx: ctx, tx: tx, world: world, now: now, ep: ep, effs: map[[2]int]*chunks.Effective{}}, nil
}

// eff is a chunk's effective tiles (nil outside the frontier, or after an
// error, which w.err keeps).
func (w *pathWorld) eff(cx, cy int) *chunks.Effective {
	k := [2]int{cx, cy}
	if v, ok := w.effs[k]; ok {
		return v
	}
	if w.err != nil || !frontier.Inside(w.world, cx, cy) || location.SourceOf(cx, cy).Kind != location.SourceGenerated {
		return nil
	}
	e := w.ep.of(cx, cy)
	m, err := w.a.Config.Chunks.Chunk(w.ctx, w.tx, w.world, e.Id, 0, int32(cx), int32(cy))
	if err != nil {
		w.err = err
		return nil
	}
	g, err := groundChanges(w.ctx, w.tx, w.world, e, cx, cy, w.now)
	if err != nil {
		w.err = err
		return nil
	}
	v := chunks.NewEffective(m, g)
	w.effs[k] = &v
	return &v
}

func (w *pathWorld) tile(x, y int) (*chunks.Effective, int, int) {
	S := chunkSize()
	cx, cy := wilds.FloorDiv(x, S), wilds.FloorDiv(y, S)
	return w.eff(cx, cy), x - cx*S, y - cy*S
}

func (w *pathWorld) laid(x, y int) bool {
	e, lx, ly := w.tile(x, y)
	return e != nil && e.Laid(lx, ly)
}

func (w *pathWorld) laidBy(x, y int) string {
	e, lx, ly := w.tile(x, y)
	if e == nil {
		return ""
	}
	return e.Change(lx, ly).GetBy()
}

// signSpot: where a sign can stand, beside a path's end: walkable, not laid.
func (w *pathWorld) signSpot(x, y int) bool {
	e, lx, ly := w.tile(x, y)
	return e != nil && e.Walkable(lx, ly) && !e.Laid(lx, ly)
}

var steps = [4][2]int{{0, -1}, {1, 0}, {0, 1}, {-1, 0}} // N E S W

// places are the places whose touch a tile could be on: the cell places of
// the chunks around it (their landmarks) and the footprints.
func (w *pathWorld) placesNear(x, y int) []wayPlace {
	S := chunkSize()
	cx, cy := wilds.FloorDiv(x, S), wilds.FloorDiv(y, S)
	out := []wayPlace{}
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			e := w.eff(cx+dx, cy+dy)
			if e == nil {
				continue
			}
			for _, m := range e.Chunk.Places {
				if k := placeKind(m.Kind); k != nil {
					out = append(out, wayPlace{id: m.Id, x: (cx+dx)*S + int(m.Tx), y: (cy+dy)*S + int(m.Ty), radius: int(k.GetFindRadius())})
				}
			}
		}
	}
	for _, p := range content.WildsRules.Places {
		out = append(out, wayPlace{id: p.GetId(), foot: true})
	}
	return out
}

// place resolves a way's end by id: a footprint, or a cell place found in
// its cell's chunks.
func (w *pathWorld) place(id string) (wayPlace, bool) {
	if wilds.Footprint(id) != nil {
		return wayPlace{id: id, foot: true}, true
	}
	px, py, ok := signedPair(strings.TrimPrefix(id, "place:"), ":")
	if !ok {
		return wayPlace{}, false
	}
	c := content.WildsRules.GetCells()
	n := int(c.GetCellChunks())
	S := chunkSize()
	for cy := int(c.GetOriginCy()) + py*n; cy < int(c.GetOriginCy())+(py+1)*n; cy++ {
		for cx := int(c.GetOriginCx()) + px*n; cx < int(c.GetOriginCx())+(px+1)*n; cx++ {
			e := w.eff(cx, cy)
			if e == nil {
				continue
			}
			for _, m := range e.Chunk.Places {
				if k := placeKind(m.Kind); m.Id == id && k != nil {
					return wayPlace{id: id, x: cx*S + int(m.Tx), y: cy*S + int(m.Ty), radius: int(k.GetFindRadius())}, true
				}
			}
		}
	}
	return wayPlace{}, false
}

// run is the 4-connected run of laid tiles holding (x, y), capped at
// paths.wayFloodCap tiles.
func (w *pathWorld) run(x, y int) [][2]int {
	limit := int(content.WildsRules.GetPaths().GetWayFloodCap())
	seen := map[[2]int]bool{{x, y}: true}
	out := [][2]int{{x, y}}
	for i := 0; i < len(out) && len(out) < limit; i++ {
		for _, d := range steps {
			n := [2]int{out[i][0] + d[0], out[i][1] + d[1]}
			if !seen[n] && w.laid(n[0], n[1]) {
				seen[n] = true
				if out = append(out, n); len(out) >= limit {
					break
				}
			}
		}
	}
	return out
}

// path is the way's path between a and b over the world's laid tiles.
func (w *pathWorld) path(a, b wayPlace) (path [][2]int, signA, signB [2]int, ok bool) {
	return wayPath(a, b, w.laid, w.signSpot, int(content.WildsRules.GetPaths().GetWayFloodCap()))
}

// wayPath is the shortest run of laid tiles from a tile touching a to one
// touching b, each end with a sign spot beside it (breadth first, N E S W,
// from a's tiles in row order, at most limit tiles searched). A candidate
// end that can't take its sign is passed over; each candidate's path is
// built afresh, so a passed-over one never leaks into the next.
func wayPath(a, b wayPlace, laid, spot func(x, y int) bool, limit int) (path [][2]int, signA, signB [2]int, ok bool) {
	sign := func(t, not [2]int, avoid bool) ([2]int, bool) {
		for _, d := range steps {
			n := [2]int{t[0] + d[0], t[1] + d[1]}
			if (!avoid || n != not) && spot(n[0], n[1]) {
				return n, true
			}
		}
		return [2]int{}, false
	}
	from := map[[2]int][2]int{}
	queue := [][2]int{}
	sources := a.touchTiles()
	sort.Slice(sources, func(i, j int) bool {
		return sources[i][1] < sources[j][1] || sources[i][1] == sources[j][1] && sources[i][0] < sources[j][0]
	})
	for _, t := range sources {
		if laid(t[0], t[1]) {
			if _, ok := sign(t, t, false); ok {
				from[t] = t
				queue = append(queue, t)
			}
		}
	}
	for i := 0; i < len(queue) && i < limit; i++ {
		t := queue[i]
		if b.touches(t[0], t[1]) {
			candidate := [][2]int{}
			for at := t; ; at = from[at] {
				candidate = append(candidate, at)
				if from[at] == at {
					break
				}
			}
			slices.Reverse(candidate)
			sa, okA := sign(candidate[0], [2]int{}, false)
			sb, okB := sign(candidate[len(candidate)-1], sa, true)
			if okA && okB {
				return candidate, sa, sb, true
			}
		}
		for _, d := range steps {
			n := [2]int{t[0] + d[0], t[1] + d[1]}
			if _, seen := from[n]; !seen && laid(n[0], n[1]) {
				from[n] = t
				queue = append(queue, n)
			}
		}
	}
	return nil, [2]int{}, [2]int{}, false
}

func worldTiles(path [][2]int) []*contract.WorldTile {
	out := make([]*contract.WorldTile, len(path))
	for i, t := range path {
		out[i] = &contract.WorldTile{X: int32(t[0]), Y: int32(t[1])}
	}
	return out
}

func wayKey(world string, e *contract.WildsEpoch, id string) worldchange.Key {
	return worldchange.Key{WorldID: world, Realm: content.WildsRules.GetRealm(), Epoch: e.Id, Entity: id}
}

// ways are the named ways standing this wick.
func (a *Server) ways(ctx context.Context, tx *sql.Tx, world string, wick *contract.WildsEpoch, now int64) ([]*contract.WildsWay, error) {
	rows, err := worldchange.List(ctx, tx, world, content.WildsRules.GetRealm(), 0, []worldchange.ChunkEpoch{{Chunk: "", Epoch: wick.Id}}, wayKind, now)
	if err != nil {
		return nil, err
	}
	out := []*contract.WildsWay{}
	for _, row := range rows {
		v := &contract.WildsWay{}
		if err = protojson.Unmarshal(row.State, v); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, nil
}

func (a *Server) putWay(ctx context.Context, tx *sql.Tx, world string, wick *contract.WildsEpoch, way *contract.WildsWay, by string, now int64) error {
	b, err := protojson.Marshal(way)
	if err != nil {
		return err
	}
	return worldchange.Put(ctx, tx, worldchange.Row{Key: wayKey(world, wick, way.Id), Kind: wayKind, State: b, ChangedBy: by, EndsAt: epochEnds(wick)}, now)
}

// wayID is "way:<a>:<b>" with a < b.
func wayID(a, b string) string {
	if b < a {
		a, b = b, a
	}
	return "way:" + a + ":" + b
}

// waysAfterLay makes a way for every pair of places the run through the new
// tile joins that no way joins yet (two footprints aside: the crossing
// joins them already). The name follows whoever laid most of the run; a tie
// goes to whoever laid the joining tile.
func (a *Server) waysAfterLay(ctx context.Context, tx *sql.Tx, s *store.Snapshot, x, y int, now int64) ([]*contract.WildsWay, error) {
	w, err := a.pathWorld(ctx, tx, s.WorldID, now)
	if err != nil {
		return nil, err
	}
	run := w.run(x, y)
	touched := map[string]wayPlace{}
	near := map[[2]int][]wayPlace{}
	S := chunkSize()
	laidBy := map[string]int{}
	for _, t := range run {
		laidBy[w.laidBy(t[0], t[1])]++
		k := [2]int{wilds.FloorDiv(t[0], S), wilds.FloorDiv(t[1], S)}
		if _, ok := near[k]; !ok {
			near[k] = w.placesNear(t[0], t[1])
		}
		for _, p := range near[k] {
			if p.touches(t[0], t[1]) {
				touched[p.id] = p
			}
		}
	}
	if w.err != nil {
		return nil, w.err
	}
	made := []*contract.WildsWay{}
	if len(touched) < 2 {
		return made, nil
	}
	standing, err := a.ways(ctx, tx, s.WorldID, w.ep.wick, now)
	if err != nil {
		return nil, err
	}
	joined := map[string]bool{}
	for _, v := range standing {
		joined[v.Id] = true
	}
	ids := make([]string, 0, len(touched))
	for id := range touched {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	by, most := s.AccountID, laidBy[s.AccountID]
	layers := make([]string, 0, len(laidBy))
	for who := range laidBy {
		layers = append(layers, who)
	}
	sort.Strings(layers)
	for _, who := range layers {
		if who != "" && laidBy[who] > most {
			by, most = who, laidBy[who]
		}
	}
	var name string
	for i, ia := range ids {
		for _, ib := range ids[i+1:] {
			pa, pb := touched[ia], touched[ib]
			id := wayID(ia, ib)
			if pa.foot && pb.foot || joined[id] {
				continue
			}
			path, signA, signB, ok := w.path(pa, pb)
			if w.err != nil {
				return nil, w.err
			}
			if !ok {
				continue
			}
			if name == "" {
				var display string
				if err = tx.QueryRowContext(ctx, "SELECT display_name FROM players WHERE account_id=?", by).Scan(&display); err != nil {
					return nil, err
				}
				name = strings.ReplaceAll(content.WildsRules.GetWords().GetWayName(), "{name}", display)
			}
			way := &contract.WildsWay{
				Id: id, A: ia, B: ib, Name: name, By: by, Tiles: uint32(len(run)), Epoch: w.ep.wick.Id, At: float64(now),
				Path: worldTiles(path), SignA: worldTiles([][2]int{signA})[0], SignB: worldTiles([][2]int{signB})[0],
			}
			if err = a.putWay(ctx, tx, s.WorldID, w.ep.wick, way, s.AccountID, now); err != nil {
				return nil, err
			}
			joined[id] = true
			made = append(made, way)
		}
	}
	return made, nil
}

// waysAfterLift reroutes or breaks every way whose path crossed the lifted
// tile (x, y): rerouted along the new shortest run between the same places
// with new signs, its name and by kept; broken (deleted) when none is left.
func (a *Server) waysAfterLift(ctx context.Context, tx *sql.Tx, s *store.Snapshot, x, y int, now int64) (broken []string, rerouted []*contract.WildsWay, err error) {
	broken, rerouted = []string{}, []*contract.WildsWay{}
	w, err := a.pathWorld(ctx, tx, s.WorldID, now)
	if err != nil {
		return nil, nil, err
	}
	standing, err := a.ways(ctx, tx, s.WorldID, w.ep.wick, now)
	if err != nil {
		return nil, nil, err
	}
	for _, way := range standing {
		if !slices.ContainsFunc(way.Path, func(t *contract.WorldTile) bool { return int(t.X) == x && int(t.Y) == y }) {
			continue
		}
		pa, okA := w.place(way.A)
		pb, okB := w.place(way.B)
		var path [][2]int
		var signA, signB [2]int
		ok := false
		if okA && okB {
			path, signA, signB, ok = w.path(pa, pb)
		}
		if w.err != nil {
			return nil, nil, w.err
		}
		if !ok {
			if err = worldchange.Delete(ctx, tx, wayKey(s.WorldID, w.ep.wick, way.Id)); err != nil {
				return nil, nil, err
			}
			broken = append(broken, way.Id)
			continue
		}
		way.Path, way.SignA, way.SignB = worldTiles(path), worldTiles([][2]int{signA})[0], worldTiles([][2]int{signB})[0]
		way.Tiles = uint32(len(w.run(path[0][0], path[0][1])))
		if err = a.putWay(ctx, tx, s.WorldID, w.ep.wick, way, s.AccountID, now); err != nil {
			return nil, nil, err
		}
		rerouted = append(rerouted, way)
	}
	return broken, rerouted, nil
}
