package api

// The Wilds from the server (server-first.md 3): a region epoch and its nine
// chunks are made once, when a region read finds none current, and stored
// (store/chunks.go). Afterwards everything reads the stored chunks: the chunk
// route serves them, the region view lists the changing state, and claims,
// relights and Echo settlements check entities and sites against them.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/ports"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

func regionDefinition(id string) (content.WildsRegion, bool) {
	for _, r := range content.WildsRules.Regions {
		if r.ID == id {
			return r, true
		}
	}
	return content.WildsRegion{}, false
}

// wildsArea is the `where` area of a region: "wilds:<region>".
func wildsArea(region string) string { return "wilds:" + region }

func generationOf(e *contract.WildsEpoch) wilds.Epoch {
	return wilds.Epoch{WorldSeed: e.WorldSeed, RegionID: e.RegionId, GeneratorVersion: int(e.GeneratorVersion), Season: e.Season}
}

// chunkError maps the chunk ports' errors to refusals.
func chunkError(err error) error {
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return fail(404, "not-found")
	case errors.Is(err, chunks.ErrEpochEnded):
		return fail(409, "epoch-ended")
	case errors.Is(err, chunks.ErrUnavailable), errors.Is(err, store.ErrGeneratorUnavailable):
		return fail(503, "generator-unavailable")
	}
	return err
}

// epochFor reads a named epoch for a mutation: the caller's world, the
// current generator version, not ended.
func (a *Server) epochFor(ctx context.Context, tx *sql.Tx, s store.Snapshot, id string, now int64) (*contract.WildsEpoch, error) {
	var world string
	var starts int64
	var ends sql.NullInt64
	e := &contract.WildsEpoch{}
	err := tx.QueryRowContext(ctx, "SELECT id,world_id,world_seed,region_id,generator_version,season,starts_at,ends_at FROM region_epochs WHERE id=?", id).Scan(&e.Id, &world, &e.WorldSeed, &e.RegionId, &e.GeneratorVersion, &e.Season, &starts, &ends)
	if err == sql.ErrNoRows {
		return nil, fail(404, "epoch-not-found")
	}
	if err != nil {
		return nil, err
	}
	if world != s.WorldID {
		return nil, fail(403, "world-access-denied")
	}
	if int(e.GeneratorVersion) != wilds.GeneratorV2 {
		return nil, fail(503, "generator-unavailable")
	}
	e.StartsAt = float64(starts)
	if ends.Valid {
		e.EndsAt = wrapperspb.Double(float64(ends.Int64))
		if ends.Int64 <= now {
			return nil, fail(409, "epoch-ended")
		}
	}
	return e, nil
}

