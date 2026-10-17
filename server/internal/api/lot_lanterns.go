package api

// Lot lanterns (roadmap 0.12; hearthwick-2.md 6). Each lot's lantern hangs
// on a stake of its back line. Filled with oil it lights, and holds the
// backland chunk behind the lot (store/holds.go): while it burns, the
// backland joins the lot's service bounds and keeps its land across
// turnings. A member lights it; anyone may top it up.
//
// Upkeep is judged once at each turning (lotLanternHolder): a wick of oil
// burns; out of oil it dims for one wick; still empty, the hold lapses,
// everything placed out there goes home (planted things to the archive,
// their seeds to the chest) and the backland turns.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"
	"strconv"

	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
)

// lotLanternKind is the lantern's holder kind; the holder id is the gate.
const lotLanternKind = "lot-lantern"

// lotLantern is a lot's lantern as a homestead view shows it: lit while
// its hold stands (and isn't let go), its oil in wicks, dimming when the
// oil ran out at the last turning.
type lotLantern struct {
	Lit     bool `json:"lit"`
	Oil     int  `json:"oil"`
	Dimming bool `json:"dimming"`
}

func lotLanternProto(l lotLantern) *contract.LotLanternView {
	return &contract.LotLanternView{Lit: l.Lit, Oil: int32(l.Oil), Dimming: l.Dimming}
}

// lanternOf reads a homestead's lantern.
func lanternOf(ctx context.Context, tx *sql.Tx, home, world string, gate int) (lotLantern, error) {
	var l lotLantern
	err := tx.QueryRowContext(ctx, "SELECT oil,dimming FROM lot_lanterns WHERE homestead_id=?", home).Scan(&l.Oil, &l.Dimming)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return l, err
	}
	err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM holds WHERE world_id=? AND holder_kind=? AND holder_id=? AND released_at IS NULL)", world, lotLanternKind, strconv.Itoa(gate)).Scan(&l.Lit)
	return l, err
}

// releaseLantern lets a lot's hold go at the next turning (a lost deed):
// nobody is left to tend it.
func releaseLantern(ctx context.Context, tx *sql.Tx, world string, gate int, now int64) error {
	_, err := tx.ExecContext(ctx, "UPDATE holds SET released_at=coalesce(released_at,?) WHERE world_id=? AND holder_kind=? AND holder_id=?", now, world, lotLanternKind, strconv.Itoa(gate))
	return err
}

// backlandGateAt: the lot whose backland the player stands in, or -1.
func backlandGateAt(s *store.Snapshot) int {
	if s.State.Area != outdoorsArea {
		return -1
	}
	S := chunkSize()
	x, y := int(math.Floor(s.State.Position.X/16)), int(math.Floor(s.State.Position.Y/16))
	return chunks.BacklandAt(wilds.FloorDiv(x, S), wilds.FloorDiv(y, S))
}

// onLotGround: the player stands where the home's services reach: inside
// its fence, or in its backland while the lantern burns (lotLit).
func onLotGround(s *store.Snapshot, h homeView) bool {
	return onPrivateLot(s, h.Gate) || h.Lantern.Lit && backlandGateAt(s) == h.Gate
}

// backland is a lit lot's backland chunk as the server validates building
// on it: the held chunk with its ground changes, and the lot-local x of its
// first column.
type backland struct {
	x0  int
	eff chunks.Effective
}

// holdAt is the hold on a chunk through the server's own chunks (nil when
// it isn't held, or the server's epochs aren't the stored ones).
func (a *Server) holdAt(ctx context.Context, tx *sql.Tx, world string, cx, cy int) (*store.Hold, error) {
	held, ok := a.Config.Epochs.(*store.Chunks)
	if !ok {
		return nil, nil
	}
	return held.HoldAt(ctx, tx, world, int32(cx), int32(cy))
}

// backlandOf reads a lot's backland while its lantern holds it, or nil.
func (a *Server) backlandOf(ctx context.Context, tx *sql.Tx, world string, gate int, now int64) (*backland, error) {
	cx, cy := chunks.BacklandChunk(gate)
	h, err := a.holdAt(ctx, tx, world, cx, cy)
	if err != nil || h == nil || h.HolderKind != lotLanternKind || h.HolderID != strconv.Itoa(gate) || h.Released != nil {
		return nil, err
	}
	e, err := store.HeldEpoch(ctx, tx, world, cx, cy)
	if err != nil || e == nil {
		return nil, err
	}
	m, err := a.Config.Chunks.Chunk(ctx, tx, world, e.Id, 0, int32(cx), int32(cy))
	if err != nil {
		return nil, chunkError(err)
	}
	g, err := groundChanges(ctx, tx, world, e, cx, cy, now)
	if err != nil {
		return nil, err
	}
	ox, _ := chunks.LotOrigin(gate)
	return &backland{x0: cx*chunkSize() - ox, eff: chunks.NewEffective(m, g)}, nil
}

