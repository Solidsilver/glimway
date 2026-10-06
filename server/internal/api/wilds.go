package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/store"
	"fingersnap/server/internal/wilds"
	"math"
	"net/http"
	"strconv"
	"strings"
	"time"
)

type regionEpoch struct {
	wilds.Epoch
	ID       string `json:"id"`
	StartsAt int64  `json:"startsAt"`
	EndsAt   *int64 `json:"endsAt"`
}

func regionDefinition(id string) (content.WildsRegion, bool) {
	for _, r := range content.WildsRules.Regions {
		if r.ID == id {
			return r, true
		}
	}
	return content.WildsRegion{}, false
}
func scanEpoch(ctx context.Context, tx *sql.Tx, query string, args ...any) (regionEpoch, string, error) {
	var e regionEpoch
	var world string
	err := tx.QueryRowContext(ctx, query, args...).Scan(&e.ID, &world, &e.RegionID, &e.WorldSeed, &e.GeneratorVersion, &e.Season, &e.StartsAt, &e.EndsAt)
	return e, world, err
}

const epochColumns = "id,world_id,region_id,world_seed,generator_version,season,starts_at,ends_at"

func (a *Server) ensureEpoch(ctx context.Context, tx *sql.Tx, s store.Snapshot, id string, now int64) (regionEpoch, error) {
	r, ok := regionDefinition(id)
	if !ok {
		return regionEpoch{}, fail(404, "region-not-found")
	}
	season := "0"
	day := content.CalendarAt(content.CalendarRules, now)
	if r.Kind == "outer" {
		// Both boundaries matter: changing wickDays can keep a start while
		// extending its end. The prefix also avoids collisions with old numbers.
		season = "t:" + strconv.FormatInt(day.StartsAt, 10) + ":" + strconv.FormatInt(day.NextTurning, 10)
	}
	e, _, err := scanEpoch(ctx, tx, "SELECT "+epochColumns+" FROM region_epochs WHERE world_id=? AND region_id=? AND season=?", s.WorldID, id, season)
	if err == sql.ErrNoRows && r.Kind == "outer" {
		// Preserve an existing numeric-season epoch for this exact interval.
		// Rewriting its frozen season would change generator input and loot IDs.
		e, _, err = scanEpoch(ctx, tx, "SELECT "+epochColumns+" FROM region_epochs WHERE world_id=? AND region_id=? AND starts_at=? AND ends_at=? ORDER BY id LIMIT 1", s.WorldID, id, day.StartsAt, day.NextTurning)
	}
	if err == sql.ErrNoRows {
		v := a.Config.WildsGeneratorVersion
		if v == 0 {
			v = content.WildsRules.GeneratorVersion
		}
		if v != 1 {
			return e, fail(503, "generator-unavailable")
		}
		e.ID, err = store.Random()
		if err != nil {
			return e, err
		}
		e.RegionID = id
		e.GeneratorVersion = v
		e.Season = season
		e.StartsAt = now
		if r.Kind == "outer" {
			e.StartsAt = day.StartsAt
			end := day.NextTurning
			e.EndsAt = &end
		}
		if err = tx.QueryRowContext(ctx, "SELECT seed FROM worlds WHERE id=?", s.WorldID).Scan(&e.WorldSeed); err != nil {
			return e, err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO region_epochs VALUES(?,?,?,?,?,?,?,?)", e.ID, s.WorldID, id, e.WorldSeed, v, e.Season, e.StartsAt, e.EndsAt)
	}
	if err != nil {
		return e, err
	}
	if e.EndsAt != nil && *e.EndsAt <= now {
		return e, fail(409, "epoch-ended")
	}
	return e, nil
}
func epochFor(ctx context.Context, tx *sql.Tx, s store.Snapshot, id string, now int64) (regionEpoch, error) {
	e, world, err := scanEpoch(ctx, tx, "SELECT "+epochColumns+" FROM region_epochs WHERE id=?", id)
	if err == sql.ErrNoRows {
		return e, fail(404, "epoch-not-found")
	}
	if err != nil {
		return e, err
	}
	if world != s.WorldID {
		return e, fail(403, "world-access-denied")
	}
	if e.EndsAt != nil && *e.EndsAt <= now {
		return e, fail(409, "epoch-ended")
	}
	return e, nil
}

// Dispatch using the epoch's frozen version, never the server's current one.
func epochEntities(e regionEpoch) ([]wilds.Entity, error) {
	if e.GeneratorVersion != 1 {
		return nil, fail(503, "generator-unavailable")
	}
	r, ok := regionDefinition(e.RegionID)
	if !ok {
		return nil, fail(404, "region-not-found")
	}
	out := []wilds.Entity{}
	for cy := 0; cy < r.GridHeight; cy++ {
		for cx := 0; cx < r.GridWidth; cx++ {
			items, err := wilds.ChunkEntities(e.Epoch, cx, cy)
			if err != nil {
				return nil, err
			}
			out = append(out, items...)
		}
	}
	return out, nil
}

type entityView struct {
	wilds.Entity
	Cycle       int     `json:"cycle"`
	State       string  `json:"state"`
	AvailableAt int64   `json:"available_at"`
	By          *string `json:"by"`
	At          *int64  `json:"at"`
}

func entityStatus(ctx context.Context, tx *sql.Tx, e regionEpoch, entity wilds.Entity, now int64) (entityView, error) {
	v := entityView{Entity: entity}
	if _, err := tx.ExecContext(ctx, "INSERT OR IGNORE INTO entity_state(epoch,entity_id) VALUES(?,?)", e.ID, entity.ID); err != nil {
		return v, err
	}
	// Exactly one new cycle becomes available, even after a long absence.
	if entity.Kind == "camp" || entity.Kind == "node" {
		if _, err := tx.ExecContext(ctx, "UPDATE entity_state SET cycle=cycle+1,state='available',available_at=0,by_id=NULL,at=NULL WHERE epoch=? AND entity_id=? AND state!='available' AND available_at<=?", e.ID, entity.ID, now); err != nil {
			return v, err
		}
	}
	err := tx.QueryRowContext(ctx, "SELECT cycle,state,available_at,by_id,at FROM entity_state WHERE epoch=? AND entity_id=?", e.ID, entity.ID).Scan(&v.Cycle, &v.State, &v.AvailableAt, &v.By, &v.At)
	return v, err
}

type personalClaim struct {
	EntityID string `json:"entityId"`
	At       int64  `json:"at"`
}
type discovery struct {
	EntityID     string `json:"entityId"`
	POIID        string `json:"poiId"`
	DiscovererID string `json:"discovererId"`
	DisplayName  string `json:"displayName"`
	At           int64  `json:"at"`
}
type lanternView struct {
	ID          string  `json:"id"`
	OwnerID     string  `json:"ownerId"`
	DisplayName string  `json:"displayName"`
	X           int     `json:"x"`
	Y           int     `json:"y"`
	LitBy       *string `json:"litBy"`
	At          int64   `json:"at"`
	LitAt       *int64  `json:"litAt"`
}

func lanterns(ctx context.Context, tx *sql.Tx, epoch string) ([]lanternView, error) {
	out := []lanternView{}
	rows, err := tx.QueryContext(ctx, "SELECT l.id,l.owner_id,p.display_name,l.x,l.y,l.lit_by,l.at,l.lit_at FROM lanterns l JOIN players p ON p.habitica_id=l.owner_id WHERE l.epoch=? ORDER BY l.owner_id", epoch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var v lanternView
		if err = rows.Scan(&v.ID, &v.OwnerID, &v.DisplayName, &v.X, &v.Y, &v.LitBy, &v.At, &v.LitAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (a *Server) regionRead(w http.ResponseWriter, r *http.Request) error {
	id := strings.TrimPrefix(r.URL.Path, "/api/wilds/region/")
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now().Unix()
	if s.SaveOrigin == nil {
		return fail(409, "origin-required")
	}
	e, err := a.ensureEpoch(ctx, tx, s, id, now)
	if err != nil {
		return err
	}
	entities, err := epochEntities(e)
	if err != nil {
		return err
	}
	states := []entityView{}
	for _, entity := range entities {
		v, err := entityStatus(ctx, tx, e, entity, now)
		if err != nil {
			return err
		}
		states = append(states, v)
	}
	claims := []personalClaim{}
	rows, err := tx.QueryContext(ctx, "SELECT entity_id,at FROM personal_claims WHERE epoch=? AND habitica_id=? ORDER BY entity_id", e.ID, s.HabiticaID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var v personalClaim
		if err = rows.Scan(&v.EntityID, &v.At); err != nil {
			rows.Close()
			return err
		}
		claims = append(claims, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	discoveries := []discovery{}
	rows, err = tx.QueryContext(ctx, "SELECT d.entity_id,d.poi_id,d.discoverer_id,p.display_name,d.at FROM discoveries d JOIN players p ON p.habitica_id=d.discoverer_id WHERE d.epoch=? ORDER BY d.entity_id", e.ID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var v discovery
		if err = rows.Scan(&v.EntityID, &v.POIID, &v.DiscovererID, &v.DisplayName, &v.At); err != nil {
			rows.Close()
			return err
		}
		discoveries = append(discoveries, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	ls, err := lanterns(ctx, tx, e.ID)
	if err != nil {
		return err
	}
	m, err := materials(ctx, tx, s.HabiticaID)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Epoch          regionEpoch     `json:"epoch"`
		Entities       []entityView    `json:"entities"`
		PersonalClaims []personalClaim `json:"personalClaims"`
		Discoveries    []discovery     `json:"discoveries"`
		Lanterns       []lanternView   `json:"lanterns"`
		Materials      map[string]int  `json:"materials"`
	}{s, e, states, claims, discoveries, ls, m})
}

type wildsRequest struct {
	Mutation
	Key       string          `json:"key"`
	Progress  json.RawMessage `json:"progress,omitempty"`
	Epoch     string          `json:"epoch"`
	EntityID  string          `json:"entityId,omitempty"`
	Cycle     *int            `json:"cycle,omitempty"`
	OwnerID   string          `json:"ownerId,omitempty"`
	LanternID string          `json:"lanternId,omitempty"`
	X         *int            `json:"x,omitempty"`
	Y         *int            `json:"y,omitempty"`
}

func claimRate(ctx context.Context, tx *sql.Tx, id string, now int64) error {
	var at int64
	var n int
	err := tx.QueryRowContext(ctx, "SELECT window_at,qty FROM claim_rate WHERE habitica_id=?", id).Scan(&at, &n)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	if err == sql.ErrNoRows || now-at >= 60 {
		_, err = tx.ExecContext(ctx, "INSERT INTO claim_rate VALUES(?,?,1) ON CONFLICT(habitica_id) DO UPDATE SET window_at=excluded.window_at,qty=1", id, now)
		return err
	}
	if n >= content.Rules.WildsLimits.ClaimsPerMinute {
		return fail(429, "claim-rate-limited")
	}
	_, err = tx.ExecContext(ctx, "UPDATE claim_rate SET qty=qty+1 WHERE habitica_id=?", id)
	return err
}
func (a *Server) wildsMutation(w http.ResponseWriter, r *http.Request) error {
	var req wildsRequest
	if err := decode(w, r, &req); err != nil {
		return err
	}
	return a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		e, err := epochFor(ctx, tx, *s, req.Epoch, now)
		if err != nil {
			return nil, err
		}
		switch r.URL.Path {
		case "/api/wilds/claim":
			if req.Cycle == nil || *req.Cycle < 0 || *req.Cycle > 2147483647 || len(req.EntityID) > 128 {
				return nil, fail(400, "invalid-claim")
			}
			entities, err := epochEntities(e)
			if err != nil {
				return nil, err
			}
			var entity wilds.Entity
			found := false
			for _, v := range entities {
				if v.ID == req.EntityID {
					entity = v
					found = true
					break
				}
			}
			if !found {
				return nil, fail(404, "entity-not-found")
			}
			parts := strings.Split(entity.ID, ":")
			cx, _ := strconv.Atoi(parts[1])
			cy, _ := strconv.Atoi(parts[2])
			if err := nearWilds(*s, e, cx*content.WildsRules.ChunkSize+entity.TX, cy*content.WildsRules.ChunkSize+entity.TY); err != nil {
				return nil, err
			}
			state, err := entityStatus(ctx, tx, e, entity, now)
			if err != nil {
				return nil, err
			}
			if *req.Cycle != state.Cycle {
				return nil, fail(409, "old-cycle")
			}
			if entity.Kind == "camp" || entity.Kind == "node" {
				if state.State != "available" {
					return nil, fail(409, "entity-unavailable")
				}
				state.State = "cleared"
				timer := content.WildsRules.Timers.CampRespawnSeconds
				if entity.Kind == "node" {
					state.State = "harvested"
					timer = content.WildsRules.Timers.NodeRegrowSeconds
				}
				state.AvailableAt = now + int64(timer)
				by := s.HabiticaID
				state.By = &by
				state.At = &now
				_, err = tx.ExecContext(ctx, "UPDATE entity_state SET state=?,available_at=?,by_id=?,at=? WHERE epoch=? AND entity_id=?", state.State, state.AvailableAt, s.HabiticaID, now, e.ID, entity.ID)
			} else {
				var n int
				if err = tx.QueryRowContext(ctx, "SELECT count(*) FROM personal_claims WHERE epoch=? AND entity_id=? AND habitica_id=?", e.ID, entity.ID, s.HabiticaID).Scan(&n); err != nil {
					return nil, err
				}
				if n > 0 {
					return nil, fail(409, "already-claimed")
				}
				_, err = tx.ExecContext(ctx, "INSERT INTO personal_claims VALUES(?,?,?,?)", e.ID, entity.ID, s.HabiticaID, now)
				if err == nil && entity.Kind == "poi" {
					_, err = tx.ExecContext(ctx, "INSERT OR IGNORE INTO discoveries VALUES(?,?,?,?,?)", e.ID, entity.ID, entity.POI, s.HabiticaID, now)
					if err == nil {
						_, err = tx.ExecContext(ctx, "UPDATE entity_state SET state='charted',by_id=COALESCE(by_id,?),at=COALESCE(at,?) WHERE epoch=? AND entity_id=?", s.HabiticaID, now, e.ID, entity.ID)
						if err == nil {
							state, err = entityStatus(ctx, tx, e, entity, now)
						}
					}
				}
			}
			if err != nil {
				return nil, err
			}
			if err = claimRate(ctx, tx, s.HabiticaID, now); err != nil {
				w.Header().Set("Retry-After", "60")
				return nil, err
			}
			loot, err := wilds.RollLoot(e.Epoch, entity.ID, *req.Cycle)
			if err != nil {
				return nil, err
			}
			if err = grantLoot(ctx, tx, s, loot, "wilds-claim", e.ID+":"+entity.ID, now); err != nil {
				return nil, err
			}
			m, err := materials(ctx, tx, s.HabiticaID)
			if err != nil {
				return nil, err
			}
			return struct {
				Epoch     string         `json:"epoch"`
				Entity    entityView     `json:"entity"`
				Loot      wilds.LootDrop `json:"loot"`
				Materials map[string]int `json:"materials"`
			}{e.ID, state, loot, m}, nil
		case "/api/wilds/defeat":
			region, ok := regionDefinition(e.RegionID)
			if !ok {
				return nil, fail(404, "region-not-found")
			}
			if s.State.Area != "wilds" || s.State.HP > 0 {
				return nil, fail(409, "not-defeated-in-wilds")
			}
			// Lantern positions are region tile coordinates; progress uses pixels.
			if s.State.Position.X < 0 || s.State.Position.Y < 0 || req.X == nil || req.Y == nil || *req.X < 0 || *req.Y < 0 || *req.X >= region.GridWidth*content.WildsRules.ChunkSize || *req.Y >= region.GridHeight*content.WildsRules.ChunkSize || int(s.State.Position.X/wildsTileSize) != *req.X || int(s.State.Position.Y/wildsTileSize) != *req.Y {
				return nil, fail(400, "invalid-position")
			}

			day := time.Unix(now, 0).UTC().Format("2006-01-02")
			var n int
			err = tx.QueryRowContext(ctx, "SELECT qty FROM lantern_creations WHERE habitica_id=? AND utc_day=?", s.HabiticaID, day).Scan(&n)
			if err != nil && err != sql.ErrNoRows {
				return nil, err
			}
			if n >= content.Rules.WildsLimits.LanternsCreatedPerDay {
				midnight := time.Unix(now, 0).UTC().Truncate(24 * time.Hour).Add(24 * time.Hour).Unix()
				w.Header().Set("Retry-After", strconv.FormatInt(midnight-now, 10))
				return nil, fail(429, "lantern-creation-limited")
			}
			if _, err = tx.ExecContext(ctx, "INSERT INTO lantern_creations VALUES(?,?,1) ON CONFLICT(habitica_id,utc_day) DO UPDATE SET qty=qty+1", s.HabiticaID, day); err != nil {
				return nil, err
			}
			id, err := store.Random()
			if err != nil {
				return nil, err
			}
			_, err = tx.ExecContext(ctx, `INSERT INTO lanterns(id,epoch,world_id,region_id,owner_id,x,y,at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(world_id,region_id,owner_id) DO UPDATE SET id=excluded.id,epoch=excluded.epoch,x=excluded.x,y=excluded.y,lit_by=NULL,lit_at=NULL,at=excluded.at`, id, e.ID, s.WorldID, e.RegionID, s.HabiticaID, *req.X, *req.Y, now)
			if err != nil {
				return nil, err
			}
			if err = store.Credit(ctx, tx, s, 0, 0, "wilds-defeat", id, nil, now); err != nil {
				return nil, err
			}
			ls, err := lanterns(ctx, tx, e.ID)
			return struct {
				Epoch     string        `json:"epoch"`
				LanternID string        `json:"lanternId"`
				Lanterns  []lanternView `json:"lanterns"`
			}{e.ID, id, ls}, err
		case "/api/wilds/lantern":
			if req.LanternID == "" || req.OwnerID == "" {
				return nil, fail(400, "lantern-id-required")
			}
			var lit sql.NullString
			var lx, ly int
			err := tx.QueryRowContext(ctx, "SELECT lit_by,x,y FROM lanterns WHERE epoch=? AND owner_id=? AND id=?", e.ID, req.OwnerID, req.LanternID).Scan(&lit, &lx, &ly)
			if err == sql.ErrNoRows {
				return nil, fail(404, "lantern-not-found")
			}
			if err != nil {
				return nil, err
			}
			if err = nearWilds(*s, e, lx, ly); err != nil {
				return nil, err
			}
			if lit.Valid {
				return nil, fail(409, "already-lit")
			}
			loot := wilds.LootDrop{Materials: []wilds.MaterialQty{}}
			rewarded := false
			if req.OwnerID != s.HabiticaID {
				day := time.Unix(now, 0).UTC().Format("2006-01-02")
				var n int
				err = tx.QueryRowContext(ctx, "SELECT qty FROM lantern_rewards WHERE habitica_id=? AND utc_day=?", s.HabiticaID, day).Scan(&n)
				if err != nil && err != sql.ErrNoRows {
					return nil, err
				}
				if n < content.Rules.WildsLimits.LanternRelightsPerDay {
					rewarded = true
					reward := content.Rules.WildsLimits.LanternReward
					loot.Materials = append(loot.Materials, wilds.MaterialQty{ID: reward.Material, Qty: reward.Qty})
					_, err = tx.ExecContext(ctx, "INSERT INTO lantern_rewards VALUES(?,?,1) ON CONFLICT(habitica_id,utc_day) DO UPDATE SET qty=qty+1", s.HabiticaID, day)
					if err != nil {
						return nil, err
					}
				}
			}
			_, err = tx.ExecContext(ctx, "UPDATE lanterns SET lit_by=?,lit_at=? WHERE id=?", s.HabiticaID, now, req.LanternID)
			if err != nil {
				return nil, err
			}
			if err = grantLoot(ctx, tx, s, loot, "wilds-relight", req.LanternID, now); err != nil {
				return nil, err
			}
			m, err := materials(ctx, tx, s.HabiticaID)
			if err != nil {
				return nil, err
			}
			ls, err := lanterns(ctx, tx, e.ID)
			return struct {
				Epoch     string         `json:"epoch"`
				Rewarded  bool           `json:"rewarded"`
				Loot      wilds.LootDrop `json:"loot"`
				Materials map[string]int `json:"materials"`
				Lanterns  []lanternView  `json:"lanterns"`
			}{e.ID, rewarded, loot, m, ls}, err
		}
		return nil, fail(404, "not-found")
	})
}
func grantLoot(ctx context.Context, tx *sql.Tx, s *store.Snapshot, loot wilds.LootDrop, reason, ref string, now int64) error {
	// Even an empty deterministic roll has an auditable claim record.
	if err := store.Credit(ctx, tx, s, 0, 0, reason, ref, nil, now); err != nil {
		return err
	}
	for _, m := range loot.Materials {
		if err := materialChange(ctx, tx, s.HabiticaID, m.ID, m.Qty, reason, ref, now); err != nil {
			return err
		}
	}
	if loot.Trinket != nil {
		// A story keepsake is a single, real thing: the Wilds give a bound
		// keepsake to a player once, and never repeat it (the roll may name
		// it again, but nothing is granted). Unbound trinkets repeat.
		if def, ok := content.ItemFor(*loot.Trinket); ok && def.Kind == "keepsake" && def.Bound {
			first, err := store.Outcome(ctx, tx, s.HabiticaID, "story-keepsake:"+*loot.Trinket, reason, now)
			if err != nil {
				return err
			}
			if !first {
				return nil
			}
		}
		if err := packPut(ctx, tx, s.HabiticaID, *loot.Trinket, []makerQty{{"", 1}}, reason, ref, now); err != nil {
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

// Matches src/game/textures.ts TILE. Entity coordinates are local to chunks;
// lantern coordinates and this check use region tiles, never screen pixels.
const wildsTileSize = 16
const wildsInteractionRadius = 3

func nearWilds(s store.Snapshot, e regionEpoch, x, y int) error {
	if s.State.Area != "wilds" {
		return fail(409, "not-in-wilds")
	}
	r, ok := regionDefinition(e.RegionID)
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