// regionChunks reads all of an epoch's stored chunks, row-major.
func (a *Server) regionChunks(ctx context.Context, tx *sql.Tx, world string, e *contract.WildsEpoch) ([]*contract.WildsChunk, error) {
	r, ok := regionDefinition(e.RegionId)
	if !ok {
		return nil, sql.ErrNoRows
	}
	out := make([]*contract.WildsChunk, 0, r.GridWidth*r.GridHeight)
	for cy := 0; cy < r.GridHeight; cy++ {
		for cx := 0; cx < r.GridWidth; cx++ {
			m, err := a.Config.Chunks.Chunk(ctx, tx, world, e.Id, 0, int32(cx), int32(cy))
			if err != nil {
				return nil, err
			}
			out = append(out, m)
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- entity state

type entityRow struct {
	cycle       int64
	state       string
	availableAt int64
	by          sql.NullString
	at          sql.NullInt64
}

// projected: a depleted camp or node whose timer has passed shows its next
// cycle, available. Exactly one cycle ahead, however long the absence; the
// read never writes it, a claim does.
func (r entityRow) projected(kind string, now int64) entityRow {
	if (kind == "camp" || kind == "node") && r.state != "available" && r.availableAt <= now {
		return entityRow{cycle: r.cycle + 1, state: "available"}
	}
	return r
}

func readEntityRow(ctx context.Context, tx *sql.Tx, epoch, id string) (entityRow, error) {
	r := entityRow{state: "available"}
	err := tx.QueryRowContext(ctx, "SELECT cycle,state,available_at,by_id,at FROM entity_state WHERE epoch=? AND entity_id=?", epoch, id).Scan(&r.cycle, &r.state, &r.availableAt, &r.by, &r.at)
	if err == sql.ErrNoRows {
		return r, nil
	}
	return r, err
}

func writeEntityRow(ctx context.Context, tx *sql.Tx, epoch, id string, r entityRow) error {
	_, err := tx.ExecContext(ctx, `INSERT INTO entity_state(epoch,entity_id,cycle,state,available_at,by_id,at) VALUES(?,?,?,?,?,?,?)
		ON CONFLICT(epoch,entity_id) DO UPDATE SET cycle=excluded.cycle,state=excluded.state,available_at=excluded.available_at,by_id=excluded.by_id,at=excluded.at`,
		epoch, id, r.cycle, r.state, r.availableAt, r.by, r.at)
	return err
}

func (r entityRow) view(epoch, id string) *contract.WildsEntityState {
	v := &contract.WildsEntityState{Id: id, Epoch: epoch, Cycle: float64(r.cycle), State: r.state, AvailableAt: float64(r.availableAt)}
	if r.by.Valid {
		v.By = wrapperspb.String(r.by.String)
	}
	if r.at.Valid {
		v.At = wrapperspb.Double(float64(r.at.Int64))
	}
	return v
}

// ---------------------------------------------------------------- region view

// wildsService is D's implementation of the region, lantern and land ports.
// It reads the server's other ports (chunks, epochs, story) at call time, so
// a test can swap them.
type wildsService struct{ a *Server }

// Region is the changing state of a region's current epoch, creating the
// epoch (and storing its chunks) when there is none current. That creation
// is the read's only write.
func (w wildsService) Region(ctx context.Context, tx *sql.Tx, s store.Snapshot, region string, now int64) (*contract.WildsRegionResult, error) {
	a := w.a
	if _, ok := regionDefinition(region); !ok {
		return nil, sql.ErrNoRows
	}
	e, err := a.Config.Epochs.Current(ctx, tx, s.WorldID, region, now)
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, chunks.ErrEpochEnded) {
		e, err = a.Config.Epochs.Create(ctx, tx, s.WorldID, region, now)
	}
	if err != nil {
		return nil, err
	}
	all, err := a.regionChunks(ctx, tx, s.WorldID, e)
	if err != nil {
		return nil, err
	}
	out := &contract.WildsRegionResult{Epoch: e, Materials: map[string]float64{}}
	rows := map[string]entityRow{}
	q, err := tx.QueryContext(ctx, "SELECT entity_id,cycle,state,available_at,by_id,at FROM entity_state WHERE epoch=?", e.Id)
	if err != nil {
		return nil, err
	}
	for q.Next() {
		var id string
		var r entityRow
		if err = q.Scan(&id, &r.cycle, &r.state, &r.availableAt, &r.by, &r.at); err != nil {
			q.Close()
			return nil, err
		}
		rows[id] = r
	}
	if err = closeRows(q); err != nil {
		return nil, err
	}
	var sites []ports.EchoSite
	for _, m := range all {
		for _, en := range m.Entities {
			r, ok := rows[en.Id]
			if !ok {
				r = entityRow{state: "available"}
			}
			out.Entities = append(out.Entities, r.projected(en.Kind, now).view(e.Id, en.Id))
		}
		for _, site := range m.Sites {
			sites = append(sites, ports.EchoSite{Site: proto.Clone(site).(*contract.StorySite), CX: m.Cx, CY: m.Cy})
		}
	}
	if q, err = tx.QueryContext(ctx, "SELECT entity_id,at FROM personal_claims WHERE epoch=? AND account_id=? ORDER BY entity_id", e.Id, s.AccountID); err != nil {
		return nil, err
	}
	for q.Next() {
		var c contract.WildsPersonalClaim
		var at int64
		if err = q.Scan(&c.EntityId, &at); err != nil {
			q.Close()
			return nil, err
		}
		c.At = float64(at)
		out.PersonalClaims = append(out.PersonalClaims, &c)
	}
	if err = closeRows(q); err != nil {
		return nil, err
	}
	if q, err = tx.QueryContext(ctx, "SELECT d.entity_id,d.poi_id,d.discoverer_id,p.display_name,d.at FROM discoveries d JOIN players p ON p.account_id=d.discoverer_id WHERE d.epoch=? ORDER BY d.entity_id", e.Id); err != nil {
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
		out.Discoveries = append(out.Discoveries, &d)
	}
	if err = closeRows(q); err != nil {
		return nil, err
	}
	if out.Lanterns, err = lanterns(ctx, tx, e.Id); err != nil {
		return nil, err
	}
	m, err := materials(ctx, tx, s.AccountID)
	if err != nil {
		return nil, err
	}
	for id, qty := range m {
		out.Materials[id] = float64(qty)
	}
	out.Echoes, err = a.Config.Story.Echoes(ctx, tx, s, ports.EchoInput{Epoch: proto.Clone(e).(*contract.WildsEpoch), Sites: sites})
	return out, err
}

func closeRows(rows *sql.Rows) error {
	err := rows.Err()
	if e := rows.Close(); err == nil {
		err = e
	}
	return err
}

func lanterns(ctx context.Context, tx *sql.Tx, epoch string) ([]*contract.WildsLantern, error) {
	out := []*contract.WildsLantern{}
	rows, err := tx.QueryContext(ctx, "SELECT l.id,l.owner_id,p.display_name,l.x,l.y,l.lit_by,l.at,l.lit_at FROM lanterns l JOIN players p ON p.account_id=l.owner_id WHERE l.epoch=? ORDER BY l.owner_id", epoch)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		var v contract.WildsLantern
		var x, y, at int64
		var litBy sql.NullString
		var litAt sql.NullInt64
		if err = rows.Scan(&v.Id, &v.OwnerId, &v.DisplayName, &x, &y, &litBy, &at, &litAt); err != nil {
			rows.Close()
			return nil, err
		}
		v.X, v.Y, v.At = float64(x), float64(y), float64(at)
		if litBy.Valid {
			v.LitBy = wrapperspb.String(litBy.String)
		}
		if litAt.Valid {
			v.LitAt = wrapperspb.Double(float64(litAt.Int64))
		}
		out = append(out, &v)
	}
	return out, closeRows(rows)
}

// GET /api/wilds/region/<id>
func (a *Server) regionRead(w http.ResponseWriter, r *http.Request) error {
	id := strings.TrimPrefix(r.URL.Path, "/api/wilds/region/")
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	view, err := a.Config.Regions.Region(r.Context(), tx, s, id, a.Config.Now().Unix())
	if errors.Is(err, sql.ErrNoRows) {
		return fail(404, "region-not-found")
	}
	if err != nil {
		return chunkError(err)
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	writeProto(w, 200, view)
	return nil
}

// GET /api/wilds/chunk/<epochId>/<layer>/<cx>/<cy>: the stored chunk as
// binary protobuf. Immutable, so the browser may keep it for good; it is
// only ever asked for under an epoch a fresh region read named.
func (a *Server) chunkRead(w http.ResponseWriter, r *http.Request) error {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/wilds/chunk/"), "/")
	if len(parts) != 4 || parts[0] == "" || len(parts[0]) > 128 {
		return fail(404, "not-found")
	}
	var n [3]int32
	for i, p := range parts[1:] {
		v, err := strconv.ParseInt(p, 10, 32)
		if err != nil || strconv.FormatInt(v, 10) != p {
			return fail(404, "not-found")
		}
		n[i] = int32(v)
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	m, err := a.Config.Chunks.Chunk(r.Context(), tx, s.WorldID, parts[0], n[0], n[1], n[2])
	if err != nil {
		return chunkError(err)
	}
	b, err := proto.Marshal(m)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	w.Header().Set("Content-Type", "application/x-protobuf")
	w.Header().Set("Cache-Control", "private, max-age=31536000, immutable")
	w.WriteHeader(200)
	_, err = w.Write(b)
	return err
}

// ---------------------------------------------------------------- reach

// Matches src/game/textures.ts TILE. Entity and site tiles are chunk-local;
// lanterns and these checks use region tiles; `where` is region pixels.
const wildsTileSize = 16
const wildsInteractionRadius = 3

// nearWilds: the player stands in the epoch's region within reach of the
// region tile (x, y).
func nearWilds(s store.Snapshot, region string, x, y int) error {
	if s.State.Area != wildsArea(region) {
		return fail(409, "not-in-wilds")
	}
	r, ok := regionDefinition(region)
	if !ok {
		return fail(404, "region-not-found")
	}
	px, py := math.Floor(s.State.Position.X/wildsTileSize), math.Floor(s.State.Position.Y/wildsTileSize)
	dx, dy := px-float64(x), py-float64(y)
	if px < 0 || py < 0 || px >= float64(r.GridWidth*content.WildsRules.ChunkSize) || py >= float64(r.GridHeight*content.WildsRules.ChunkSize) || dx*dx+dy*dy > wildsInteractionRadius*wildsInteractionRadius {
		return fail(409, "too-far-away")
	}
	return nil
}

// ---------------------------------------------------------------- papers

// wildsPaperSources: the papers whose find the Wilds operations offer to the
// story rules, by source kind (content/papers.json). The rules (lane B)
// decide; these handlers only ask about the right candidates.
var wildsPaperSources = func() map[string][]string {
	var doc struct {
		Papers []struct {
			ID     string `json:"id"`
			Source string `json:"source"`
		} `json:"papers"`
	}
	b, err := content.FS.ReadFile("papers.json")
	if err == nil {
		err = json.Unmarshal(b, &doc)
	}
	if err != nil {
		panic(err)
	}
	out := map[string][]string{}
	for _, p := range doc.Papers {
		out[p.Source] = append(out[p.Source], p.ID)
	}
	return out
}()

// grantFound offers each candidate paper to the story rules and grants
// those that hold, in the operation's transaction.
func (a *Server) grantFound(ctx context.Context, tx *sql.Tx, s *store.Snapshot, input ports.PaperInput, sources []string, now int64) ([]string, error) {
	out := []string{}
	for _, source := range sources {
		for _, paper := range wildsPaperSources[source] {
			input.Paper = paper
			ok, err := a.Config.Story.Eligible(ctx, tx, *s, input)
			if err != nil {
				return nil, err
			}
			if !ok {
				continue
			}
			g, err := a.Config.Story.Grant(ctx, tx, s, paper, now)
			if err != nil {
				return nil, err
			}
			if g.Added {
				out = append(out, g.Paper)
			}
		}
	}
	return out, nil
}

// ---------------------------------------------------------------- claim

func claimRate(ctx context.Context, tx *sql.Tx, id string, now int64) error {
	var at int64
	var n int
	err := tx.QueryRowContext(ctx, "SELECT window_at,qty FROM claim_rate WHERE account_id=?", id).Scan(&at, &n)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == sql.ErrNoRows || now-at >= 60 {
		_, err = tx.ExecContext(ctx, "INSERT INTO claim_rate VALUES(?,?,1) ON CONFLICT(account_id) DO UPDATE SET window_at=excluded.window_at,qty=1", id, now)
		return err
	}
	if n >= content.Rules.WildsLimits.ClaimsPerMinute {
		return fail(429, "claim-rate-limited")
	}
	_, err = tx.ExecContext(ctx, "UPDATE claim_rate SET qty=qty+1 WHERE account_id=?", id)
	return err
}

// entityChunk: the chunk an entity id names (`kind:cx:cy:index`), if inside
// the region's grid.
func entityChunk(id string, region content.WildsRegion) (cx, cy int, ok bool) {
	parts := strings.Split(id, ":")
	if len(parts) != 4 || len(id) > 128 {
		return 0, 0, false
	}
	cx, e1 := strconv.Atoi(parts[1])
	cy, e2 := strconv.Atoi(parts[2])
	if e1 != nil || e2 != nil || cx < 0 || cy < 0 || cx >= region.GridWidth || cy >= region.GridHeight {
		return 0, 0, false
	}
	return cx, cy, true
}

func lootProto(d wilds.LootDrop) *contract.WildsLoot {
	out := &contract.WildsLoot{}
	for _, m := range d.Materials {
		out.Materials = append(out.Materials, &contract.WildsMaterial{Id: m.ID, Qty: float64(m.Qty)})
	}
	if d.Trinket != nil {
		out.Trinket = wrapperspb.String(*d.Trinket)
	}
	return out
}

func materialsProto(ctx context.Context, tx *sql.Tx, account string) (map[string]float64, error) {
	m, err := materials(ctx, tx, account)
	out := map[string]float64{}
	for id, qty := range m {
		out[id] = float64(qty)
	}
	return out, err
}

// POST /api/wilds/claim: a camp, node, chest or point of interest of the
// epoch's stored chunks, at its projected cycle, from within reach.
func (a *Server) wildsClaim(w http.ResponseWriter, r *http.Request) error {
	req := &contract.WildsClaimRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		e, err := a.epochFor(ctx, tx, *s, req.Epoch, now)
		if err != nil {
			return nil, err
		}
		if !safeCounter(req.Cycle) || req.Cycle > math.MaxInt32 {
			return nil, fail(400, "invalid-claim")
		}
		cycle := int64(req.Cycle)
		region, _ := regionDefinition(e.RegionId)
		cx, cy, ok := entityChunk(req.EntityId, region)
		if !ok {
			return nil, fail(404, "entity-not-found")
		}
		m, err := a.Config.Chunks.Chunk(ctx, tx, s.WorldID, e.Id, 0, int32(cx), int32(cy))
		if err != nil {
			return nil, chunkError(err)
		}
		pe, err := chunks.Entity(m, req.EntityId)
		if err != nil {
			return nil, fail(404, "entity-not-found")
		}
		entity := wilds.EntityFromProto(pe)
		S := content.WildsRules.ChunkSize
		if err = nearWilds(*s, e.RegionId, cx*S+entity.TX, cy*S+entity.TY); err != nil {
			return nil, err
		}
		row, err := readEntityRow(ctx, tx, e.Id, entity.ID)
		if err != nil {
			return nil, err
		}
		row = row.projected(entity.Kind, now)
		if cycle != row.cycle {
			return nil, fail(409, "old-cycle")
		}
		by := sql.NullString{String: s.AccountID, Valid: true}
		at := sql.NullInt64{Int64: now, Valid: true}
		switch entity.Kind {
		case "camp", "node":
			if row.state != "available" {
				return nil, fail(409, "entity-unavailable")
			}
			row.state, row.availableAt = "cleared", now+int64(content.WildsRules.Timers.CampRespawnSeconds)
			if entity.Kind == "node" {
				row.state, row.availableAt = "harvested", now+int64(content.WildsRules.Timers.NodeRegrowSeconds)
			}
			row.by, row.at = by, at
		default:
			var n int
			if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM personal_claims WHERE epoch=? AND entity_id=? AND account_id=?", e.Id, entity.ID, s.AccountID).Scan(&n); err != nil {
				return nil, err
			}
			if n > 0 {
				return nil, fail(409, "already-claimed")
			}
			if _, err = tx.ExecContext(ctx, "INSERT INTO personal_claims VALUES(?,?,?,?)", e.Id, entity.ID, s.AccountID, now); err != nil {
				return nil, err
			}
			if entity.Kind == "poi" {
				if _, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO discoveries VALUES(?,?,?,?,?)", e.Id, entity.ID, entity.POI, s.AccountID, now); err != nil {
					return nil, err
				}
				row.state = "charted"
				if !row.by.Valid {
					row.by, row.at = by, at
				}
			}
		}
		if err = writeEntityRow(ctx, tx, e.Id, entity.ID, row); err != nil {
			return nil, err
		}
		if err = claimRate(ctx, tx, s.AccountID, now); err != nil {
			w.Header().Set("Retry-After", "60")
			return nil, err
		}
		loot, err := wilds.RollEntityLoot(generationOf(e), entity, int(cycle))
		if err != nil {
			return nil, err
		}
		if err = grantLoot(ctx, tx, s, loot, "wilds-claim", e.Id+":"+entity.ID, now); err != nil {
			return nil, err
		}
		sliver, err := maybeGrantWardenSliver(ctx, tx, s, e.RegionId, entity, cx, cy, now)
		if err != nil {
			return nil, err
		}
		storm, err := maybeGrantStormDrop(ctx, tx, s, e.RegionId, entity, cx, cy, now)
		if err != nil {
			return nil, err
		}
		papers, err := a.grantFound(ctx, tx, s, ports.PaperInput{Epoch: e.Id, Entity: entity.ID, Cycle: cycle, Where: proto.Clone(req.Where).(*contract.Where)}, []string{"wilds-poi", "wilds-chest"}, now)
		if err != nil {
			return nil, err
		}
		balances, err := materialsProto(ctx, tx, s.AccountID)
		if err != nil {
			return nil, err
		}
		return &contract.WildsClaimResult{Epoch: e.Id, Entity: row.view(e.Id, entity.ID), Loot: lootProto(loot), Materials: balances, WardenSliverFound: sliver, StormDropFound: storm, Papers: papers}, nil
	})
}