// buildable: a lot-local backland tile is open land (cleared or laid
// counts) with nothing of the Wilds standing on it.
func (b *backland) buildable(x, y int) bool {
	lx := x - b.x0
	if !b.eff.Walkable(lx, y) {
		return false
	}
	if g := b.eff.BaseGround(lx, y); g == nil || g.GetSurface() != "land" {
		return false
	}
	c := b.eff.Chunk
	tx, ty := uint32(lx), uint32(y)
	return !slices.ContainsFunc(c.Sites, func(s *contract.StorySite) bool { return s.Tx == tx && s.Ty == ty }) &&
		!slices.ContainsFunc(c.Entities, func(e *contract.WildsEntity) bool { return e.Tx == tx && e.Ty == ty }) &&
		!slices.ContainsFunc(c.Places, func(m *contract.WildsPlaceMark) bool { return m.Tx == tx && m.Ty == ty })
}

// rectInBackland: every tile of r is in the gate's backland.
func rectInBackland(r rect, gate int) bool {
	return chunks.InBackland(r.x, r.y, gate) && chunks.InBackland(r.x+r.w-1, r.y+r.h-1, gate)
}

// backlandBuilder: in a lot's backland held by its lantern, only the lot's
// members change the ground (clear, lay); elsewhere anyone may.
func (a *Server) backlandBuilder(ctx context.Context, tx *sql.Tx, s *store.Snapshot, cx, cy int) error {
	gate := chunks.BacklandAt(cx, cy)
	if gate < 0 {
		return nil
	}
	h, err := a.holdAt(ctx, tx, s.WorldID, cx, cy)
	if err != nil || h == nil || h.HolderKind != lotLanternKind {
		return err
	}
	var mine bool
	err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM homestead_members m JOIN homesteads h ON h.id=m.homestead_id WHERE m.account_id=? AND h.world_id=? AND h.gate=?)", s.AccountID, s.WorldID, gate).Scan(&mine)
	if err == nil && !mine {
		err = fail(409, "not-your-land")
	}
	return err
}

