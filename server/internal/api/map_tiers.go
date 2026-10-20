package api

// Map knowledge follows the existing device-local exploration list. These
// reads describe only submitted keys and one's own fixed lot stake. They
// don't make chunks, credit visits, or grant any building/tending rights.
import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"strconv"

	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"glimway/server/internal/worldchange"

	"google.golang.org/protobuf/proto"
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
	if req.Glimpse {
		sight, err := sightOf(r.Context(), tx, s, now)
		if err != nil {
			return err
		}
		if err = a.mapWindow(sight, ep, out); err != nil {
			return err
		}
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
		if seen[[2]int{cx, cy}] || !location.OnGrid(cx, cy) {
			continue
		}
		seen[[2]int{cx, cy}] = true
		land, marks, err := a.chunkLand(ctx, tx, s.WorldID, s.AccountID, ep, cx, cy, now)
		if err != nil {
			return nil, err
		}
		out.Chunks = append(out.Chunks, land)
		for _, lamp := range marks {
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
		_, marks, err := a.chunkLand(ctx, tx, s.WorldID, s.AccountID, ep, cx, cy, now)
		if err != nil {
			return nil, err
		}
		// Only the lantern's own mark: communal lights there need exploring.
		for _, lamp := range marks {
			if lamp.Kind == lotLanternKind && !lamps[lamp.Id] {
				out.Lamps = append(out.Lamps, lamp)
				lamps[lamp.Id] = true
			}
		}
	}
	return out, nil
}