// ---------------------------------------------------------------- relight

// POST /api/wilds/lantern: relight a fallen hero's lantern, by its exact id.
// Relighting another's pays a little amber, a few times a day.
func (a *Server) wildsRelight(w http.ResponseWriter, r *http.Request) error {
	req := &contract.WildsLanternRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		e, err := a.epochFor(ctx, tx, *s, req.Epoch, now)
		if err != nil {
			return nil, err
		}
		if req.LanternId == "" || req.OwnerId == "" {
			return nil, fail(400, "lantern-id-required")
		}
		var lit sql.NullString
		var lx, ly int
		err = tx.QueryRowContext(ctx, "SELECT lit_by,x,y FROM lanterns WHERE epoch=? AND owner_id=? AND id=?", e.Id, req.OwnerId, req.LanternId).Scan(&lit, &lx, &ly)
		if err == sql.ErrNoRows {
			return nil, fail(404, "lantern-not-found")
		}
		if err != nil {
			return nil, err
		}
		if err = nearWilds(*s, e.RegionId, lx, ly); err != nil {
			return nil, err
		}
		if lit.Valid {
			return nil, fail(409, "already-lit")
		}
		loot := wilds.LootDrop{Materials: []wilds.MaterialQty{}}
		rewarded := false
		if req.OwnerId != s.AccountID {
			day := calendarDay(now)
			var n int
			err = tx.QueryRowContext(ctx, "SELECT qty FROM lantern_rewards WHERE account_id=? AND utc_day=?", s.AccountID, day).Scan(&n)
			if err != nil && err != sql.ErrNoRows {
				return nil, err
			}
			if n < content.Rules.WildsLimits.LanternRelightsPerDay {
				rewarded = true
				reward := content.Rules.WildsLimits.LanternReward
				loot.Materials = append(loot.Materials, wilds.MaterialQty{ID: reward.Material, Qty: reward.Qty})
				if _, err = tx.ExecContext(ctx, "INSERT INTO lantern_rewards VALUES(?,?,1) ON CONFLICT(account_id,utc_day) DO UPDATE SET qty=qty+1", s.AccountID, day); err != nil {
					return nil, err
				}
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE lanterns SET lit_by=?,lit_at=? WHERE id=?", s.AccountID, now, req.LanternId); err != nil {
			return nil, err
		}
		if err = grantLoot(ctx, tx, s, loot, "wilds-relight", req.LanternId, now); err != nil {
			return nil, err
		}
		balances, err := materialsProto(ctx, tx, s.AccountID)
		if err != nil {
			return nil, err
		}
		ls, err := lanterns(ctx, tx, e.Id)
		if err != nil {
			return nil, err
		}
		return &contract.WildsLanternResult{Epoch: e.Id, Rewarded: rewarded, Loot: lootProto(loot), Materials: balances, Lanterns: ls}, nil
	})
}

