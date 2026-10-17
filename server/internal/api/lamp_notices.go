package api

// Lamp notices (0.13; docs/design/lamps.md 2.5): a light the caller keeps
// that dimmed at this wick's turning is told to them once. A dimming
// lasts exactly one wick (filling it clears it; the next turning holds or
// lapses it), so the wick's start names the episode, and an outcome row
// lamp-dimming:<kind>:<id>:<wick start> is the once. No migration.
import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strconv"

	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
)

const lampDimmingReason = "lamp-dimming"

func (a *Server) lampNoticesRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.requestTime(ctx).Unix()
	if err = a.turnWick(ctx, tx, s.WorldID, now); err != nil {
		return err
	}
	out, err := lampNotices(ctx, tx, &s, now)
	if err != nil {
		return err
	}
	return a.finishRead(w, r, tx, s, out)
}

// dimmingLight is one light the caller keeps that is dimming: its notice,
// and the chunks standing in which counts as being there (the lamp's and
// the land it holds).
type dimmingLight struct {
	notice *contract.LampNotice
	near   [][2]int
}

// lampNotices: the caller's dimming lights not yet told this wick. Each is
// recorded as told; one the caller stands by is recorded but not said.
func lampNotices(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (*contract.LampNoticesRead, error) {
	lights, err := keptDimming(ctx, tx, s.WorldID, s.AccountID)
	if err != nil {
		return nil, err
	}
	out := &contract.LampNoticesRead{}
	wick := store.WickStart(now)
	for _, l := range lights {
		n := l.notice
		fresh, err := store.Outcome(ctx, tx, s.AccountID, fmt.Sprintf("%s:%s:%s:%d", lampDimmingReason, n.Kind, n.Id, wick), lampDimmingReason, now)
		if err != nil {
			return nil, err
		}
		if fresh && !standingBy(s, l.near) {
			out.Notices = append(out.Notices, n)
		}
	}
	return out, nil
}

// standingBy: the caller is outdoors in one of the chunks.
func standingBy(s *store.Snapshot, near [][2]int) bool {
	if s.State.Area != outdoorsArea {
		return false
	}
	cx, cy := wilds.ChunkOf(wilds.TileOfPixel(s.State.Position.X, s.State.Position.Y))
	for _, c := range near {
		if c == [2]int{cx, cy} {
			return true
		}
	}
	return false
}

// keptDimming: the dimming camps the account set, then its households'
// dimming lot lanterns, in this world. Communal lamps run on visits, not
// oil, so they never dim.
func keptDimming(ctx context.Context, tx *sql.Tx, world, account string) ([]dimmingLight, error) {
	var out []dimmingLight
	rows, err := tx.QueryContext(ctx, campSelect+"WHERE c.world_id=? AND c.setter=? AND c.dimming=1 ORDER BY c.id", world, account)
	if err != nil {
		return nil, err
	}
	var camps []camp
	for rows.Next() {
		c, err := scanCamp(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		camps = append(camps, c)
	}
	if err = closeRows(rows); err != nil {
		return nil, err
	}
	for _, c := range camps {
		n := &contract.LampNotice{Kind: wayLampKind, Id: c.ID, Cx: int32(c.CX), Cy: int32(c.CY)}
		naming, err := lampNaming(ctx, tx, world, c.ID)
		if err != nil {
			return nil, err
		}
		if naming != nil {
			n.Name = naming.ShortName
		}
		out = append(out, dimmingLight{n, [][2]int{{c.CX, c.CY}}})
	}
	rows, err = tx.QueryContext(ctx, `SELECT h.gate FROM homesteads h JOIN homestead_members m ON m.homestead_id=h.id JOIN lot_lanterns l ON l.homestead_id=h.id WHERE h.world_id=? AND m.account_id=? AND l.dimming=1 ORDER BY h.gate`, world, account)
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
		bx, by := chunks.BacklandChunk(gate)
		ox, oy := chunks.LotOrigin(gate)
		x, y := chunks.LanternStake(gate)
		sx, sy := wilds.ChunkOf(ox+x, oy+y)
		n := &contract.LampNotice{Kind: lotLanternKind, Id: strconv.Itoa(gate), Cx: int32(bx), Cy: int32(by)}
		out = append(out, dimmingLight{n, [][2]int{{bx, by}, {sx, sy}}})
	}
	return out, nil
}
