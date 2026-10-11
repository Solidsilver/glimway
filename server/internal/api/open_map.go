package api

// The open map's reads and finds (docs/design/open-map.md 2.4, 2.10), as
// contract 8 names them. The path operations are in open_map_paths.go.
//
//	GET  /api/wilds/near/<cx>/<cy>  -> WildsNearResult
//	POST /api/wilds/clear           WildsClearRequest    -> Envelope.wilds_clear
//	POST /api/wilds/lay             WildsLayRequest      -> Envelope.wilds_lay
//	POST /api/wilds/lift            WildsLiftRequest     -> Envelope.wilds_lift
//	POST /api/wilds/discover        WildsDiscoverRequest -> Envelope.wilds_discover
//
// This wick's rumour rides in the player state (rumourComposition) and its
// find is opened through POST /api/wilds/claim.

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"

	"glimway/content"
	"glimway/server/internal/chunks"
	"glimway/server/internal/frontier"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/ports"
	"glimway/server/internal/store"
	"glimway/server/internal/story"
	"glimway/server/internal/wilds"
	"glimway/server/internal/worldchange"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// NearRadius: the near read covers the (2r+1)^2 chunks around its centre.
const NearRadius = 2

// glimpseReach: how far past the frontier the veil lets a glimpse through.
const glimpseReach = 2

func chunkKeyProto(cx, cy int) *contract.WildsChunkKey {
	return &contract.WildsChunkKey{Realm: content.WildsRules.GetRealm(), Layer: 0, Cx: int32(cx), Cy: int32(cy)}
}

// chunkName is a chunk's key in world_changes: "<cx>:<cy>".
func chunkName(cx, cy int) string { return strconv.Itoa(cx) + ":" + strconv.Itoa(cy) }

// signedPair parses "<a>/<b>" (or with sep) as two canonical signed ints.
func signedPair(raw, sep string) (int, int, bool) {
	parts := strings.Split(raw, sep)
	if len(parts) != 2 {
		return 0, 0, false
	}
	var out [2]int
	for i, p := range parts {
		v, err := strconv.Atoi(p)
		if err != nil || strconv.Itoa(v) != p || v < -1_000_000 || v > 1_000_000 {
			return 0, 0, false
		}
		out[i] = v
	}
	return out[0], out[1], true
}

// epochs are the world's two current epochs, made when absent.
type openEpochs struct{ still, wick *contract.WildsEpoch }

func (a *Server) openEpochs(ctx context.Context, tx *sql.Tx, world string, now int64) (openEpochs, error) {
	if a.Config.Epochs == nil {
		return openEpochs{}, store.ErrGeneratorUnavailable
	}
	still, err := chunks.Epoch(ctx, tx, a.Config.Epochs, world, store.EpochStill, now)
	if err != nil {
		return openEpochs{}, err
	}
	wick, err := chunks.Epoch(ctx, tx, a.Config.Epochs, world, store.EpochWick, now)
	return openEpochs{still, wick}, err
}

// of is the epoch a chunk lies in.
func (e openEpochs) of(cx, cy int) *contract.WildsEpoch {
	if wilds.EpochKindAt(cx, cy) == store.EpochStill {
		return e.still
	}
	return e.wick
}

// ---------------------------------------------------------------- near read

