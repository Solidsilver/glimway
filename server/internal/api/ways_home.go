package api

// Ways home (roadmap 0.13; lamps.md 1.4): two crafted ways back that save a
// long walk, never replace it. A homing turncap returns you to Hearthwick's
// Wilds entrance, an anchor its content names and this resolves now, never a
// copied coordinate. A lamp-ash pouch brings you to open ground beside the
// lamp you bound it to: a camp's way-lamp or a communal lamp, by its stable
// id, in this world. Lot lanterns don't take a binding (the turncap already
// brings you that close to home).
//
// Each takes one item, and only when the travel succeeds: a lamp gone dark,
// packed at Pell's, taken down or burning in another world explains itself
// and keeps the pouch, and so does nowhere to stand. Neither works in a
// fight. The three-second pause is the client's to hold; this operation
// validates and moves the player in one keyed transaction.

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"slices"
	"strings"
	"time"

	"glimway/content"
	contentv1 "glimway/gen/glimway/content/v1"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
)

// The ways home's use types (content items.json) and the operation's actions.
const (
	travelHome = "travel-home"
	travelLamp = "travel-lamp"

	waysBind    = "bind"
	waysTurncap = "turncap"
	waysPouch   = "pouch"
)

// The states of a bound lamp (WaysHomeBinding.state).
const (
	lampLit       = "lit"
	lampUnlit     = "unlit"
	lampPacked    = "packed"
	lampElsewhere = "elsewhere"
	lampGone      = "gone"
)

// lampCamp is a camp's way-lamp as a binding names its kind.
const lampCamp = "camp"

// fightQuiet is how long after the last blow aimed at you, or the last you
// landed on an enemy, before either way home works (tuning).
const fightQuiet = 8 * time.Second

// wayHome is the carried item a way home uses, and its use (content).
func wayHome(use string) (*content.ItemDef, *contentv1.UseEffect) {
	for _, d := range content.ItemsRules.Items {
		if d.GetKind() != "consumable" {
			continue
		}
		for _, e := range d.GetUse() {
			if e.GetType() == use {
				return d, e
			}
		}
	}
	return nil, nil
}

// ------------------------------------------------------------ fights

// markFought stamps an account as fighting now: an enemy wound up or locked
// its aim on them, or a blow of theirs landed on one. A swing into empty air
// isn't a fight, even inside a camp's room (a whole chunk). Callers hold h.mu.
func (h *presenceHub) markFought(id string, now time.Time) {
	if h.foughtAt == nil {
		h.foughtAt = map[string]time.Time{}
	}
	h.foughtAt[id] = now
	// Forget the quiet ones now and then, so the map stays small.
	if len(h.foughtAt) > 256 {
		for k, at := range h.foughtAt {
			if now.Sub(at) >= fightQuiet {
				delete(h.foughtAt, k)
			}
		}
	}
}

// inFight: the account fought, or was fought, within fightQuiet.
func (a *Server) inFight(id string) bool {
	h := a.presence
	if h == nil {
		return false
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	at, ok := h.foughtAt[id]
	return ok && h.now().Sub(at) < fightQuiet
}

// ------------------------------------------------------------ lamps

// boundLamp is a bound lamp as it stands now. While lit: its kind, chunk,
// chunk-local tile and, for a camp, the camp.
type boundLamp struct {
	ID, State, Kind string
	CX, CY, X, Y    int
	Camp            *camp
}

// resolveLamp finds a bound lamp by its stable id: lit in this world (a
// communal lamp, or a camp's way-lamp, dimming or not), or why not.
func resolveLamp(ctx context.Context, tx *sql.Tx, world, boundWorld, id string) (boundLamp, error) {
	out := boundLamp{ID: id, State: lampGone}
	if boundWorld != world {
		out.State = lampElsewhere
		return out, nil
	}
	if l, err := communalLampByID(ctx, tx, world, id); err != nil || l != nil {
		if l != nil {
			out.State, out.Kind, out.CX, out.CY, out.X, out.Y = lampLit, l.Kind, l.CX, l.CY, l.X, l.Y
		}
		return out, err
	}
	if c, err := campByID(ctx, tx, world, id); err != nil || c != nil {
		if c != nil {
			out.State, out.Kind, out.CX, out.CY, out.X, out.Y, out.Camp = lampLit, lampCamp, c.CX, c.CY, c.X, c.Y, c
		}
		return out, err
	}
	// The same piece set as a lamp in another world since.
	var away bool
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM camps WHERE id=?) OR EXISTS(SELECT 1 FROM communal_lamps WHERE id=?)", id, id).Scan(&away); err != nil {
		return out, err
	}
	if away {
		out.State = lampElsewhere
		return out, nil
	}
	var where string
	err := tx.QueryRowContext(ctx, "SELECT location FROM homestead_items WHERE id=?", id).Scan(&where)
	switch {
	case err == nil && where == "crate":
		out.State = lampPacked
	case err != nil && !errors.Is(err, sql.ErrNoRows):
		return out, err
	case strings.HasPrefix(id, "lamp-stone:"):
		// A road stone keeps its id dark or lit; it's dark now.
		out.State = lampUnlit
	}
	return out, nil
}