func (a *Server) chunkTier(ctx context.Context, tx *sql.Tx, world, me string, ep openEpochs, cx, cy int, now int64) (*contract.ChunkLandStatus, *contract.MapLamp, error) {
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
			// Yours when you live on the lot; a lot's keeper goes unnamed.
			err = tx.QueryRowContext(ctx, `SELECT EXISTS(SELECT 1 FROM homesteads h JOIN homestead_members m ON m.homestead_id=h.id WHERE h.world_id=? AND h.gate=? AND m.account_id=?)`, world, gate, me).Scan(&land.Yours)
			if err != nil {
				return nil, nil, err
			}
			ox, oy := chunks.LotOrigin(gate)
			x, y := chunks.LanternStake(gate)
			lamp.X, lamp.Y = int32(ox+x), int32(oy+y)
		case wayLampKind:
			var x, y int
			// A camp taken down (or its lamp set again elsewhere) leaves
			// its hold released here until the turning, with no lamp.
			var setter string
			err = tx.QueryRowContext(ctx, `SELECT c.oil,c.dimming,c.set_at,i.x,i.y,coalesce(i.name,''),c.setter,coalesce(p.display_name,'') FROM camps c JOIN homestead_items i ON i.id=c.id LEFT JOIN players p ON p.account_id=c.setter WHERE c.world_id=? AND c.id=? AND c.cx=? AND c.cy=?`, world, id, cx, cy).Scan(&land.Reserve, &land.Dimming, &lamp.At, &x, &y, &lamp.Name, &setter, &land.Keeper)
			if errors.Is(err, sql.ErrNoRows) && released.Valid {
				land.NextTurning = nextBuilt(0, false, true)
				return land, nil, nil
			}
			if err != nil {
				return nil, nil, err
			}
			land.Keeper, land.Yours = capDonor(land.Keeper), setter == me
			lamp.X, lamp.Y = int32(cx*chunkSize()+x), int32(cy*chunkSize()+y)
			// Its Keeper's naming, once it has one (lamp_naming.go).
			n, err := lampNaming(ctx, tx, world, id)
			if err != nil {
				return nil, nil, err
			}
			if n != nil {
				lamp.Name, lamp.Naming, lamp.Namer = n.ShortName, n.Text, n.NamerName
			}
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

// chunkLand is a chunk's land status and the lamps marked in it: its
// claim's own lamp, and any lit communal lamps (communal_lamps.go) as
// common-lamp marks under the neutral label until a Keeper names one. A
// chunk whose only Common work is lamps is Common by them; a held chunk's
// lamps share its Built status.
func (a *Server) chunkLand(ctx context.Context, tx *sql.Tx, world, me string, ep openEpochs, cx, cy int, now int64) (*contract.ChunkLandStatus, []*contract.MapLamp, error) {
	land, claim, err := a.chunkTier(ctx, tx, world, me, ep, cx, cy, now)
	if err != nil {
		return nil, nil, err
	}
	var marks []*contract.MapLamp
	if claim != nil {
		marks = append(marks, claim)
	}
	if land.Tier == "permanent" || land.Tier == "still" {
		return land, marks, nil
	}
	rows, err := tx.QueryContext(ctx, communalLampSelect+"WHERE world_id=? AND cx=? AND cy=? ORDER BY y,x", world, cx, cy)
	if err != nil {
		return nil, nil, err
	}
	lit := []communalLamp{}
	for rows.Next() {
		l, err := scanCommunalLamp(rows)
		if err != nil {
			rows.Close()
			return nil, nil, err
		}
		lit = append(lit, l)
	}
	if err = closeRows(rows); err != nil || len(lit) == 0 {
		return land, marks, err
	}
	if land.Tier == "wild" {
		land.Tier = "common"
		if land.Visited, err = store.Visited(ctx, tx, world, cx, cy, now); err != nil {
			return nil, nil, err
		}
		land.NextTurning = "lamps-turn"
		if land.Visited {
			land.NextTurning = "lamps-carry"
		}
	}
	S := chunkSize()
	for _, l := range lit {
		mark := &contract.MapLamp{Id: l.ID, Kind: commonLampKind, X: int32(cx*S + l.X), Y: int32(cy*S + l.Y), At: float64(l.LitAt), Land: land}
		n, err := lampNaming(ctx, tx, world, l.ID)
		if err != nil {
			return nil, nil, err
		}
		if n != nil {
			mark.Name, mark.Naming, mark.Namer = n.ShortName, n.Text, n.NamerName
		}
		marks = append(marks, mark)
	}
	return land, marks, nil
}

// mapWindow adds the land round the reader at glimpse detail (0.14: the map
// is a window, not a frontier): the chunks within the content's
// map.glimpseChunks of the reader's anchor (sight.go), clipped to the
// world border, and a glimpse of every generated one. In a room the window
// is round the gate, as sight is. Glimpses never make a chunk.
func (a *Server) mapWindow(sight sightAnchor, ep openEpochs, out *contract.WildsMapStatus) error {
	g := a.Config.WildsGenerator
	if g == nil {
		return nil
	}
	r := int(content.WildsRules.GetMap().GetGlimpseChunks())
	tcx, tcy := sight.chunk()
	bx0, by0, bx1, by1 := wilds.BorderRect()
	x0, y0, x1, y1 := max(tcx-r, bx0), max(tcy-r, by0), min(tcx+r, bx1), min(tcy+r, by1)
	out.Window = &contract.WildsChunkRect{MinCx: int32(x0), MinCy: int32(y0), MaxCx: int32(x1), MaxCy: int32(y1)}
	at := make([]chunks.ChunkXY, 0, (x1-x0+1)*(y1-y0+1))
	for cy := y0; cy <= y1; cy++ {
		for cx := x0; cx <= x1; cx++ {
			if location.SourceOf(cx, cy).Kind == location.SourceGenerated {
				at = append(at, chunks.ChunkXY{CX: int32(cx), CY: int32(cy)})
			}
		}
	}
	vs, err := g.Glimpses(proto.Clone(ep.wick).(*contract.WildsEpoch), at)
	if err != nil {
		return err
	}
	if len(vs) != len(at) {
		return fmt.Errorf("map window: %d glimpses for %d chunks", len(vs), len(at))
	}
	out.Glimpse = make([]*contract.WildsGlimpse, len(at))
	for i, v := range vs {
		out.Glimpse[i] = &contract.WildsGlimpse{Chunk: chunkKeyProto(int(at[i].CX), int(at[i].CY)), Land: v.Land, River: v.River}
	}
	return nil
}