// nearRead is GET /api/wilds/near/<cx>/<cy>: the epochs (made when absent),
// the frontier, and the changing state of the 5x5 chunks around (cx, cy).
// Its chunks are made on first read, like the chunk route's.
func (a *Server) nearRead(w http.ResponseWriter, r *http.Request) error {
	cx, cy, ok := signedPair(strings.TrimPrefix(r.URL.Path, "/api/wilds/near/"), "/")
	if !ok {
		return fail(404, "not-found")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if !frontier.Inside(s.WorldID, cx, cy) {
		return fail(409, "beyond-frontier")
	}
	view, err := a.near(r.Context(), tx, s, cx, cy, a.Config.Now().Unix())
	if err != nil {
		return chunkError(err)
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	writeProto(w, 200, view)
	return nil
}

func (a *Server) near(ctx context.Context, tx *sql.Tx, s store.Snapshot, cx, cy int, now int64) (*contract.WildsNearResult, error) {
	ep, err := a.openEpochs(ctx, tx, s.WorldID, now)
	if err != nil {
		return nil, err
	}
	x0, y0, x1, y1 := frontier.Rect(s.WorldID)
	out := &contract.WildsNearResult{
		Still: proto.Clone(ep.still).(*contract.WildsEpoch), Wick: proto.Clone(ep.wick).(*contract.WildsEpoch),
		Frontier: &contract.WildsFrontier{Rect: &contract.WildsChunkRect{MinCx: int32(x0), MinCy: int32(y0), MaxCx: int32(x1), MaxCy: int32(y1)}},
		Center:   chunkKeyProto(cx, cy), Radius: NearRadius,
		Entities: []*contract.WildsEntityState{}, PersonalClaims: []*contract.WildsPersonalClaim{},
		Discoveries: []*contract.WildsDiscovery{}, Lanterns: []*contract.WildsLantern{}, Echoes: []*contract.EchoAssignment{},
		Ground: []*contract.ChunkGroundChanges{}, Materials: map[string]float64{}, Glimpse: []*contract.WildsGlimpse{}, Ways: []*contract.WildsWay{},
	}
	// The window's chunks, inside the frontier, row-major.
	type entityAt struct {
		epoch, kind string
	}
	window := map[[2]int]bool{}
	entities := map[string]entityAt{}
	var order []string
	claimable := map[string]bool{}
	var keys []worldchange.ChunkEpoch
	whitequiet := false
	for y := cy - NearRadius; y <= cy+NearRadius; y++ {
		for x := cx - NearRadius; x <= cx+NearRadius; x++ {
			if !frontier.Inside(s.WorldID, x, y) {
				continue
			}
			window[[2]int{x, y}] = true
			e := ep.of(x, y)
			m, err := a.Config.Chunks.Chunk(ctx, tx, s.WorldID, e.Id, 0, int32(x), int32(y))
			if err != nil {
				return nil, err
			}
			for _, en := range m.Entities {
				entities[en.Id] = entityAt{e.Id, en.Kind}
				order = append(order, en.Id)
				claimable[en.Id] = true
			}
			for _, site := range m.Sites {
				if site.Kind == contract.SiteKind_SITE_KIND_RUMOUR {
					claimable[site.Id] = true
				}
			}
			keys = append(keys, worldchange.ChunkEpoch{Chunk: chunkName(x, y), Epoch: e.Id})
			if f := wilds.FootprintAt(x, y); f != nil && f.GetId() == story.EchoFootprint {
				whitequiet = true
			}
		}
	}
	epochs := []any{ep.still.Id, ep.wick.Id}
	rows := map[string]entityRow{}
	q, err := tx.QueryContext(ctx, "SELECT epoch,entity_id,cycle,state,available_at,by_id,at FROM entity_state WHERE epoch IN (?,?)", epochs...)
	if err != nil {
		return nil, err
	}
	for q.Next() {
		var epoch, id string
		var r entityRow
		if err = q.Scan(&epoch, &id, &r.cycle, &r.state, &r.availableAt, &r.by, &r.at); err != nil {
			q.Close()
			return nil, err
		}
		if at, ok := entities[id]; ok && at.epoch == epoch {
			rows[id] = r
		}
	}
	if err = closeRows(q); err != nil {
		return nil, err
	}
	for _, id := range order {
		at := entities[id]
		r, ok := rows[id]
		if !ok {
			r = entityRow{state: "available"}
		}
		out.Entities = append(out.Entities, r.projected(at.kind, now).view(at.epoch, id))
	}
	if q, err = tx.QueryContext(ctx, "SELECT entity_id,at FROM personal_claims WHERE account_id=? AND epoch IN (?,?) ORDER BY entity_id", s.AccountID, ep.still.Id, ep.wick.Id); err != nil {
		return nil, err
	}
	for q.Next() {
		var c contract.WildsPersonalClaim
		var at int64
		if err = q.Scan(&c.EntityId, &at); err != nil {
			q.Close()
			return nil, err
		}
		if claimable[c.EntityId] {
			c.At = float64(at)
			out.PersonalClaims = append(out.PersonalClaims, &c)
		}
	}
	if err = closeRows(q); err != nil {
		return nil, err
	}
	// Every discovery of the two epochs: the Map tab names every place's
	// finder, not only the window's (a world has a handful a wick).
	if out.Discoveries, err = discoveries(ctx, tx, ep.still.Id, ep.wick.Id); err != nil {
		return nil, err
	}
	if q, err = tx.QueryContext(ctx, "SELECT l.id,l.owner_id,p.display_name,l.x,l.y,l.lit_by,l.at,l.lit_at FROM lanterns l JOIN players p ON p.account_id=l.owner_id WHERE l.epoch IN (?,?) ORDER BY l.owner_id", epochs...); err != nil {
		return nil, err
	}
	S := chunkSize()
	for q.Next() {
		v, err := scanLantern(q)
		if err != nil {
			q.Close()
			return nil, err
		}
		if window[[2]int{wilds.FloorDiv(int(v.X), S), wilds.FloorDiv(int(v.Y), S)}] {
			out.Lanterns = append(out.Lanterns, v)
		}
	}
	if err = closeRows(q); err != nil {
		return nil, err
	}
	if whitequiet {
		sites, err := story.FootprintSites(ctx, tx, a.Config.Chunks, s.WorldID, ep.wick, story.EchoFootprint)
		if err != nil {
			return nil, err
		}
		if out.Echoes, err = a.Config.Story.Echoes(ctx, tx, s, ports.EchoInput{Epoch: proto.Clone(ep.wick).(*contract.WildsEpoch), Sites: sites}); err != nil {
			return nil, err
		}
	}
	changes, err := worldchange.List(ctx, tx, s.WorldID, content.WildsRules.GetRealm(), 0, keys, groundKind, now)
	if err != nil {
		return nil, err
	}
	for _, row := range changes {
		if row.Entity != groundEntity {
			continue
		}
		g, err := decodeGround(row.State)
		if err != nil {
			return nil, err
		}
		if len(g.Changes) == 0 {
			continue
		}
		x, y, _ := signedPair(row.Chunk, ":")
		out.Ground = append(out.Ground, &contract.ChunkGroundChanges{Chunk: chunkKeyProto(x, y), Epoch: row.Epoch, Changes: g})
	}
	ways, err := a.ways(ctx, tx, s.WorldID, ep.wick, now)
	if err != nil {
		return nil, err
	}
	for _, way := range ways {
		if slices.ContainsFunc(way.Path, func(t *contract.WorldTile) bool {
			return window[[2]int{wilds.FloorDiv(int(t.X), S), wilds.FloorDiv(int(t.Y), S)}]
		}) {
			out.Ways = append(out.Ways, way)
		}
	}
	if g := a.Config.WildsGenerator; g != nil {
		for y := cy - NearRadius - glimpseReach; y <= cy+NearRadius+glimpseReach; y++ {
			for x := cx - NearRadius - glimpseReach; x <= cx+NearRadius+glimpseReach; x++ {
				if frontier.Inside(s.WorldID, x, y) || y > int(content.WildsRules.GetFrontier().GetSouthLimit()) || max(x0-x, x-x1, y0-y, y-y1) > glimpseReach {
					continue
				}
				v, err := g.Glimpse(proto.Clone(ep.wick).(*contract.WildsEpoch), int32(x), int32(y))
				if err != nil {
					return nil, err
				}
				out.Glimpse = append(out.Glimpse, &contract.WildsGlimpse{Chunk: chunkKeyProto(x, y), Land: v.Land, River: v.River})
			}
		}
	}
	m, err := materialsProto(ctx, tx, s.AccountID)
	out.Materials = m
	return out, err
}

func scanLantern(rows *sql.Rows) (*contract.WildsLantern, error) {
	var v contract.WildsLantern
	var x, y, at int64
	var litBy sql.NullString
	var litAt sql.NullInt64
	if err := rows.Scan(&v.Id, &v.OwnerId, &v.DisplayName, &x, &y, &litBy, &at, &litAt); err != nil {
		return nil, err
	}
	v.X, v.Y, v.At = float64(x), float64(y), float64(at)
	if litBy.Valid {
		v.LitBy = wrapperspb.String(litBy.String)
	}
	if litAt.Valid {
		v.LitAt = wrapperspb.Double(float64(litAt.Int64))
	}
	return &v, nil
}

func discoveries(ctx context.Context, tx *sql.Tx, epochs ...string) ([]*contract.WildsDiscovery, error) {
	out := []*contract.WildsDiscovery{}
	args := make([]any, len(epochs))
	for i, e := range epochs {
		args[i] = e
	}
	q, err := tx.QueryContext(ctx, "SELECT d.entity_id,d.poi_id,d.discoverer_id,p.display_name,d.at FROM discoveries d JOIN players p ON p.account_id=d.discoverer_id WHERE d.epoch IN (?"+strings.Repeat(",?", len(epochs)-1)+") ORDER BY d.entity_id", args...)
	if err != nil {
		return nil, err
	}
	for q.Next() {
		var d contract.WildsDiscovery
		var at int64
		if err = q.Scan(&d.EntityId, &d.PoiId, &d.DiscovererId, &d.DisplayName, &at); err != nil {
			q.Close()
			return nil, err
		}
		d.At = float64(at)
		out = append(out, &d)
	}
	return out, closeRows(q)
}

// ---------------------------------------------------------------- first to find

// placeAt is a cell place's mark in world tiles, found in the chunks around
// the player (its landmark stands within its find radius of them).
type placeAt struct {
	id, kind string
	x, y     int
	radius   int
}

func placeKind(id string) *content.WildsPlaceKind {
	for _, k := range content.WildsRules.PlaceKinds {
		if k.GetId() == id {
			return k
		}
	}
	return nil
}

// findPlace looks for a cell place's mark in the chunk (cx, cy) and its
// eight neighbours, in the epoch.
func (a *Server) findPlace(ctx context.Context, tx *sql.Tx, world string, e *contract.WildsEpoch, id string, cx, cy int) (*placeAt, error) {
	S := chunkSize()
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			x, y := cx+dx, cy+dy
			if !frontier.Inside(world, x, y) || wilds.EpochKindAt(x, y) != e.Kind {
				continue
			}
			m, err := a.Config.Chunks.Chunk(ctx, tx, world, e.Id, 0, int32(x), int32(y))
			if err != nil {
				return nil, err
			}
			for _, p := range m.Places {
				if k := placeKind(p.Kind); p.Id == id && k != nil {
					return &placeAt{id: p.Id, kind: p.Kind, x: x*S + int(p.Tx), y: y*S + int(p.Ty), radius: int(k.GetFindRadius())}, nil
				}
			}
		}
	}
	return nil, nil
}