// lampsNearYou are the lit lamps (communal and camps) in the chunks around
// the caller, nearest first, that they stand within reach of.
func lampsNearYou(ctx context.Context, tx *sql.Tx, s *store.Snapshot) ([]boundLamp, error) {
	if s.State.Area != outdoorsArea {
		return nil, nil
	}
	pcx, pcy := wilds.ChunkOf(wilds.TileOfPixel(s.State.Position.X, s.State.Position.Y))
	out := []boundLamp{}
	rows, err := tx.QueryContext(ctx, communalLampSelect+"WHERE world_id=? AND cx BETWEEN ? AND ? AND cy BETWEEN ? AND ?", s.WorldID, pcx-1, pcx+1, pcy-1, pcy+1)
	if err != nil {
		return nil, err
	}
	for rows.Next() {
		l, err := scanCommunalLamp(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		if nearLamp(s, l.CX, l.CY, l.X, l.Y) {
			out = append(out, boundLamp{ID: l.ID, State: lampLit, Kind: l.Kind, CX: l.CX, CY: l.CY, X: l.X, Y: l.Y})
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	S := chunkSize()
	reach := int(content.HomeRules.GetWayLamp().GetReach())
	for dy := -1; dy <= 1; dy++ {
		for dx := -1; dx <= 1; dx++ {
			c, err := campAt(ctx, tx, s.WorldID, pcx+dx, pcy+dy)
			if err != nil {
				return nil, err
			}
			if c != nil && nearTile(s, outdoorsArea, c.CX*S+c.X, c.CY*S+c.Y, reach) {
				out = append(out, boundLamp{ID: c.ID, State: lampLit, Kind: lampCamp, CX: c.CX, CY: c.CY, X: c.X, Y: c.Y, Camp: c})
			}
		}
	}
	d := func(l boundLamp) float64 {
		x, y := float64((l.CX*S+l.X)*wildsTileSize+wildsTileSize/2), float64((l.CY*S+l.Y)*wildsTileSize+wildsTileSize/2)
		return (x-s.State.Position.X)*(x-s.State.Position.X) + (y-s.State.Position.Y)*(y-s.State.Position.Y)
	}
	slices.SortStableFunc(out, func(a, b boundLamp) int {
		switch da, db := d(a), d(b); {
		case da < db:
			return -1
		case da > db:
			return 1
		}
		return strings.Compare(a.ID, b.ID)
	})
	return out, nil
}

// landingOffsets are the tiles round a lamp to land on, in the order tried:
// the nearer ring first, and in front of the lamp (south) before behind it.
var landingOffsets = func() [][2]int {
	out := [][2]int{}
	for dy := -2; dy <= 2; dy++ {
		for dx := -2; dx <= 2; dx++ {
			if dx != 0 || dy != 0 {
				out = append(out, [2]int{dx, dy})
			}
		}
	}
	ring := func(o [2]int) int { return max(intAbs(o[0]), intAbs(o[1])) }
	slices.SortStableFunc(out, func(a, b [2]int) int {
		if ra, rb := ring(a), ring(b); ra != rb {
			return ra - rb
		}
		if da, db := a[0]*a[0]+a[1]*a[1], b[0]*b[0]+b[1]*b[1]; da != db {
			return da - db
		}
		if a[1] != b[1] {
			return b[1] - a[1]
		}
		return a[0] - b[0]
	})
	return out
}()

// openGround is a chunk's ground to land on: walkable land with nothing
// standing on it (no site, creature, mark, lamp or camp piece). A held
// chunk is read as its hold keeps it.
type openGround struct {
	world  string
	cx, cy int
	g      *backland
	taken  []rect
}

func (a *Server) openGroundIn(ctx context.Context, tx *sql.Tx, world string, cx, cy int, camp *camp, now int64) (*openGround, error) {
	// A camp's chunk (or a stone's inside a standing hold) is its held land.
	g, err := a.campGround(ctx, tx, world, cx, cy, now)
	if err != nil {
		return nil, err
	}
	if g == nil {
		land, err := a.wickChunk(ctx, tx, world, cx, cy, now)
		if err != nil {
			return nil, err
		}
		g = &backland{eff: *land}
	}
	o := &openGround{world: world, cx: cx, cy: cy, g: g}
	if camp == nil {
		if camp, err = campAt(ctx, tx, world, cx, cy); err != nil {
			return nil, err
		}
	}
	if camp != nil {
		pieces, _, err := campPieces(ctx, tx, camp.ID)
		if err != nil {
			return nil, err
		}
		for _, v := range pieces {
			if r, ok := placedRect(v); ok {
				o.taken = append(o.taken, r)
			}
		}
	}
	return o, nil
}

// open: the chunk-local tile is free to land on.
func (o *openGround) open(ctx context.Context, tx *sql.Tx, x, y int) (bool, error) {
	S := chunkSize()
	if x < 0 || y < 0 || x >= S || y >= S || !o.g.buildable(x, y) {
		return false, nil
	}
	here := rect{x, y, 1, 1}
	if slices.ContainsFunc(o.taken, here.overlaps) {
		return false, nil
	}
	lamp, err := lampStandsAt(ctx, tx, o.world, o.cx, o.cy, x, y)
	return !lamp, err
}

// landBeside is open ground beside a lit lamp, inside its chunk. ok is false
// when there is none.
func (a *Server) landBeside(ctx context.Context, tx *sql.Tx, world string, l boundLamp, now int64) (lx, ly int, ok bool, err error) {
	if !location.OnGrid(l.CX, l.CY) {
		return 0, 0, false, nil
	}
	o, err := a.openGroundIn(ctx, tx, world, l.CX, l.CY, l.Camp, now)
	if err != nil {
		return 0, 0, false, err
	}
	for _, d := range landingOffsets {
		x, y := l.X+d[0], l.Y+d[1]
		if ok, err := o.open(ctx, tx, x, y); err != nil || ok {
			return x, y, ok, err
		}
	}
	return 0, 0, false, nil
}

// lampFailure is a lamp that can't be travelled to, as its refusal.
func lampFailure(state string) error {
	switch state {
	case lampElsewhere:
		return fail(409, "lamp-elsewhere")
	case lampPacked:
		return fail(409, "lamp-packed")
	case lampUnlit:
		return fail(409, "lamp-unlit")
	}
	return fail(409, "lamp-gone")
}

// ------------------------------------------------------------ the binding

type waysBinding struct {
	World, Lamp string
	At          int64
}

// bindingOf is the caller's pouch binding, or nil.
func bindingOf(ctx context.Context, tx *sql.Tx, account string) (*waysBinding, error) {
	var b waysBinding
	err := tx.QueryRowContext(ctx, "SELECT world_id,lamp_id,bound_at FROM ways_home_bindings WHERE account_id=?", account).Scan(&b.World, &b.Lamp, &b.At)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &b, err
}

// bindingView is a binding as the wire shows it, with its lamp as it stands.
func bindingView(ctx context.Context, tx *sql.Tx, world string, b *waysBinding) (*contract.WaysHomeBinding, error) {
	if b == nil {
		return nil, nil
	}
	l, err := resolveLamp(ctx, tx, world, b.World, b.Lamp)
	if err != nil {
		return nil, err
	}
	v := &contract.WaysHomeBinding{LampId: b.Lamp, State: l.State, BoundAt: float64(b.At)}
	if l.State == lampLit {
		S := chunkSize()
		v.Kind, v.X, v.Y = l.Kind, int32(l.CX*S+l.X), int32(l.CY*S+l.Y)
	}
	if b.World == world {
		n, err := lampNaming(ctx, tx, world, b.Lamp)
		if err != nil {
			return nil, err
		}
		if n != nil {
			v.LampName = n.ShortName
		}
	}
	return v, nil
}

// waysHomeRead is GET /api/ways-home: your pouch's binding.
func (a *Server) waysHomeRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	if err = a.turnWick(ctx, tx, s.WorldID, a.requestTime(ctx).Unix()); err != nil {
		return err
	}
	b, err := bindingOf(ctx, tx, s.AccountID)
	if err != nil {
		return err
	}
	out := &contract.WaysHomeRead{}
	if out.Binding, err = bindingView(ctx, tx, s.WorldID, b); err != nil {
		return err
	}
	return a.finishRead(w, r, tx, s, out)
}

// ------------------------------------------------------------ the operation

// waysHomeOp is POST /api/ways-home: bind, turncap or pouch.
func (a *Server) waysHomeOp(w http.ResponseWriter, r *http.Request) error {
	req := &contract.WaysHomeRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := a.turnWick(ctx, tx, s.WorldID, now); err != nil {
			return nil, err
		}
		var err error
		switch req.Action {
		case waysBind:
			err = bindPouch(ctx, tx, s, req.Lamp, now)
		case waysTurncap:
			err = a.useTurncap(ctx, tx, s, now)
		case waysPouch:
			err = a.usePouch(ctx, tx, s, now)
		default:
			err = fail(400, "invalid-request")
		}
		if err != nil {
			return nil, err
		}
		if err = refreshItems(ctx, tx, s); err != nil {
			return nil, err
		}
		out := &contract.WaysHomeResult{Action: req.Action, Area: s.State.Area, X: s.State.Position.X, Y: s.State.Position.Y}
		b, err := bindingOf(ctx, tx, s.AccountID)
		if err != nil {
			return nil, err
		}
		out.Binding, err = bindingView(ctx, tx, s.WorldID, b)
		return out, err
	})
}

