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
	"glimway/server/internal/location"
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

// epochs are the world's two current epochs, made when absent, and the
// epochs its held chunks are pinned to (the composer's held source).
type openEpochs struct {
	still, wick *contract.WildsEpoch
	held        map[[2]int]*contract.WildsEpoch
}

func (a *Server) openEpochs(ctx context.Context, tx *sql.Tx, world string, now int64) (openEpochs, error) {
	if a.Config.Epochs == nil {
		return openEpochs{}, store.ErrGeneratorUnavailable
	}
	still, err := chunks.Epoch(ctx, tx, a.Config.Epochs, world, store.EpochStill, now)
	if err != nil {
		return openEpochs{}, err
	}
	wick, err := chunks.Epoch(ctx, tx, a.Config.Epochs, world, store.EpochWick, now)
	if err != nil {
		return openEpochs{}, err
	}
	// After the wick: reading it is the turning, which judges holds.
	held, err := store.HeldEpochs(ctx, tx, world)
	return openEpochs{still, wick, held}, err
}

// of is the epoch a chunk lies in: its held epoch, else its kind's.
func (e openEpochs) of(cx, cy int) *contract.WildsEpoch {
	if h := e.held[[2]int{cx, cy}]; h != nil {
		return h
	}
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
	ctx, now := r.Context(), a.requestTime(r.Context()).Unix()
	ep, err := a.openEpochs(ctx, tx, s.WorldID, now)
	if err != nil {
		return chunkError(err)
	}
	// Only past a turning that may have let holds go is the frontier this
	// read's to check; a refusal keeps that turning (it is upkeep, done).
	if !location.OnGrid(s.WorldID, cx, cy) {
		if err = tx.Commit(); err != nil {
			return err
		}
		return fail(409, "beyond-frontier")
	}
	view, err := a.near(ctx, tx, s, ep, cx, cy, now)
	if err != nil {
		return chunkError(err)
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	writeProto(w, 200, view)
	return nil
}

func (a *Server) near(ctx context.Context, tx *sql.Tx, s store.Snapshot, ep openEpochs, cx, cy int, now int64) (*contract.WildsNearResult, error) {
	x0, y0, x1, y1 := frontier.Rect(s.WorldID)
	held := frontier.Held(s.WorldID)
	reach := &contract.WildsFrontier{Rect: &contract.WildsChunkRect{MinCx: int32(x0), MinCy: int32(y0), MaxCx: int32(x1), MaxCy: int32(y1)}, Held: make([]*contract.WildsChunkKey, 0, len(held))}
	for _, k := range held {
		reach.Held = append(reach.Held, chunkKeyProto(k[0], k[1]))
	}
	out := &contract.WildsNearResult{
		Still: proto.Clone(ep.still).(*contract.WildsEpoch), Wick: proto.Clone(ep.wick).(*contract.WildsEpoch),
		Frontier: reach,
		Center:   chunkKeyProto(cx, cy), Radius: NearRadius,
		Entities: []*contract.WildsEntityState{}, PersonalClaims: []*contract.WildsPersonalClaim{},
		Discoveries: []*contract.WildsDiscovery{}, Lanterns: []*contract.WildsLantern{}, Echoes: []*contract.EchoAssignment{},
		Ground: []*contract.ChunkGroundChanges{}, Materials: map[string]float64{}, Glimpse: []*contract.WildsGlimpse{}, Ways: []*contract.WildsWay{},
		Chunks: []*contract.NearChunk{}, Held: []*contract.WildsEpoch{},
	}
	// The window's chunks on the grid, row-major: a fixed chunk is listed
	// (its body comes from content, under its pseudo-epoch, and it has no
	// state); a generated one, inside the frontier, is read for its state,
	// a held one under its pinned epoch (listed in Held when not this wick).
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
			if src := location.SourceOf(x, y); src.Kind == location.SourceFixed {
				out.Chunks = append(out.Chunks, &contract.NearChunk{Chunk: chunkKeyProto(x, y), Source: src.Kind.String(), Epoch: chunks.FixedEpoch(src.Layout, src.Revision)})
				continue
			}
			if !frontier.Inside(s.WorldID, x, y) {
				continue
			}
			window[[2]int{x, y}] = true
			e, source := ep.of(x, y), location.SourceGenerated
			if h := ep.held[[2]int{x, y}]; h != nil {
				source = location.SourceHeld
				if h.Id != ep.wick.Id && !slices.ContainsFunc(out.Held, func(o *contract.WildsEpoch) bool { return o.Id == h.Id }) {
					out.Held = append(out.Held, proto.Clone(h).(*contract.WildsEpoch))
				}
			}
			out.Chunks = append(out.Chunks, &contract.NearChunk{Chunk: chunkKeyProto(x, y), Source: source.String(), Epoch: e.Id})
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
				// A held chunk's rumour site is its own wick's: no find.
				if site.Kind == contract.SiteKind_SITE_KIND_RUMOUR && ep.held[[2]int{x, y}] == nil {
					claimable[site.Id] = true
				}
			}
			keys = append(keys, worldchange.ChunkEpoch{Chunk: chunkName(x, y), Epoch: e.Id})
			if f := wilds.FootprintAt(x, y); f != nil && f.GetId() == story.EchoFootprint {
				whitequiet = true
			}
		}
	}
	// Entity state, claims and lanterns under the two epochs and the held
	// ones in the window.
	withHeld := []any{ep.still.Id, ep.wick.Id}
	for _, h := range out.Held {
		withHeld = append(withHeld, h.Id)
	}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(withHeld)), ",")
	rows := map[string]entityRow{}
	q, err := tx.QueryContext(ctx, "SELECT epoch,entity_id,cycle,state,available_at,by_id,at FROM entity_state WHERE epoch IN ("+marks+")", withHeld...)
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
	// A camp's current cycle, as its reader stands to it (shared-fights.md
	// 1.9): whether they witnessed that cycle's fall, and whether they have
	// claimed it. A viewer who comes back after the room slept reads this.
	camps, err := readCampStanding(ctx, tx, s.AccountID, withHeld...)
	if err != nil {
		return nil, err
	}
	var campClaims []*contract.WildsPersonalClaim
	for _, id := range order {
		at := entities[id]
		r, ok := rows[id]
		if !ok {
			r = entityRow{state: "available"}
		}
		r = r.projected(at.kind, now)
		v := r.view(at.epoch, id)
		if at.kind == "camp" {
			v.CampClaimable = camps.claimable(v)
			if claimedAt, ok := camps.claimed[fallID{at.epoch, id, r.cycle}]; ok {
				campClaims = append(campClaims, &contract.WildsPersonalClaim{EntityId: id, At: float64(claimedAt)})
			}
		}
		out.Entities = append(out.Entities, v)
	}
	if q, err = tx.QueryContext(ctx, "SELECT entity_id,at FROM personal_claims WHERE account_id=? AND epoch IN ("+marks+") ORDER BY entity_id", append([]any{s.AccountID}, withHeld...)...); err != nil {
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
	out.PersonalClaims = append(out.PersonalClaims, campClaims...)
	slices.SortStableFunc(out.PersonalClaims, func(a, b *contract.WildsPersonalClaim) int { return strings.Compare(a.EntityId, b.EntityId) })
	// Every discovery of the two epochs and the window's held ones: the Map
	// tab names every place's finder, not only the window's (a world has a
	// handful a wick).
	if out.Discoveries, err = discoveries(ctx, tx, withHeld...); err != nil {
		return nil, err
	}
	if q, err = tx.QueryContext(ctx, "SELECT l.id,l.owner_id,p.display_name,l.x,l.y,l.lit_by,l.at,l.lit_at FROM lanterns l JOIN players p ON p.account_id=l.owner_id WHERE l.epoch IN ("+marks+") ORDER BY l.owner_id", withHeld...); err != nil {
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
		var at []chunks.ChunkXY
		for y := cy - NearRadius - glimpseReach; y <= cy+NearRadius+glimpseReach; y++ {
			for x := cx - NearRadius - glimpseReach; x <= cx+NearRadius+glimpseReach; x++ {
				// Past the reach, but within glimpseReach of it: the static
				// frontier's, or a held chunk's slack.
				nearHeld := slices.ContainsFunc(held, func(k [2]int) bool {
					return max(abs(k[0]-x), abs(k[1]-y)) <= frontier.Slack()+glimpseReach
				})
				if frontier.Inside(s.WorldID, x, y) || y > int(content.WildsRules.GetFrontier().GetSouthLimit()) || !nearHeld && wilds.NearestFootprint(x, y) > int(content.WildsRules.GetFrontier().GetReach())+glimpseReach {
					continue
				}
				at = append(at, chunks.ChunkXY{CX: int32(x), CY: int32(y)})
			}
		}
		if len(at) > 0 {
			vs, err := g.Glimpses(proto.Clone(ep.wick).(*contract.WildsEpoch), at)
			if err != nil {
				return nil, err
			}
			if len(vs) != len(at) {
				return nil, fmt.Errorf("near read: %d glimpses for %d chunks", len(vs), len(at))
			}
			for i, v := range vs {
				out.Glimpse = append(out.Glimpse, &contract.WildsGlimpse{Chunk: chunkKeyProto(int(at[i].CX), int(at[i].CY)), Land: v.Land, River: v.River})
			}
		}
	}
	// Only the occupied chunk is explored by this read; the map submits its own known list.
	var known []*contract.WildsChunkKey
	if s.State.Area == outdoorsArea {
		x, y := wilds.ChunkOf(wilds.TileOfPixel(s.State.Position.X, s.State.Position.Y))
		known = append(known, chunkKeyProto(x, y))
	}
	out.Land, err = a.mapStatus(ctx, tx, s, ep, known, now)
	if err != nil {
		return nil, err
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

func discoveries(ctx context.Context, tx *sql.Tx, epochs ...any) ([]*contract.WildsDiscovery, error) {
	out := []*contract.WildsDiscovery{}
	q, err := tx.QueryContext(ctx, "SELECT d.entity_id,d.poi_id,d.discoverer_id,p.display_name,d.at,d.epoch FROM discoveries d JOIN players p ON p.account_id=d.discoverer_id WHERE d.epoch IN (?"+strings.Repeat(",?", len(epochs)-1)+") ORDER BY d.entity_id", epochs...)
	if err != nil {
		return nil, err
	}
	for q.Next() {
		var d contract.WildsDiscovery
		var at int64
		if err = q.Scan(&d.EntityId, &d.PoiId, &d.DiscovererId, &d.DisplayName, &at, &d.Epoch); err != nil {
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
// eight neighbours, among those served in the epoch: a held chunk is its
// pinned epoch's, the rest this wick's (place ids repeat across wicks, so
// the epoch tells a held chunk's place from this wick's of the same cell).
func (a *Server) findPlace(ctx context.Context, tx *sql.Tx, world string, e *contract.WildsEpoch, id string, cx, cy int, now int64) (*placeAt, error) {
	S := chunkSize()
	ep, err := a.openEpochs(ctx, tx, world, now)
	if err != nil {
		return nil, err
	}
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			x, y := cx+dx, cy+dy
			if !frontier.Inside(world, x, y) || location.SourceOf(x, y).Kind != location.SourceGenerated || ep.of(x, y).Id != e.Id {
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
// it when the hero enters a place's find radius, naming the epoch the
// place's chunk is served in (a held chunk's pinned one). The first insert
// that epoch wins and rolls the "discovery" table; later finders get the
// name only.
func (a *Server) wildsDiscover(w http.ResponseWriter, r *http.Request) error {
	req := &contract.WildsDiscoverRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		e, err := a.epochFor(ctx, tx, *s, req.Epoch, now, true)
		if err != nil {
			return nil, err
		}
		px, py, ok := signedPair(strings.TrimPrefix(req.Place, "place:"), ":")
		if !ok || !strings.HasPrefix(req.Place, "place:") || wilds.FootprintCell(px, py) {
			return nil, fail(404, "entity-not-found")
		}
		tx0, ty0 := wildsTileOf(s.State.Position.X, s.State.Position.Y)
		S := chunkSize()
		place, err := a.findPlace(ctx, tx, s.WorldID, e, req.Place, wilds.FloorDiv(tx0, S), wilds.FloorDiv(ty0, S), now)
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
			loot, err := wilds.RollTableLoot(generationOf(e), "discovery", place.id, 0)
			if err != nil {
				return nil, err
			}
			if err = grantLoot(ctx, tx, s, loot, "wilds-discover", e.Id+":"+place.id, now); err != nil {
				return nil, err
			}
			out.Loot = lootProto(loot)
		}
		d := &contract.WildsDiscovery{EntityId: place.id, PoiId: place.kind, Epoch: e.Id}
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
	wick, err := a.Config.Epochs.Current(ctx, tx, s.WorldID, store.EpochWick, now)
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
	// A held chunk keeps an older wick's land: this wick's find isn't there.
	if held, err := store.HeldEpoch(ctx, tx, s.WorldID, int(r.CX), int(r.CY)); err != nil || held != nil {
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
	a *Server
}

func (c rumourComposition) PlayerState(ctx context.Context, tx *sql.Tx, s store.Snapshot, now time.Time) (*contract.PlayerState, error) {
	state, err := c.StateComposition.PlayerState(ctx, tx, s, now)
	if err != nil || s.AccountID == "" {
		return state, err
	}
	state.Rumour, err = c.a.rumour(ctx, tx, s, now.Unix())
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
	// The find is this wick's, and not in a held chunk (as rumour reads it):
	// a held chunk's blob still carries its own wick's rumour site.
	wick, err := a.Config.Epochs.Current(ctx, tx, s.WorldID, store.EpochWick, now)
	if err != nil {
		return nil, chunkError(err)
	}
	held, err := store.HeldEpoch(ctx, tx, s.WorldID, cx, cy)
	if err != nil {
		return nil, err
	}
	if wick.Id != e.Id || held != nil {
		return nil, fail(404, "entity-not-found")
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
	loot, err := wilds.RollTableLoot(generationOf(e), "rumour", req.EntityId, 0)
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