// wildsDiscover is POST /api/wilds/discover (decision 20): the client sends
// it when the hero enters a place's find radius. The first insert this wick
// wins and rolls the "discovery" table; later finders get the name only.
func (a *Server) wildsDiscover(w http.ResponseWriter, r *http.Request) error {
	req := &contract.WildsDiscoverRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		e, err := a.epochFor(ctx, tx, *s, req.Epoch, now)
		if err != nil {
			return nil, err
		}
		px, py, ok := signedPair(strings.TrimPrefix(req.Place, "place:"), ":")
		if !ok || !strings.HasPrefix(req.Place, "place:") || wilds.FootprintCell(px, py) {
			return nil, fail(404, "entity-not-found")
		}
		tx0, ty0 := wildsTileOf(s.State.Position.X, s.State.Position.Y)
		S := chunkSize()
		place, err := a.findPlace(ctx, tx, s.WorldID, e, req.Place, wilds.FloorDiv(tx0, S), wilds.FloorDiv(ty0, S))
		if err != nil {
			return nil, chunkError(err)
		}
		if place == nil {
			return nil, fail(409, "too-far-away")
		}
		// The find radius is Chebyshev from the landmark (wilds.Place).
		if err = nearWithin(*s, place.x, place.y, 2*place.radius); err != nil {
			return nil, err
		}
		if max(intAbs(tx0-place.x), intAbs(ty0-place.y)) > place.radius {
			return nil, fail(409, "too-far-away")
		}
		res, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO discoveries VALUES(?,?,?,?,?)", e.Id, place.id, place.kind, s.AccountID, now)
		if err != nil {
			return nil, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return nil, err
		}
		out := &contract.WildsDiscoverResult{Epoch: e.Id, First: n == 1, Loot: &contract.WildsLoot{}}
		if out.First {
			loot, err := rollTable(e, "discovery", place.id, 0)
			if err != nil {
				return nil, err
			}
			if err = grantLoot(ctx, tx, s, loot, "wilds-discover", e.Id+":"+place.id, now); err != nil {
				return nil, err
			}
			out.Loot = lootProto(loot)
		}
		d := &contract.WildsDiscovery{EntityId: place.id, PoiId: place.kind}
		var at int64
		if err = tx.QueryRowContext(ctx, "SELECT d.discoverer_id,p.display_name,d.at FROM discoveries d JOIN players p ON p.account_id=d.discoverer_id WHERE d.epoch=? AND d.entity_id=?", e.Id, place.id).Scan(&d.DiscovererId, &d.DisplayName, &at); err != nil {
			return nil, err
		}
		d.At = float64(at)
		out.Discovery = d
		if out.Materials, err = materialsProto(ctx, tx, s.AccountID); err != nil {
			return nil, err
		}
		return out, nil
	})
}

