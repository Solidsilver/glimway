package api

// Map knowledge follows the existing device-local exploration list. These
// reads describe only submitted keys and one's own fixed lot stake. They
// don't make chunks, credit visits, or grant any building/tending rights.
import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"

	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"glimway/server/internal/worldchange"
)

const mapBatch = 256

func (a *Server) mapStatusRead(w http.ResponseWriter, r *http.Request) error {
	req := &contract.WildsMapRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	if len(req.Explored) > mapBatch {
		return fail(400, "invalid-request")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := a.requestTime(r.Context()).Unix()
	ep, err := a.openEpochs(r.Context(), tx, s.WorldID, now)
	if err != nil {
		return chunkError(err)
	}
	out, err := a.mapStatus(r.Context(), tx, s, ep, req.Explored, now)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	writeProto(w, 200, out)
	return nil
}

// nextBuilt predicts the existing holders' next judgement without running it.
func nextBuilt(oil uint32, dimming, released bool) string {
	if released {
		return "released"
	}
	if oil > 0 {
		return "held"
	}
	if dimming {
		return "turns"
	}
	return "dimming"
}

func (a *Server) mapStatus(ctx context.Context, tx *sql.Tx, s store.Snapshot, ep openEpochs, known []*contract.WildsChunkKey, now int64) (*contract.WildsMapStatus, error) {
	out := &contract.WildsMapStatus{Wick: ep.wick.Id}
	seen := map[[2]int]bool{}
	lamps := map[string]bool{}
	for _, k := range known {
		if k == nil || k.Realm != content.WildsRules.GetRealm() || k.Layer != 0 {
			return nil, fail(400, "invalid-request")
		}
		cx, cy := int(k.Cx), int(k.Cy)
		if seen[[2]int{cx, cy}] || !location.OnGrid(s.WorldID, cx, cy) {
			continue
		}
		seen[[2]int{cx, cy}] = true
		land, lamp, err := a.chunkLand(ctx, tx, s.WorldID, ep, cx, cy, now)
		if err != nil {
			return nil, err
		}
		out.Chunks = append(out.Chunks, land)
		if lamp != nil {
			out.Lamps = append(out.Lamps, lamp)
			lamps[lamp.Id] = true
		}
	}
	// A household knows its own lantern even without having walked behind it.
	// Only its mark is added, never the backland extent or terrain.
	rows, err := tx.QueryContext(ctx, `SELECT h.gate FROM homesteads h JOIN homestead_members m ON m.homestead_id=h.id WHERE h.world_id=? AND m.account_id=? ORDER BY h.gate`, s.WorldID, s.AccountID)
	if err != nil {
		return nil, err
	}
	var gates []int
	for rows.Next() {
		var gate int
		if err = rows.Scan(&gate); err != nil {
			rows.Close()
			return nil, err
		}
		gates = append(gates, gate)
	}
	if err = closeRows(rows); err != nil {
		return nil, err
	}
	for _, gate := range gates {
		cx, cy := chunks.BacklandChunk(gate)
		_, lamp, err := a.chunkLand(ctx, tx, s.WorldID, ep, cx, cy, now)
		if err != nil {
			return nil, err
		}
		if lamp != nil && !lamps[lamp.Id] {
			out.Lamps = append(out.Lamps, lamp)
			lamps[lamp.Id] = true
		}
	}
	return out, nil
}

func (a *Server) chunkLand(ctx context.Context, tx *sql.Tx, world string, ep openEpochs, cx, cy int, now int64) (*contract.ChunkLandStatus, *contract.MapLamp, error) {
	land := &contract.ChunkLandStatus{Chunk: chunkKeyProto(cx, cy), Tier: "wild", NextTurning: "detail-turns"}
	if location.SourceOf(cx, cy).Kind == location.SourceFixed {
		land.Tier, land.NextTurning = "permanent", "permanent"
		return land, nil, nil
	}
	if wilds.EpochKindAt(cx, cy) == store.EpochStill {
		land.Tier, land.NextTurning = "still", "permanent"
		return land, nil, nil
	}
	var kind, id string
	var since int64
	var released sql.NullInt64
	err := tx.QueryRowContext(ctx, `SELECT holder_kind,holder_id,since,released_at FROM holds WHERE world_id=? AND realm=? AND layer=0 AND cx=? AND cy=?`, world, content.WildsRules.GetRealm(), cx, cy).Scan(&kind, &id, &since, &released)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, nil, err
	}
	if err == nil {
		land.Tier, land.ClaimId, land.Cost = "built", kind+":"+id, 1
		land.Epoch = ep.of(cx, cy)
		lamp := &contract.MapLamp{Id: land.ClaimId, Kind: kind, At: float64(since), Land: land}
		switch kind {
		case lotLanternKind:
			gate, err := strconv.Atoi(id)
			if err != nil {
				return nil, nil, err
			}
			err = tx.QueryRowContext(ctx, `SELECT l.oil,l.dimming FROM lot_lanterns l JOIN homesteads h ON h.id=l.homestead_id WHERE h.world_id=? AND h.gate=?`, world, gate).Scan(&land.Reserve, &land.Dimming)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return nil, nil, err
			}
			ox, oy := chunks.LotOrigin(gate)
			x, y := chunks.LanternStake(gate)
			lamp.X, lamp.Y = int32(ox+x), int32(oy+y)
		case wayLampKind:
			var x, y int
			err = tx.QueryRowContext(ctx, `SELECT c.oil,c.dimming,c.set_at,i.x,i.y,coalesce(i.name,'') FROM camps c JOIN homestead_items i ON i.id=c.id WHERE c.world_id=? AND c.id=?`, world, id).Scan(&land.Reserve, &land.Dimming, &lamp.At, &x, &y, &lamp.Name)
			if err != nil {
				return nil, nil, err
			}
			lamp.X, lamp.Y = int32(cx*chunkSize()+x), int32(cy*chunkSize()+y)
		default:
			// Future hold kinds need their own reserve reader; don't invent a lamp.
			lamp = nil
		}
		land.NextTurning = nextBuilt(land.Reserve, land.Dimming, released.Valid)
		return land, lamp, nil
	}
	row, err := worldchange.Get(ctx, tx, groundKey(world, ep.of(cx, cy), cx, cy), groundKind, now)
	if err != nil || row == nil {
		return land, nil, err
	}
	g, err := decodeGround(row.State)
	if err != nil {
		return nil, nil, err
	}
	for _, t := range g.Changes {
		if chunks.LayKind(t.Change) != nil {
			land.Tier = "common"
			land.Ground = g
			err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM chunk_visits WHERE world_id=? AND realm=? AND layer=0 AND cx=? AND cy=? AND wick_start=?)`, world, content.WildsRules.GetRealm(), cx, cy, store.WickStart(now)).Scan(&land.Visited)
			land.NextTurning = "paths-turn"
			if land.Visited {
				land.NextTurning = "carries"
			}
			break
		}
	}
	return land, nil, err
}