// fillLantern pours one oil into a lot's lantern. Lighting a dark lantern
// is a member's (it holds the backland as it stands this wick); topping up
// a lit one is anyone's.
func (a *Server) fillLantern(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.HomesteadRequest, myHome string, member bool, now int64) (int, error) {
	if req.Gate == nil {
		return -1, fail(400, "invalid-gate")
	}
	gate := int(req.Gate.GetValue())
	if gate < 0 || gate >= gateCount() {
		return -1, fail(404, "invalid-gate")
	}
	ox, oy := chunks.LotOrigin(gate)
	sx, sy := chunks.LanternStake(gate)
	if !nearTile(s, outdoorsArea, ox+sx, oy+sy, 2) {
		return -1, fail(409, "too-far-away")
	}
	var home string
	if err := tx.QueryRowContext(ctx, "SELECT id FROM homesteads WHERE world_id=? AND gate=?", s.WorldID, gate).Scan(&home); errors.Is(err, sql.ErrNoRows) {
		return -1, fail(409, "no-home")
	} else if err != nil {
		return -1, err
	}
	l, err := lanternOf(ctx, tx, home, s.WorldID, gate)
	if err != nil {
		return -1, err
	}
	rules := content.HomeRules.GetLotLantern()
	if !l.Lit && !(member && myHome == home) {
		return -1, fail(409, "not-a-member")
	}
	if l.Oil+int(rules.GetWicksPerOil()) > int(rules.GetMaxWicks()) {
		return -1, fail(409, "lantern-full")
	}
	if n, err := stackTotal(ctx, tx, packOf(s.AccountID), rules.GetOil()); err != nil {
		return -1, err
	} else if n < 1 {
		return -1, fail(409, "insufficient-materials")
	}
	if _, err = packTake(ctx, tx, s.AccountID, rules.GetOil(), nil, 1, "lot-lantern", fmt.Sprintf("%s:gate:%d", home, gate), now); err != nil {
		return -1, err
	}
	if !l.Lit {
		cx, cy := chunks.BacklandChunk(gate)
		holds, ok := a.Config.Epochs.(*store.Chunks)
		if !ok {
			return -1, fail(409, "cannot-hold")
		}
		if _, err = holds.Hold(ctx, tx, s.WorldID, int32(cx), int32(cy), lotLanternKind, strconv.Itoa(gate), now); errors.Is(err, store.ErrHeld) || errors.Is(err, store.ErrNotHoldable) {
			return -1, fail(409, "cannot-hold")
		} else if err != nil {
			return -1, chunkError(err)
		}
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO lot_lanterns(homestead_id,oil,dimming) VALUES(?,?,0)
 ON CONFLICT(homestead_id) DO UPDATE SET oil=oil+excluded.oil,dimming=0`, home, rules.GetWicksPerOil())
	return gate, err
}

// lotLanternHolder judges lot lanterns at the turning (roadmap rule 4).
type lotLanternHolder struct{}

func lotHome(ctx context.Context, tx *sql.Tx, h store.Hold) (string, int, error) {
	gate, err := strconv.Atoi(h.HolderID)
	if err != nil {
		return "", -1, nil
	}
	var home string
	err = tx.QueryRowContext(ctx, "SELECT id FROM homesteads WHERE world_id=? AND gate=?", h.World, gate).Scan(&home)
	if errors.Is(err, sql.ErrNoRows) {
		return "", gate, nil
	}
	return home, gate, err
}

// Keeps burns a wick of oil; with none left a lit lantern dims for one
// wick (a full wick of warning); dimming and still empty, it goes dark.
func (lotLanternHolder) Keeps(ctx context.Context, tx *sql.Tx, h store.Hold, now int64) (bool, error) {
	home, _, err := lotHome(ctx, tx, h)
	if err != nil || home == "" {
		return false, err
	}
	var oil int
	var dimming bool
	err = tx.QueryRowContext(ctx, "SELECT oil,dimming FROM lot_lanterns WHERE homestead_id=?", home).Scan(&oil, &dimming)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	switch {
	case oil >= 1:
		_, err = tx.ExecContext(ctx, "UPDATE lot_lanterns SET oil=oil-1,dimming=0 WHERE homestead_id=?", home)
		return true, err
	case !dimming:
		_, err = tx.ExecContext(ctx, "INSERT INTO lot_lanterns(homestead_id,oil,dimming) VALUES(?,0,1) ON CONFLICT(homestead_id) DO UPDATE SET dimming=1", home)
		return true, err
	}
	return false, nil
}

// Released: the lantern has gone dark and the backland turns. Nothing a
// player placed is lost (roadmap rule 3): pieces set out there go to home
// storage and planted things are archived with their seed back in the
// chest, as migration 037 did. Ground changes go with the land.
func (lotLanternHolder) Released(ctx context.Context, tx *sql.Tx, h store.Hold, now int64) error {
	home, gate, err := lotHome(ctx, tx, h)
	if err != nil || home == "" {
		return err
	}
	x0, x1 := -24, -1
	if gate%2 == 1 {
		x0, x1 = 24, 47
	}
	if _, err = tx.ExecContext(ctx, "UPDATE homestead_items SET location='storage',scene=NULL,x=NULL,y=NULL,rotation=NULL WHERE homestead_id=? AND location='placed' AND scene='outdoor' AND x BETWEEN ? AND ?", home, x0, x1); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, "SELECT id,item_def,x,y,planted_at,planted_day FROM homestead_plants WHERE homestead_id=? AND x BETWEEN ? AND ? ORDER BY id", home, x0, x1)
	if err != nil {
		return err
	}
	type plant struct {
		id, def     string
		x, y        int
		at, plantDy int64
	}
	all := []plant{}
	for rows.Next() {
		var p plant
		if err = rows.Scan(&p.id, &p.def, &p.x, &p.y, &p.at, &p.plantDy); err != nil {
			rows.Close()
			return err
		}
		all = append(all, p)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, p := range all {
		raw, err := json.Marshal([]any{p.id, home, p.def, p.x, p.y, p.at, p.plantDy})
		if err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO homestead_land_archive(homestead_id,kind,identity,payload) VALUES(?,'homestead_plants',?,?)", home, p.id, string(raw)); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO item_stacks(location,owner,item_def,maker_id,qty) VALUES('storage',?,?,'',1) ON CONFLICT(location,owner,item_def,maker_id) DO UPDATE SET qty=qty+1", home, p.def); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM homestead_plants WHERE id=?", p.id); err != nil {
			return err
		}
	}
	_, err = tx.ExecContext(ctx, "UPDATE lot_lanterns SET oil=0,dimming=0 WHERE homestead_id=?", home)
	return err
}