// ---------------------------------------------------------------- Echoes

// POST /api/wilds/echo: settle the Echo this player's assignment puts at a
// site of the epoch's stored chunks, from within reach. Writes
// `echo:<member>` and grants the member's paper where the rules say.
func (a *Server) settleEcho(w http.ResponseWriter, r *http.Request) error {
	req := &contract.SettleEchoRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	var witness func()
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		e, err := a.epochFor(ctx, tx, *s, req.Epoch, now)
		if err != nil {
			return nil, err
		}
		if req.Member == "" || !validPayloadID(req.Member) {
			return nil, fail(409, "echo-not-here")
		}
		all, err := a.regionChunks(ctx, tx, s.WorldID, e)
		if err != nil {
			return nil, chunkError(err)
		}
		var sites []ports.EchoSite
		var here *ports.EchoSite
		for _, m := range all {
			for _, site := range m.Sites {
				es := ports.EchoSite{Site: proto.Clone(site).(*contract.StorySite), CX: m.Cx, CY: m.Cy}
				sites = append(sites, es)
				if site.Id == req.Site && site.Kind == contract.SiteKind_SITE_KIND_ECHO {
					here = &es
				}
			}
		}
		S := content.WildsRules.ChunkSize
		if here == nil || nearWilds(*s, e.RegionId, int(here.CX)*S+int(here.Site.Tx), int(here.CY)*S+int(here.Site.Ty)) != nil {
			return nil, fail(409, "echo-not-here")
		}
		assigned, err := a.Config.Story.Echoes(ctx, tx, *s, ports.EchoInput{Epoch: proto.Clone(e).(*contract.WildsEpoch), Sites: sites})
		if err != nil {
			return nil, err
		}
		mark := "echo:" + req.Member
		ok := false
		for _, as := range assigned {
			if as.Site == req.Site && as.Member == req.Member && !as.Settled {
				ok = true
			}
		}
		if !ok || containsString(s.State.Flags, mark) {
			return nil, fail(409, "echo-not-here")
		}
		s.State.Flags = append(s.State.Flags, mark)
		papers, err := a.grantFound(ctx, tx, s, ports.PaperInput{Epoch: e.Id, Site: req.Site, Where: proto.Clone(req.Where).(*contract.Where)}, []string{"echo"}, now)
		if err != nil {
			return nil, err
		}
		out := &contract.SettleEchoResult{Epoch: e.Id, Site: req.Site, Member: req.Member}
		if len(papers) > 0 {
			out.Paper = papers[0]
		}
		witness = a.witnessed(*s, []string{"echo:" + req.Member})
		return out, nil
	}, func() {
		if witness != nil {
			witness()
		}
	})
}