// bindPouch binds the caller's pouches to a lit lamp they stand within reach
// of: the one named, or the nearest. They need a pouch to bind.
func bindPouch(ctx context.Context, tx *sql.Tx, s *store.Snapshot, id string, now int64) error {
	pouch, _ := wayHome(travelLamp)
	if pouch == nil {
		return fail(400, "invalid-item")
	}
	if n, err := stackTotal(ctx, tx, packOf(s.AccountID), pouch.GetId()); err != nil {
		return err
	} else if n < 1 {
		return fail(409, "invalid-item")
	}
	near, err := lampsNearYou(ctx, tx, s)
	if err != nil {
		return err
	}
	if id != "" {
		near = slices.DeleteFunc(near, func(l boundLamp) bool { return l.ID != id })
	}
	if len(near) == 0 {
		return fail(409, "no-lamp")
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO ways_home_bindings(account_id,world_id,lamp_id,bound_at) VALUES(?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET world_id=excluded.world_id,lamp_id=excluded.lamp_id,bound_at=excluded.bound_at", s.AccountID, s.WorldID, near[0].ID, now)
	return err
}

// arrive moves the caller to a place the server chose: it is theirs now, so
// older reports from where they stood are dropped. Arriving in a Wilds
// chunk visits it, as standing there does.
func (a *Server) arrive(ctx context.Context, tx *sql.Tx, s *store.Snapshot, area string, x, y float64, now int64) error {
	s.State.Area, s.State.Position.X, s.State.Position.Y = area, x, y
	s.PlaceWritten, s.PlaceMoved = true, true
	where := &contract.Where{Area: area, X: x, Y: y}
	if a.Config.Placement != nil {
		if err := a.Config.Placement.Record(ctx, tx, s, where, now); err != nil {
			return err
		}
	}
	if area == outdoorsArea {
		return creditVisit(ctx, tx, s.WorldID, x, y, now)
	}
	return nil
}

// spendWayHome takes the one item a successful way home costs, thanking its
// maker as eating a made thing does.
func (a *Server) spendWayHome(ctx context.Context, tx *sql.Tx, s *store.Snapshot, def string, now int64) error {
	split, err := packTake(ctx, tx, s.AccountID, def, nil, 1, "way-home", def, now)
	if err != nil {
		return err
	}
	for _, m := range split {
		if err = a.thankMaker(ctx, tx, s, m.Maker, def, now); err != nil {
			return err
		}
	}
	return nil
}

// carriesOne refuses travel without the item in the pack.
func carriesOne(ctx context.Context, tx *sql.Tx, s *store.Snapshot, def string) error {
	n, err := stackTotal(ctx, tx, packOf(s.AccountID), def)
	if err == nil && n < 1 {
		err = fail(409, "invalid-item")
	}
	return err
}

// useTurncap returns the caller to Hearthwick's Wilds entrance, the anchor
// the turncap's content names, resolved now. Not in a fight, and not when
// they already stand on the town's safe ground (it would only be spent).
func (a *Server) useTurncap(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) error {
	def, use := wayHome(travelHome)
	if def == nil {
		return fail(400, "invalid-item")
	}
	if err := carriesOne(ctx, tx, s, def.GetId()); err != nil {
		return err
	}
	if a.inFight(s.AccountID) {
		return fail(409, "in-a-fight")
	}
	if location.At(location.Space(s.State.Area), s.State.Position.X, s.State.Position.Y).Safe {
		return fail(409, "not-needed")
	}
	space, x, y, ok := location.Anchor(use.GetTarget())
	if !ok {
		return errors.New("ways home: the turncap's anchor " + use.GetTarget() + " doesn't resolve")
	}
	if err := a.arrive(ctx, tx, s, string(space), x, y, now); err != nil {
		return err
	}
	return a.spendWayHome(ctx, tx, s, def.GetId(), now)
}

// usePouch brings the caller to open ground beside their bound lamp, if it
// burns in this world. Every refusal keeps the pouch.
func (a *Server) usePouch(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) error {
	def, _ := wayHome(travelLamp)
	if def == nil {
		return fail(400, "invalid-item")
	}
	if err := carriesOne(ctx, tx, s, def.GetId()); err != nil {
		return err
	}
	if a.inFight(s.AccountID) {
		return fail(409, "in-a-fight")
	}
	b, err := bindingOf(ctx, tx, s.AccountID)
	if err != nil {
		return err
	}
	if b == nil {
		return fail(409, "pouch-unbound")
	}
	l, err := resolveLamp(ctx, tx, s.WorldID, b.World, b.Lamp)
	if err != nil {
		return err
	}
	if l.State != lampLit {
		return lampFailure(l.State)
	}
	lx, ly, ok, err := a.landBeside(ctx, tx, s.WorldID, l, now)
	if err != nil {
		return err
	}
	if !ok {
		return fail(409, "no-landing")
	}
	S := chunkSize()
	tx0, ty0 := l.CX*S+lx, l.CY*S+ly
	x, y := float64(tx0*wildsTileSize+wildsTileSize/2), float64(ty0*wildsTileSize+wildsTileSize/2)
	if err = a.arrive(ctx, tx, s, outdoorsArea, x, y, now); err != nil {
		return err
	}
	return a.spendWayHome(ctx, tx, s, def.GetId(), now)
}
