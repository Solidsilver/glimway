package api

// The Wilds from the server (server-first.md 3, open-map.md 2.3, 2.4): a
// world's still and wick epochs, and their chunks, each made the first time
// it is read and stored (store/chunks.go). Afterwards everything reads the
// stored chunks: the chunk route serves them, the near read lists the
// changing state around a chunk, and claims, relights and Echo settlements
// check entities and sites against them.

import (
	"context"
	"database/sql"
	"errors"
	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/ports"
	"glimway/server/internal/store"
	"glimway/server/internal/story"
	"glimway/server/internal/wilds"
	"glimway/server/internal/wildsgen"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"

	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/wrapperspb"
)

// outdoorsArea is the `where` area of the open map: one area, world pixels.
const outdoorsArea = string(location.Outdoors)

// generationOf is a stored epoch's generation parameters (loot seeds).
func generationOf(e *contract.WildsEpoch) wilds.Epoch { return wildsgen.Epoch(e) }

// rollClaimLoot is an entity's loot for a cycle; a node yields its chunk's
// tier's nodeYieldBonus more of each material it gives (open-map.md 2.1).
func rollClaimLoot(e *contract.WildsEpoch, entity wilds.Entity, chunkTier uint32, cycle int) (wilds.LootDrop, error) {
	loot, err := wilds.RollEntityLoot(generationOf(e), entity, cycle)
	if err != nil || entity.Kind != "node" || chunkTier < 1 || int(chunkTier) > len(content.WildsRules.Tiers) {
		return loot, err
	}
	bonus := int(content.WildsRules.Tiers[chunkTier-1].GetNodeYieldBonus())
	for i := range loot.Materials {
		loot.Materials[i].Qty += bonus
	}
	return loot, nil
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
// generator version this server makes, not ended. held: an epoch a hold
// pins passes too, for what stands in a held chunk (a claim, a relight, a
// discovery); each caller checks the thing is in a chunk held under it (the
// chunk read refuses the pinned epoch's other chunks).
func (a *Server) epochFor(ctx context.Context, tx *sql.Tx, s store.Snapshot, id string, now int64, held bool) (*contract.WildsEpoch, error) {
	var world string
	var starts int64
	var ends sql.NullInt64
	e := &contract.WildsEpoch{}
	err := tx.QueryRowContext(ctx, "SELECT id,world_id,world_seed,kind,generator_version,season,starts_at,ends_at FROM wild_epochs WHERE id=?", id).Scan(&e.Id, &world, &e.WorldSeed, &e.Kind, &e.GeneratorVersion, &e.Season, &starts, &ends)
	if err == sql.ErrNoRows {
		return nil, fail(404, "epoch-not-found")
	}
	if err != nil {
		return nil, err
	}
	if world != s.WorldID {
		return nil, fail(403, "world-access-denied")
	}
	pinned := false
	if held {
		if pinned, err = store.Pins(ctx, tx, world, id); err != nil {
			return nil, err
		}
	}
	if g := a.Config.WildsGenerator; g != nil && int(e.GeneratorVersion) != g.Version() && !pinned {
		return nil, fail(503, "generator-unavailable")
	}
	e.StartsAt = float64(starts)
	if ends.Valid {
		e.EndsAt = wrapperspb.Double(float64(ends.Int64))
		if ends.Int64 <= now && !pinned {
			return nil, fail(409, "epoch-ended")
		}
	}
	return e, nil
}

// epochAt is the current epoch a chunk lies in (made when there is none):
// a held chunk's pinned epoch, else its kind's current one.
func (a *Server) epochAt(ctx context.Context, tx *sql.Tx, world string, cx, cy int, now int64) (*contract.WildsEpoch, error) {
	served, _, err := a.epochsAt(ctx, tx, world, cx, cy, now)
	return served, err
}

// epochsAt is epochAt with the chunk's kind's current epoch too: they differ
// for a held chunk, whose pinned epoch may have ended while what is served
// there lasts until the current epoch's turning (where holds are judged).
func (a *Server) epochsAt(ctx context.Context, tx *sql.Tx, world string, cx, cy int, now int64) (served, current *contract.WildsEpoch, err error) {
	if a.Config.Epochs == nil {
		return nil, nil, store.ErrGeneratorUnavailable
	}
	current, err = chunks.Epoch(ctx, tx, a.Config.Epochs, world, wilds.EpochKindAt(cx, cy), now)
	if err != nil {
		return nil, nil, err
	}
	// After the current epoch: reading it is the turning, which judges holds.
	held, err := store.HeldEpoch(ctx, tx, world, cx, cy)
	if err != nil || held != nil {
		return held, current, err
	}
	return current, current, nil
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

// wildsService is D's implementation of the lantern and land ports. It
// reads the server's other ports (chunks, epochs, story) at call time, so a
// test can swap them.
type wildsService struct{ a *Server }

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

// GET /api/wilds/chunk/<epochId>/<layer>/<cx>/<cy>: the stored chunk as
// binary protobuf, made on its first read. Immutable, so the browser may
// keep it for good; it is only ever asked for under an epoch a fresh near
// read named, and only within sight of the reader (sight.go).
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
	// Only land round the reader (sight.go).
	if ok, err := chunkInSight(r.Context(), tx, s, int(n[1]), int(n[2])); err != nil {
		return err
	} else if !ok {
		return fail(409, "beyond-sight")
	}
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
// lanterns and these checks use world tiles; `where` is world pixels.
const wildsTileSize = 16
const wildsInteractionRadius = 3

// wildsTileOf is the world tile under a world-pixel position (finite: the
// request boundary checked it).
func wildsTileOf(x, y float64) (int, int) { return wilds.TileOfPixel(x, y) }

// nearWithin: the player stands in the Wilds, inside the border, within r
// tiles of the world tile (x, y).
func nearWithin(s store.Snapshot, x, y, r int) error {
	if !generatedPlace(s.State.Area, s.State.Position.X, s.State.Position.Y) {
		return fail(409, "not-in-wilds")
	}
	px, py := wildsTileOf(s.State.Position.X, s.State.Position.Y)
	if location.SourceOf(wilds.ChunkOf(x, y)).Kind != location.SourceGenerated {
		return fail(409, "not-in-wilds")
	}
	if !wilds.InsideBorder(wilds.FloorDiv(px, chunkSize()), wilds.FloorDiv(py, chunkSize())) {
		return fail(409, "beyond-border")
	}
	dx, dy := px-x, py-y
	if dx*dx+dy*dy > r*r {
		return fail(409, "too-far-away")
	}
	return nil
}

// nearWilds: within interaction reach of the world tile (x, y).
func nearWilds(s store.Snapshot, x, y int) error { return nearWithin(s, x, y, wildsInteractionRadius) }

func chunkSize() int { return int(content.WildsRules.GetChunkSize()) }

// ---------------------------------------------------------------- papers

// wildsPaperSources: the papers whose find the Wilds operations offer to the
// story rules, by source kind (content/papers.json). The story rules
// decide; these handlers only ask about the right candidates.
var wildsPaperSources = func() map[string][]string {
	out := map[string][]string{}
	for _, p := range content.PaperCatalog {
		out[p.GetSource()] = append(out[p.GetSource()], p.GetId())
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
	if n >= int(content.Rules.GetWildsLimits().GetClaimsPerMinute()) {
		return fail(429, "claim-rate-limited")
	}
	_, err = tx.ExecContext(ctx, "UPDATE claim_rate SET qty=qty+1 WHERE account_id=?", id)
	return err
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
// epoch's stored chunks, at its projected cycle, from within reach; or this
// wick's rumour find (entity id "rumour:<cx>:<cy>", open-map.md 2.10), a
// personal claim like a chest's.
func (a *Server) wildsClaim(w http.ResponseWriter, r *http.Request) error {
	req := &contract.WildsClaimRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	// A camp that fell a moment ago may still be in the fall writer's queue:
	// wait for it, bounded, before the claim's transaction reads the store.
	if a.falls != nil && strings.HasPrefix(req.EntityId, "camp:") && safeCounter(req.Cycle) {
		a.falls.await(r.Context(), req.Epoch, req.EntityId, int64(req.Cycle), fallClaimWait)
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		e, err := a.epochFor(ctx, tx, *s, req.Epoch, now, true)
		if err != nil {
			return nil, err
		}
		if !safeCounter(req.Cycle) || req.Cycle > math.MaxInt32 {
			return nil, fail(400, "invalid-claim")
		}
		cycle := int64(req.Cycle)
		if strings.HasPrefix(req.EntityId, "rumour:") {
			return a.openRumour(ctx, tx, s, e, req, now)
		}
		cx, cy, ok := story.EntityChunk(s.WorldID, req.EntityId)
		if !ok || wilds.EpochKindAt(cx, cy) != e.Kind {
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
		S := chunkSize()
		if err = nearWilds(*s, cx*S+entity.TX, cy*S+entity.TY); err != nil {
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
		ref := e.Id + ":" + entity.ID
		switch entity.Kind {
		case "camp":
			// The completion seam: eligible to finish, then settled once.
			if err = campEligible(ctx, tx, store.FallKey{World: s.WorldID, Realm: m.Realm, Layer: m.Layer, CX: m.Cx, CY: m.Cy, Epoch: e.Id, Entity: entity.ID, Cycle: cycle}, s.AccountID); err != nil {
				return nil, err
			}
			if err = store.InsertCampClaim(ctx, tx, e.Id, entity.ID, cycle, s.AccountID, now); err != nil {
				return nil, err
			}
			ref += ":" + strconv.FormatInt(cycle, 10)
		case "node":
			if row.state != "available" {
				return nil, fail(409, "entity-unavailable")
			}
			row.state, row.availableAt = "harvested", now+int64(content.WildsRules.Timers.NodeRegrowSeconds)
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
		// A camp's row is its fall's (fall_writer.go); a claim never moves it.
		if entity.Kind != "camp" {
			if err = writeEntityRow(ctx, tx, e.Id, entity.ID, row); err != nil {
				return nil, err
			}
		}
		if err = claimRate(ctx, tx, s.AccountID, now); err != nil {
			w.Header().Set("Retry-After", "60")
			return nil, err
		}
		loot, err := rollClaimLoot(e, entity, m.Tier, int(cycle))
		if err != nil {
			return nil, err
		}
		if err = grantLoot(ctx, tx, s, loot, "wilds-claim", ref, now); err != nil {
			return nil, err
		}
		sliver, err := maybeGrantWardenSliver(ctx, tx, s, entity, cx, cy, now)
		if err != nil {
			return nil, err
		}
		storm, err := maybeGrantStormDrop(ctx, tx, s, entity, cx, cy, now)
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

// campEligible: may this account finish this camp's cycle (shared-fights.md
// 1.9)? The cycle must have a stored fall, the account must be among its
// witnesses (no damage needed), and must not have claimed it yet. The
// camp's availability is never read as proof that it fell.
func campEligible(ctx context.Context, tx *sql.Tx, k store.FallKey, account string) error {
	fall, ok, err := store.ReadFall(ctx, tx, k)
	if err != nil {
		return err
	}
	if !ok {
		return fail(409, "not-defeated")
	}
	if !fall.Witnessed(account) {
		return fail(409, "condition-unmet")
	}
	claimed, err := store.CampClaimed(ctx, tx, k.Epoch, k.Entity, k.Cycle, account)
	if err != nil {
		return err
	}
	if claimed {
		return fail(409, "already-claimed")
	}
	return nil
}

// campStanding is a reader's camps across the near read's two epochs: the
// fallen cycles they witnessed, and the cycles they claimed (Unix seconds).
type campStanding struct {
	witnessed map[fallID]bool
	claimed   map[fallID]int64
}

func readCampStanding(ctx context.Context, tx *sql.Tx, account string, epochs ...any) (campStanding, error) {
	out := campStanding{witnessed: map[fallID]bool{}, claimed: map[fallID]int64{}}
	marks := strings.TrimSuffix(strings.Repeat("?,", len(epochs)), ",")
	args := append([]any{account}, epochs...)
	rows, err := tx.QueryContext(ctx, "SELECT epoch,entity_id,cycle FROM fight_fall_witnesses WHERE account_id=? AND epoch IN ("+marks+")", args...)
	if err != nil {
		return out, err
	}
	for rows.Next() {
		var id fallID
		if err = rows.Scan(&id.epoch, &id.entity, &id.cycle); err != nil {
			rows.Close()
			return out, err
		}
		out.witnessed[id] = true
	}
	if err = closeRows(rows); err != nil {
		return out, err
	}
	if rows, err = tx.QueryContext(ctx, "SELECT epoch,entity_id,cycle,at FROM camp_claims WHERE account_id=? AND epoch IN ("+marks+")", args...); err != nil {
		return out, err
	}
	for rows.Next() {
		var id fallID
		var at int64
		if err = rows.Scan(&id.epoch, &id.entity, &id.cycle, &at); err != nil {
			rows.Close()
			return out, err
		}
		out.claimed[id] = at
	}
	return out, closeRows(rows)
}

// claimable: the reader may claim this camp's projected cycle. Cleared in
// its cycle means that cycle fell (the fall wrote the row); the reader must
// be among the stored witnesses and not have claimed it. A row a 0.8 claim
// cleared has no witnesses, so it is never claimable.
func (c campStanding) claimable(v *contract.WildsEntityState) bool {
	id := fallID{v.Epoch, v.Id, int64(v.Cycle)}
	_, claimed := c.claimed[id]
	return v.State == "cleared" && c.witnessed[id] && !claimed
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
		e, err := a.epochFor(ctx, tx, *s, req.Epoch, now, true)
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
		if err = nearWilds(*s, lx, ly); err != nil {
			return nil, err
		}
		// An ended (pinned) epoch's lantern only where a hold keeps its land.
		if e.EndsAt != nil && int64(e.EndsAt.Value) <= now {
			S := chunkSize()
			held, err := store.HeldEpoch(ctx, tx, s.WorldID, wilds.FloorDiv(lx, S), wilds.FloorDiv(ly, S))
			if err != nil {
				return nil, err
			}
			if held == nil || held.Id != e.Id {
				return nil, fail(409, "epoch-ended")
			}
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
			if n < int(content.Rules.GetWildsLimits().GetLanternRelightsPerDay()) {
				rewarded = true
				reward := content.Rules.GetWildsLimits().GetLanternReward()
				loot.Materials = append(loot.Materials, wilds.MaterialQty{ID: reward.Material, Qty: int(reward.GetQty())})
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
		e, err := a.epochFor(ctx, tx, *s, req.Epoch, now, false)
		if err != nil {
			return nil, err
		}
		if req.Member == "" || !validPayloadID(req.Member) {
			return nil, fail(409, "echo-not-here")
		}
		sites, err := story.FootprintSites(ctx, tx, a.Config.Chunks, s.WorldID, e, story.EchoFootprint)
		if err != nil {
			return nil, chunkError(err)
		}
		var here *ports.EchoSite
		for i, site := range sites {
			if site.Site.Id == req.Site && site.Site.Kind == contract.SiteKind_SITE_KIND_ECHO {
				here = &sites[i]
			}
		}
		S := chunkSize()
		if here == nil || nearWilds(*s, int(here.CX)*S+int(here.Site.Tx), int(here.CY)*S+int(here.Site.Ty)) != nil {
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
// walkable tile (ground changes applied) of a stored chunk in the epoch and
// today's cap allows (ports.Lanterns). It never creates an epoch or a chunk
// and never bumps versions.
func (w wildsService) PlaceFallen(ctx context.Context, tx *sql.Tx, s *store.Snapshot, epoch *contract.WildsEpoch, where *contract.Where, now int64) (ports.FallLantern, error) {
	none := func(reason string) (ports.FallLantern, error) {
		return ports.FallLantern{Lantern: "none", Reason: reason}, nil
	}
	if where == nil || !generatedPlace(where.Area, where.X, where.Y) {
		return none("not-wilds")
	}
	if epoch == nil || epoch.Id == "" {
		return none("epoch-missing")
	}
	if !finiteWhere(where) {
		return none("invalid-place")
	}
	S := chunkSize()
	tx0, ty0 := wildsTileOf(where.X, where.Y)
	cx, cy := wilds.FloorDiv(tx0, S), wilds.FloorDiv(ty0, S)
	if !wilds.InsideBorder(cx, cy) || wilds.EpochKindAt(cx, cy) != epoch.Kind {
		return none("invalid-place")
	}
	var stored int
	if err := tx.QueryRowContext(ctx, "SELECT count(*) FROM wilds_chunks WHERE epoch_id=? AND layer=0 AND cx=? AND cy=?", epoch.Id, cx, cy).Scan(&stored); err != nil {
		return ports.FallLantern{}, err
	}
	if stored == 0 {
		return none("epoch-missing")
	}
	m, err := w.a.Config.Chunks.Chunk(ctx, tx, s.WorldID, epoch.Id, 0, int32(cx), int32(cy))
	if errors.Is(err, sql.ErrNoRows) || errors.Is(err, chunks.ErrEpochEnded) {
		return none("epoch-missing")
	}
	if err != nil {
		return ports.FallLantern{}, err
	}
	changes, err := groundChanges(ctx, tx, s.WorldID, epoch, cx, cy, now)
	if err != nil {
		return ports.FallLantern{}, err
	}
	if !chunks.NewEffective(m, changes).Walkable(tx0-cx*S, ty0-cy*S) {
		return none("invalid-place")
	}
	day := calendarDay(now)
	var n int
	err = tx.QueryRowContext(ctx, "SELECT qty FROM lantern_creations WHERE account_id=? AND utc_day=?", s.AccountID, day).Scan(&n)
	if err != nil && err != sql.ErrNoRows {
		return ports.FallLantern{}, err
	}
	if n >= int(content.Rules.GetWildsLimits().GetLanternsCreatedPerDay()) {
		return none("daily-cap")
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO lantern_creations VALUES(?,?,1) ON CONFLICT(account_id,utc_day) DO UPDATE SET qty=qty+1", s.AccountID, day); err != nil {
		return ports.FallLantern{}, err
	}
	id, err := store.Random()
	if err != nil {
		return ports.FallLantern{}, err
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO lanterns(id,epoch,world_id,owner_id,x,y,at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(world_id,owner_id) DO UPDATE SET id=excluded.id,epoch=excluded.epoch,x=excluded.x,y=excluded.y,lit_by=NULL,lit_at=NULL,at=excluded.at`, id, epoch.Id, s.WorldID, s.AccountID, tx0, ty0, now)
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
		if def, ok := content.ItemFor(*loot.Trinket); ok && def.GetKind() == "keepsake" && def.GetBound() {
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

// deepCountry: where the rare finds turn up — tier 2 and past (the
// Whitequiet and the Beyond), or the Tangle at least
// DeepTangleManhattanDistance chunks from its middle chunk.
func deepCountry(cx, cy int) bool {
	if wilds.Tier(cx, cy) >= 2 {
		return true
	}
	t := wilds.Footprint("tangle")
	if t == nil || wilds.FootprintAt(cx, cy) != t {
		return false
	}
	mx, my := int(t.GetCx()+t.GetWidth()/2), int(t.GetCy()+t.GetHeight()/2)
	return intAbs(cx-mx)+intAbs(cy-my) >= int(content.WildsRules.GetDeepTangleManhattanDistance())
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

func maybeGrantWardenSliver(ctx context.Context, tx *sql.Tx, s *store.Snapshot, entity wilds.Entity, cx, cy int, now int64) (bool, error) {
	if !deepCountry(cx, cy) {
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
	if _, err = newInstance(ctx, tx, sliverDef, instanceAt{"pack", s.AccountID}, "", content.ItemMaxPoints(sliverDef), now); err != nil {
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
func maybeGrantStormDrop(ctx context.Context, tx *sql.Tx, s *store.Snapshot, entity wilds.Entity, cx, cy int, now int64) (bool, error) {
	if !deepCountry(cx, cy) {
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