func containsString(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// ---------------------------------------------------------------- fallen lanterns

// PlaceFallen puts the fallen hero's lantern where they fell, when that's a
// walkable tile of the epoch's region and today's cap allows (ports.Lanterns).
// It never creates an epoch and never bumps versions.
func (w wildsService) PlaceFallen(ctx context.Context, tx *sql.Tx, s *store.Snapshot, epoch *contract.WildsEpoch, where *contract.Where, now int64) (ports.FallLantern, error) {
	none := func(reason string) (ports.FallLantern, error) {
		return ports.FallLantern{Lantern: "none", Reason: reason}, nil
	}
	if where == nil || !strings.HasPrefix(where.Area, "wilds:") {
		return none("not-wilds")
	}
	region, ok := regionDefinition(strings.TrimPrefix(where.Area, "wilds:"))
	if !ok {
		return none("invalid-place")
	}
	if epoch == nil || epoch.Id == "" {
		return none("epoch-missing")
	}
	if epoch.RegionId != region.ID {
		return none("invalid-place")
	}
	S := content.WildsRules.ChunkSize
	if !finiteWhere(where) || where.X < 0 || where.Y < 0 {
		return none("invalid-place")
	}
	tx0, ty0 := int(where.X/wildsTileSize), int(where.Y/wildsTileSize)
	if tx0 >= region.GridWidth*S || ty0 >= region.GridHeight*S {
		return none("invalid-place")
	}
	m, err := w.a.Config.Chunks.Chunk(ctx, tx, s.WorldID, epoch.Id, 0, int32(tx0/S), int32(ty0/S))
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, chunks.ErrEpochEnded) {
		return none("epoch-missing")
	}
	if err != nil {
		return ports.FallLantern{}, err
	}
	if !wilds.Walkable(m, tx0%S, ty0%S) {
		return none("invalid-place")
	}
	day := calendarDay(now)
	var n int
	err = tx.QueryRowContext(ctx, "SELECT qty FROM lantern_creations WHERE account_id=? AND utc_day=?", s.AccountID, day).Scan(&n)
	if err != nil && err != sql.ErrNoRows {
		return ports.FallLantern{}, err
	}
	if n >= content.Rules.WildsLimits.LanternsCreatedPerDay {
		return none("daily-cap")
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO lantern_creations VALUES(?,?,1) ON CONFLICT(account_id,utc_day) DO UPDATE SET qty=qty+1", s.AccountID, day); err != nil {
		return ports.FallLantern{}, err
	}
	id, err := store.Random()
	if err != nil {
		return ports.FallLantern{}, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO lanterns(id,epoch,world_id,region_id,owner_id,x,y,at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(world_id,region_id,owner_id) DO UPDATE SET id=excluded.id,epoch=excluded.epoch,x=excluded.x,y=excluded.y,lit_by=NULL,lit_at=NULL,at=excluded.at`, id, epoch.Id, s.WorldID, region.ID, s.AccountID, tx0, ty0, now)
	if err != nil {
		return ports.FallLantern{}, err
	}
	return ports.FallLantern{Lantern: "placed", ID: id, Epoch: epoch.Id}, nil
}

// ---------------------------------------------------------------- loot and finds

func grantLoot(ctx context.Context, tx *sql.Tx, s *store.Snapshot, loot wilds.LootDrop, reason, ref string, now int64) error {
	// Even an empty deterministic roll has an auditable claim record.
	if err := store.Credit(ctx, tx, s, 0, 0, reason, ref, nil, now); err != nil {
		return err
	}
	for _, m := range loot.Materials {
		if err := materialChange(ctx, tx, s.AccountID, m.ID, m.Qty, reason, ref, now); err != nil {
			return err
		}
	}
	if loot.Trinket != nil {
		// A story keepsake is a single, real thing: the Wilds give a bound
		// keepsake to a player once, and never repeat it (the roll may name
		// it again, but nothing is granted). Unbound trinkets repeat.
		if def, ok := content.ItemFor(*loot.Trinket); ok && def.Kind == "keepsake" && def.Bound {
			first, err := store.Outcome(ctx, tx, s.AccountID, "story-keepsake:"+*loot.Trinket, reason, now)
			if err != nil {
				return err
			}
			if !first {
				return nil
			}
		}
		if err := packPut(ctx, tx, s.AccountID, *loot.Trinket, []makerQty{{Maker: "", Qty: 1}}, reason, ref, now); err != nil {
			return err
		}
		s.State.Inventory = appendUnique(s.State.Inventory, *loot.Trinket)
	}
	return nil
}
func appendUnique(values []string, v string) []string {
	for _, x := range values {
		if x == v {
			return values
		}
	}
	return append(values, v)
}

// calendarDay is the UTC date the daily lantern caps count by.
func calendarDay(now int64) string { return time.Unix(now, 0).UTC().Format("2006-01-02") }

func intAbs(n int) int {
	if n < 0 {
		return -n
	}
	return n
}

// The two Wilds regions (content/wilds.json): the Tangle, permanent, and
// the outer drift past its crossing (the Whitequiet).
const (
	tangleRegion     = "inner-1"
	whitequietRegion = "outer-1"
)

// deepCountry: where the rare finds turn up — the Whitequiet, or the
// Tangle at least DeepTangleManhattanDistance chunks from its entry.
func deepCountry(regionID string, cx, cy int) bool {
	if regionID == whitequietRegion {
		return true
	}
	r, ok := regionDefinition(regionID)
	if !ok {
		r.EntryX, r.EntryY = 1, 1
	}
	return regionID == tangleRegion && intAbs(cx-r.EntryX)+intAbs(cy-r.EntryY) >= content.WildsRules.DeepTangleManhattanDistance
}

// weeklyFind rolls one rare find on a deep-country claim: a thin chance (a
// chest's more likely), seeded per player, entity, week and chunk so a
// replay rolls the same, and at most one a week per player, the finds
// spaced in their own table. A landed roll is recorded there; the caller
// grants the find.
func weeklyFind(ctx context.Context, tx *sql.Tx, player, table, salt string, entity wilds.Entity, cx, cy int, now int64) (bool, error) {
	var count int
	err := tx.QueryRowContext(ctx, "SELECT count(*) FROM "+table+" WHERE account_id=? AND found_at>?", player, now-7*86400).Scan(&count)
	if err != nil || count > 0 {
		return false, err
	}
	chance := uint32(2)
	if entity.Kind == "chest" {
		chance = 5
	}
	week := now / (7 * 86400)
	if wilds.Hash(player, entity.ID, int(week), salt, cx, cy)%1000 >= chance {
		return false, nil
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO "+table+"(account_id, found_at) VALUES(?,?)", player, now)
	return err == nil, err
}

func maybeGrantWardenSliver(ctx context.Context, tx *sql.Tx, s *store.Snapshot, regionID string, entity wilds.Entity, cx, cy int, now int64) (bool, error) {
	if !deepCountry(regionID, cx, cy) {
		return false, nil
	}
	found, err := weeklyFind(ctx, tx, s.AccountID, "warden_finds", "warden-sliver", entity, cx, cy, now)
	if err != nil || !found {
		return false, err
	}
	sliverDef, ok := content.ItemFor("warden-sliver")
	if !ok {
		return false, nil
	}
	if _, err = newInstance(ctx, tx, sliverDef, instanceAt{"pack", s.AccountID}, "", sliverDef.MaxPoints(), now); err != nil {
		return false, err
	}
	if err = currency(ctx, tx, s.AccountID, content.StackCurrency("warden-sliver"), 1, "wilds-find", entity.ID, now); err != nil {
		return false, err
	}
	return true, nil
}

// maybeGrantStormDrop: storm-grade amber, the rarest kind, found the way
// the warden-stone slivers are — out deep (the deep Tangle, the
// Whitequiet), a thin chance on each claim (a chest's more likely), and at
// most one a week per player, the finds spaced in storm_finds
// (docs/items/crafting-and-repair.md, "Warden-stone"; the catalogue,
// "Storm-grade drop"). The same deep country keeps both finds.
func maybeGrantStormDrop(ctx context.Context, tx *sql.Tx, s *store.Snapshot, regionID string, entity wilds.Entity, cx, cy int, now int64) (bool, error) {
	if !deepCountry(regionID, cx, cy) {
		return false, nil
	}
	found, err := weeklyFind(ctx, tx, s.AccountID, "storm_finds", "storm-drop", entity, cx, cy, now)
	if err != nil || !found {
		return false, err
	}
	if err = packPut(ctx, tx, s.AccountID, "storm-grade-drop", []makerQty{{Maker: "", Qty: 1}}, "wilds-find", entity.ID, now); err != nil {
		return false, err
	}
	return true, refreshItems(ctx, tx, s)
}
