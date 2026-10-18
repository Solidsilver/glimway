package api

// Lamp notices (0.13; docs/design/lamps.md 2.5): a light the caller keeps
// is told to them once when it starts dimming, which is when its last wick
// starts (owner, 2026-10-17): its oil is gone, so at the next turning it
// gutters for a wick (dimming), then lapses. Filling it ends the episode.
// Oil only runs out at a turning, so the episode began at this wick's start
// for an empty lamp not yet guttering, or the wick before for a guttering
// one; an outcome row lamp-dimming:<kind>:<id>:<episode start> is the
// once. No migration.
import (
	"context"
	"database/sql"
	"fmt"
	"net/http"
	"strconv"

	"glimway/content"
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
	// A plain read, like the map's: no player state rides on it, so it never
	// maintains or re-saves the reader's state beside their own saves.
	if err = tx.Commit(); err != nil {
		return err
	}
	writeProto(w, 200, out)
	return nil
}

// dimmingLight is one light the caller keeps that is dimming: its notice,
// whether it is already guttering (its warning wick), and the chunks
// standing in which counts as being there (the lamp's and the land it holds).
type dimmingLight struct {
	notice    *contract.LampNotice
	guttering bool
	near      [][2]int
}

// episodeStart is the start of the wick a light's dimming began in: this
// wick's for a light on its last wick, the wick before for a guttering one.
func episodeStart(guttering bool, now int64) int64 {
	start := store.WickStart(now)
	if guttering {
		return content.CalendarAt(content.CalendarRules, start-1).StartsAt
	}
	return start
}

// lampNotices: the caller's dimming lights not yet told this episode. Each
// is recorded as told; one the caller stands by is recorded but not said.
func lampNotices(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (*contract.LampNoticesRead, error) {
	lights, err := keptDimming(ctx, tx, s.WorldID, s.AccountID)
	if err != nil {
		return nil, err
	}
	out := &contract.LampNoticesRead{}
	for _, l := range lights {
		n := l.notice
		fresh, err := store.Outcome(ctx, tx, s.AccountID, fmt.Sprintf("%s:%s:%s:%d", lampDimmingReason, n.Kind, n.Id, episodeStart(l.guttering, now)), lampDimmingReason, now)
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

// keptDimming: the lit camps the account set and its households' lit lot
// lanterns, out of oil, in this world. Lit is a standing hold, not let go.
// Communal lamps run on visits, not oil, so they never dim.
func keptDimming(ctx context.Context, tx *sql.Tx, world, account string) ([]dimmingLight, error) {
	var out []dimmingLight
	rows, err := tx.QueryContext(ctx, campSelect+`JOIN holds h ON h.world_id=c.world_id AND h.holder_kind=? AND h.holder_id=c.id AND h.cx=c.cx AND h.cy=c.cy AND h.released_at IS NULL
WHERE c.world_id=? AND c.setter=? AND c.oil=0 ORDER BY c.id`, wayLampKind, world, account)
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
		out = append(out, dimmingLight{n, c.Dimming, [][2]int{{c.CX, c.CY}}})
	}
	rows, err = tx.QueryContext(ctx, `SELECT h.gate,l.dimming FROM homesteads h JOIN homestead_members m ON m.homestead_id=h.id JOIN lot_lanterns l ON l.homestead_id=h.id
JOIN holds d ON d.world_id=h.world_id AND d.holder_kind=? AND d.holder_id=CAST(h.gate AS TEXT) AND d.released_at IS NULL
WHERE h.world_id=? AND m.account_id=? AND l.oil=0 ORDER BY h.gate`, lotLanternKind, world, account)
	if err != nil {
		return nil, err
	}
	type lot struct {
		gate      int
		guttering bool
	}
	var lots []lot
	for rows.Next() {
		var l lot
		if err = rows.Scan(&l.gate, &l.guttering); err != nil {
			rows.Close()
			return nil, err
		}
		lots = append(lots, l)
	}
	if err = closeRows(rows); err != nil {
		return nil, err
	}
	for _, l := range lots {
		bx, by := chunks.BacklandChunk(l.gate)
		ox, oy := chunks.LotOrigin(l.gate)
		x, y := chunks.LanternStake(l.gate)
		sx, sy := wilds.ChunkOf(ox+x, oy+y)
		n := &contract.LampNotice{Kind: lotLanternKind, Id: strconv.Itoa(l.gate), Cx: int32(bx), Cy: int32(by)}
		out = append(out, dimmingLight{n, l.guttering, [][2]int{{bx, by}, {sx, sy}}})
	}
	return out, nil
}