// ---------------------------------------------------------------- the rumour

// rumour is this wick's rumour as the player sees it, or nil when there is
// none (no generator, or the epoch has none).
func (a *Server) rumour(ctx context.Context, tx *sql.Tx, s store.Snapshot, now int64) (*contract.WildsRumour, error) {
	g := a.Config.WildsGenerator
	if g == nil || a.Config.Epochs == nil || s.WorldID == "" {
		return nil, nil
	}
	wick, err := chunks.Epoch(ctx, tx, a.Config.Epochs, s.WorldID, store.EpochWick, now)
	if errors.Is(err, store.ErrGeneratorUnavailable) || errors.Is(err, chunks.ErrUnavailable) || errors.Is(err, chunks.ErrEpochEnded) || errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	r, ok, err := g.Rumour(proto.Clone(wick).(*contract.WildsEpoch))
	if err != nil || !ok {
		return nil, err
	}
	out := &contract.WildsRumour{
		Epoch: wick.Id, Place: r.Place, Landmark: r.Landmark, Compass: r.Compass,
		Ring: uint32(max(r.Ring, 1)), PastRiver: r.PastRiver, Site: r.Site,
	}
	err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM personal_claims WHERE epoch=? AND entity_id=? AND account_id=?)", wick.Id, r.Site, s.AccountID).Scan(&out.Opened)
	return out, err
}

// rumourComposition puts this wick's rumour in every player state (open-
// map.md 2.10: Elara tells it in the library). It is read fresh each time,
// so a turning brings the next wick's.
type rumourComposition struct {
	store.StateComposition
	a   *Server
	now func() time.Time
}

func (c rumourComposition) PlayerState(ctx context.Context, tx *sql.Tx, s store.Snapshot) (*contract.PlayerState, error) {
	state, err := c.StateComposition.PlayerState(ctx, tx, s)
	if err != nil || s.AccountID == "" {
		return state, err
	}
	state.Rumour, err = c.a.rumour(ctx, tx, s, c.now().Unix())
	return state, err
}

// openRumour opens this wick's rumour find (claimed as "rumour:<cx>:<cy>",
// cycle 0): a personal claim like a chest's, so everyone can open it once a
// wick, rolling the "rumour" table. The first to open it is its discoverer.
func (a *Server) openRumour(ctx context.Context, tx *sql.Tx, s *store.Snapshot, e *contract.WildsEpoch, req *contract.WildsClaimRequest, now int64) (any, error) {
	cx, cy, ok := signedPair(strings.TrimPrefix(req.EntityId, "rumour:"), ":")
	if !ok || req.EntityId != fmt.Sprintf("rumour:%d:%d", cx, cy) || e.Kind != store.EpochWick || !frontier.Inside(s.WorldID, cx, cy) || wilds.EpochKindAt(cx, cy) != e.Kind {
		return nil, fail(404, "entity-not-found")
	}
	if req.Cycle != 0 {
		return nil, fail(409, "old-cycle")
	}
	m, err := a.Config.Chunks.Chunk(ctx, tx, s.WorldID, e.Id, 0, int32(cx), int32(cy))
	if err != nil {
		return nil, chunkError(err)
	}
	i := slices.IndexFunc(m.Sites, func(site *contract.StorySite) bool {
		return site.Id == req.EntityId && site.Kind == contract.SiteKind_SITE_KIND_RUMOUR
	})
	if i < 0 {
		return nil, fail(404, "entity-not-found")
	}
	S := chunkSize()
	if err = nearWilds(*s, cx*S+int(m.Sites[i].Tx), cy*S+int(m.Sites[i].Ty)); err != nil {
		return nil, err
	}
	res, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO personal_claims VALUES(?,?,?,?)", e.Id, req.EntityId, s.AccountID, now)
	if err != nil {
		return nil, err
	}
	if n, err := res.RowsAffected(); err != nil || n == 0 {
		if err == nil {
			err = fail(409, "already-claimed")
		}
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO discoveries VALUES(?,?,'rumour',?,?)", e.Id, req.EntityId, s.AccountID, now); err != nil {
		return nil, err
	}
	if err = claimRate(ctx, tx, s.AccountID, now); err != nil {
		return nil, err
	}
	loot, err := rollTable(e, "rumour", req.EntityId, 0)
	if err != nil {
		return nil, err
	}
	if err = grantLoot(ctx, tx, s, loot, "wilds-rumour", e.Id+":"+req.EntityId, now); err != nil {
		return nil, err
	}
	balances, err := materialsProto(ctx, tx, s.AccountID)
	if err != nil {
		return nil, err
	}
	return &contract.WildsClaimResult{Epoch: e.Id, Entity: entityRow{state: "available"}.view(e.Id, req.EntityId), Loot: lootProto(loot), Materials: balances, Papers: []string{}}, nil
}

// rollTable rolls a named loot table (discovery, rumour) for an id, as
// RollEntityLoot rolls an entity's, honouring the table's own trinket
// chance. Generator v3's wilds.RollTableLootV3 takes this over when it lands.
func rollTable(e *contract.WildsEpoch, table, id string, cycle int) (wilds.LootDrop, error) {
	drop := wilds.LootDrop{Materials: []wilds.MaterialQty{}}
	data := content.WildsRules
	t, ok := data.LootTables[table]
	if !ok {
		return drop, fmt.Errorf("wilds: missing loot table %s", table)
	}
	rng := wilds.NewRng(wilds.LootSeed(generationOf(e), id, cycle))
	for _, entry := range t.GetEntries() {
		chance := rng.NextInt(1000)
		lo, hi := int(entry.GetMin()), int(entry.GetMax())
		qty := lo + rng.NextInt(hi-lo+1)
		if chance < int(entry.GetChancePermille()) {
			drop.Materials = append(drop.Materials, wilds.MaterialQty{ID: entry.GetMaterial(), Qty: qty})
		}
	}
	trinket := int(data.GetTrinketChancePermille())
	if t.TrinketChancePermille != nil {
		trinket = int(t.GetTrinketChancePermille())
	}
	if rng.NextInt(1000) < trinket {
		v := data.Trinkets[rng.NextInt(len(data.Trinkets))]
		drop.Trinket = &v
	}
	return drop, nil
}
