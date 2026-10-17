package api

// Camps (roadmap 0.13; lamps.md 2.5, 2.7): a way-lamp set in a Wilds chunk
// holds that one chunk (store/holds.go) while it has oil, as a lot lantern
// holds its backland. The camp's id is its lamp's: the way-lamp piece
// standing in it. Its setter (and their household) set pieces out and plant
// there; anyone may top the lamp up, which gives no rights to what stands
// there.
//
// Upkeep is judged once at each turning (wayLampHolder), as the lot
// lantern's is: a wick of oil burns; out of oil it dims for a wick; still
// empty, the camp lapses and everything there packs into a crate at Pell's
// (recovery.go): the pieces, the lamp, the plants, the unspent oil and the
// stone of any path laid there, each to whoever it belongs to.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"net/http"
	"slices"
	"strings"

	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/location"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
)

// wayLampKind is a camp's holder kind; the holder id is the camp's.
const wayLampKind = "way-lamp"

// camp is a camp's row, with its lamp's camp-local tile.
type camp struct {
	ID, World, Setter string
	CX, CY            int
	X, Y              int
	Oil               int
	Dimming           bool
}

func scanCamp(row interface{ Scan(...any) error }) (camp, error) {
	var c camp
	err := row.Scan(&c.ID, &c.World, &c.CX, &c.CY, &c.Setter, &c.Oil, &c.Dimming, &c.X, &c.Y)
	return c, err
}

const campSelect = "SELECT c.id,c.world_id,c.cx,c.cy,c.setter,c.oil,c.dimming,i.x,i.y FROM camps c JOIN homestead_items i ON i.id=c.id "

// campByID is a camp of the world by id, or nil.
func campByID(ctx context.Context, tx *sql.Tx, world, id string) (*camp, error) {
	c, err := scanCamp(tx.QueryRowContext(ctx, campSelect+"WHERE c.world_id=? AND c.id=?", world, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &c, err
}

// campAt is the camp in a chunk, or nil.
func campAt(ctx context.Context, tx *sql.Tx, world string, cx, cy int) (*camp, error) {
	c, err := scanCamp(tx.QueryRowContext(ctx, campSelect+"WHERE c.world_id=? AND c.cx=? AND c.cy=?", world, cx, cy))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &c, err
}

// claim is the camp as a Built claim: its setter keeps it (claim_rules.go).
func (c *camp) claim() claimKey { return claimKey{c.World, wayLampKind, c.ID} }

// campBuilder: the account may build at the camp, by its keeper's rule
// (claim_rules.go). Every build at a camp asks this.
func campBuilder(ctx context.Context, tx *sql.Tx, c *camp, account string) (bool, error) {
	return mayBuild(ctx, tx, c.claim(), c.Setter, account)
}

// mayBuildAtCamp is campBuilder as a refusal: not-your-camp.
func mayBuildAtCamp(ctx context.Context, tx *sql.Tx, c *camp, account string) error {
	ok, err := campBuilder(ctx, tx, c, account)
	if err == nil && !ok {
		err = fail(409, "not-your-camp")
	}
	return err
}

// campGround is a camp's held chunk with its ground changes, as the server
// validates building on it (camp-local tiles), or nil when it isn't held.
func (a *Server) campGround(ctx context.Context, tx *sql.Tx, world string, cx, cy int, now int64) (*backland, error) {
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
	return &backland{x0: 0, eff: chunks.NewEffective(m, g)}, nil
}

// campPieces and campPlants are what stands at a camp.
func campPieces(ctx context.Context, tx *sql.Tx, id string) ([]homeInstance, []string, error) {
	rows, err := tx.QueryContext(ctx, "SELECT id,item_def,x,y,rotation,account_id FROM homestead_items WHERE camp_id=? AND location='camp' ORDER BY id", id)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out, owners := []homeInstance{}, []string{}
	for rows.Next() {
		var v homeInstance
		var x, y, rot int
		var owner string
		if err = rows.Scan(&v.ID, &v.ItemDef, &x, &y, &rot, &owner); err != nil {
			return nil, nil, err
		}
		scene := "camp"
		v.Scene, v.X, v.Y, v.Rotation = &scene, &x, &y, &rot
		out = append(out, v)
		owners = append(owners, owner)
	}
	return out, owners, rows.Err()
}

type campPlant struct {
	ID, Def, Owner string
	X, Y           int
	At, Day        int64
}

func campPlants(ctx context.Context, tx *sql.Tx, id string) ([]campPlant, error) {
	rows, err := tx.QueryContext(ctx, "SELECT id,item_def,account_id,x,y,planted_at,planted_day FROM camp_plants WHERE camp_id=? ORDER BY planted_at,id", id)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []campPlant{}
	for rows.Next() {
		var p campPlant
		if err = rows.Scan(&p.ID, &p.Def, &p.Owner, &p.X, &p.Y, &p.At, &p.Day); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// campView is a camp as the caller sees it.
func campView(ctx context.Context, tx *sql.Tx, c *camp, caller string) (*contract.CampView, error) {
	S := chunkSize()
	ox, oy := c.CX*S, c.CY*S
	v := &contract.CampView{Id: c.ID, Cx: int32(c.CX), Cy: int32(c.CY), X: int32(ox + c.X), Y: int32(oy + c.Y), SetterId: c.Setter, Oil: int32(c.Oil), Dimming: c.Dimming, Pieces: []*contract.CampPiece{}, Plants: []*contract.CampPlant{}}
	var name string
	if err := tx.QueryRowContext(ctx, "SELECT display_name FROM players WHERE account_id=?", c.Setter).Scan(&name); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	v.SetterName = capDonor(name)
	var err error
	if v.Builder, err = campBuilder(ctx, tx, c, caller); err != nil {
		return nil, err
	}
	if v.Naming, err = lampNaming(ctx, tx, c.World, c.ID); err != nil {
		return nil, err
	}
	if caller == c.Setter {
		r, err := readClaimRule(ctx, tx, c.claim())
		if err != nil {
			return nil, err
		}
		v.Rule = r.Rule
		if v.Members, err = campMembers(ctx, tx, c.World, r.Listed); err != nil {
			return nil, err
		}
	}
	pieces, owners, err := campPieces(ctx, tx, c.ID)
	if err != nil {
		return nil, err
	}
	for i, p := range pieces {
		v.Pieces = append(v.Pieces, &contract.CampPiece{Id: p.ID, ItemDef: p.ItemDef, X: int32(ox + *p.X), Y: int32(oy + *p.Y), Rotation: int32(*p.Rotation), OwnerId: owners[i]})
	}
	plants, err := campPlants(ctx, tx, c.ID)
	if err != nil {
		return nil, err
	}
	for _, p := range plants {
		v.Plants = append(v.Plants, &contract.CampPlant{Id: p.ID, ItemDef: p.Def, X: int32(ox + p.X), Y: int32(oy + p.Y), PlantedAt: float64(p.At), PlantedDay: float64(p.Day), OwnerId: p.Owner})
	}
	return v, nil
}

// campMembers are the named accounts with their names, in order.
func campMembers(ctx context.Context, tx *sql.Tx, world string, ids []string) ([]*contract.CampMember, error) {
	out := make([]*contract.CampMember, 0, len(ids))
	for _, id := range ids {
		var name string
		if err := tx.QueryRowContext(ctx, "SELECT display_name FROM players WHERE account_id=? AND world_id=?", id, world).Scan(&name); err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		out = append(out, &contract.CampMember{AccountId: id, Name: capDonor(name)})
	}
	return out, nil
}

// worldPeople are the world's members but one, by name: whom a keeper may
// name in a camp's rule.
func worldPeople(ctx context.Context, tx *sql.Tx, world, but string) ([]*contract.CampMember, error) {
	rows, err := tx.QueryContext(ctx, "SELECT account_id,display_name FROM players WHERE world_id=? AND account_id<>? ORDER BY display_name COLLATE NOCASE,account_id", world, but)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*contract.CampMember{}
	for rows.Next() {
		var id, name string
		if err = rows.Scan(&id, &name); err != nil {
			return nil, err
		}
		out = append(out, &contract.CampMember{AccountId: id, Name: capDonor(name)})
	}
	return out, rows.Err()
}

// turnWick makes the current wick epoch if it isn't yet: past a turning,
// that is the turning, which judges every hold (store/holds.go) before a
// camp is read or changed.
func (a *Server) turnWick(ctx context.Context, tx *sql.Tx, world string, now int64) error {
	if a.Config.Epochs == nil {
		return store.ErrGeneratorUnavailable
	}
	_, err := chunks.Epoch(ctx, tx, a.Config.Epochs, world, store.EpochWick, now)
	return chunkError(err)
}

// campsRead is GET /api/camps: the world's camps.
func (a *Server) campsRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	if err = a.turnWick(ctx, tx, s.WorldID, a.requestTime(ctx).Unix()); err != nil {
		return err
	}
	rows, err := tx.QueryContext(ctx, campSelect+"WHERE c.world_id=? ORDER BY c.cy,c.cx", s.WorldID)
	if err != nil {
		return err
	}
	all := []camp{}
	for rows.Next() {
		c, err := scanCamp(rows)
		if err != nil {
			rows.Close()
			return err
		}
		all = append(all, c)
	}
	if err = closeRows(rows); err != nil {
		return err
	}
	out := &contract.CampsRead{Camps: []*contract.CampView{}, People: []*contract.CampMember{}}
	keeper := false
	for i := range all {
		v, err := campView(ctx, tx, &all[i], s.AccountID)
		if err != nil {
			return err
		}
		out.Camps = append(out.Camps, v)
		keeper = keeper || all[i].Setter == s.AccountID
	}
	if keeper {
		if out.People, err = worldPeople(ctx, tx, s.WorldID, s.AccountID); err != nil {
			return err
		}
	}
	return a.finishRead(w, r, tx, s, out)
}

// campOp is POST /api/camps: set, fill, place, remove, plant, uproot,
// name, rule or pack (camp_teardown.go).
func (a *Server) campOp(w http.ResponseWriter, r *http.Request) error {
	req := &contract.CampRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := a.turnWick(ctx, tx, s.WorldID, now); err != nil {
			return nil, err
		}
		var c *camp
		var given []string
		var err error
		switch req.Action {
		case "set":
			c, err = a.setWayLamp(ctx, tx, s, req, now)
		case "fill":
			c, err = a.fillWayLamp(ctx, tx, s, req, now)
		case "place", "plant":
			c, err = a.buildAtCamp(ctx, tx, s, req, now)
		case "remove":
			c, err = a.removeFromCamp(ctx, tx, s, req, now)
		case "name":
			c, given, err = a.nameCamp(ctx, tx, s, req, now)
		case "rule":
			c, err = setCampRule(ctx, tx, s, req, now)
		case "uproot":
			c, err = uprootCampPlant(ctx, tx, s, req, now)
		case "pack":
			err = a.packUpCamp(ctx, tx, s, req, now)
		default:
			err = fail(400, "invalid-request")
		}
		if err != nil {
			return nil, err
		}
		out := &contract.CampResult{Given: given}
		if c != nil {
			if c, err = campByID(ctx, tx, s.WorldID, c.ID); err != nil {
				return nil, err
			}
			if out.Camp, err = campView(ctx, tx, c, s.AccountID); err != nil {
				return nil, err
			}
		}
		if err = refreshItems(ctx, tx, s); err != nil {
			return nil, err
		}
		out.Materials, err = materialsProto(ctx, tx, s.AccountID)
		return out, err
	})
}

// carriedPiece is a home piece in the caller's pack, or item-not-owned.
func carriedPiece(ctx context.Context, tx *sql.Tx, account, id string) (string, error) {
	var def string
	err := tx.QueryRowContext(ctx, "SELECT item_def FROM homestead_items WHERE id=? AND account_id=? AND location='inventory'", id, account).Scan(&def)
	if errors.Is(err, sql.ErrNoRows) {
		return "", fail(404, "item-not-owned")
	}
	return def, err
}

// campTile is a request's world tile as its chunk and camp-local tile.
func campTile(x, y int32) (cx, cy, lx, ly int) {
	S := chunkSize()
	cx, cy = wilds.FloorDiv(int(x), S), wilds.FloorDiv(int(y), S)
	return cx, cy, int(x) - cx*S, int(y) - cy*S
}

// takeOil pours a flask of the lamp's oil from the pack.
func takeOil(ctx context.Context, tx *sql.Tx, account, ref string, now int64) error {
	oil := content.HomeRules.GetWayLamp().GetOil()
	if n, err := stackTotal(ctx, tx, packOf(account), oil); err != nil {
		return err
	} else if n < 1 {
		return fail(409, "insufficient-materials")
	}
	_, err := packTake(ctx, tx, account, oil, nil, 1, "way-lamp", ref, now)
	return err
}

// setWayLamp sets a carried way-lamp at a tile with its first flask of oil:
// the chunk becomes a camp, held as it stands this wick. Not on a lot's
// backland (its lantern's), the town, the Tangle or another camp. Setting
// a Built way-lamp takes the Keeper's hand (lamps.md 2.8); a communal post
// takes nothing, and camps set before stand as they are.
func (a *Server) setWayLamp(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CampRequest, now int64) (*camp, error) {
	rules := content.HomeRules.GetWayLamp()
	if !questHasMark(s, keeperHand) {
		return nil, fail(409, "needs-keeper")
	}
	def, err := carriedPiece(ctx, tx, s.AccountID, req.ItemId)
	if err != nil {
		return nil, err
	}
	if def != rules.GetItem() {
		return nil, fail(409, "invalid-item")
	}
	if !nearTile(s, outdoorsArea, int(req.X), int(req.Y), int(rules.GetReach())) {
		return nil, fail(409, "too-far-away")
	}
	cx, cy, lx, ly := campTile(req.X, req.Y)
	if chunks.BacklandAt(cx, cy) >= 0 || location.SourceOf(cx, cy).Kind != location.SourceGenerated {
		return nil, fail(409, "cannot-hold")
	}
	held, ok := a.Config.Epochs.(*store.Chunks)
	if !ok {
		return nil, fail(409, "cannot-hold")
	}
	if _, err = held.Hold(ctx, tx, s.WorldID, int32(cx), int32(cy), wayLampKind, req.ItemId, now); errors.Is(err, store.ErrHeld) || errors.Is(err, store.ErrNotHoldable) {
		return nil, fail(409, "cannot-hold")
	} else if err != nil {
		return nil, chunkError(err)
	}
	// Holding it again takes back a hold this lamp let go this wick (taken
	// down); a camp still standing there is another lamp's.
	if c, err := campAt(ctx, tx, s.WorldID, cx, cy); err != nil || c != nil {
		if err == nil {
			err = fail(409, "cannot-hold")
		}
		return nil, err
	}
	g, err := a.campGround(ctx, tx, s.WorldID, cx, cy, now)
	if err != nil {
		return nil, err
	}
	if g == nil || !g.buildable(lx, ly) {
		return nil, fail(409, "land-blocked")
	}
	if err = takeOil(ctx, tx, s.AccountID, req.ItemId, now); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO camps(id,world_id,cx,cy,setter,oil,dimming,set_at) VALUES(?,?,?,?,?,?,0,?)", req.ItemId, s.WorldID, cx, cy, s.AccountID, rules.GetWicksPerOil(), now); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE homestead_items SET location='camp',camp_id=?,scene='camp',x=?,y=?,rotation=0 WHERE id=?", req.ItemId, lx, ly, req.ItemId); err != nil {
		return nil, err
	}
	if err = currency(ctx, tx, s.AccountID, "decoration:"+def, -1, "camp-set", req.ItemId, now); err != nil {
		return nil, err
	}
	return &camp{ID: req.ItemId}, nil
}

// fillWayLamp pours a flask into a camp's lamp: anyone's, from beside it.
func (a *Server) fillWayLamp(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CampRequest, now int64) (*camp, error) {
	rules := content.HomeRules.GetWayLamp()
	c, err := campByID(ctx, tx, s.WorldID, req.Camp)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, fail(404, "no-camp")
	}
	S := chunkSize()
	if !nearTile(s, outdoorsArea, c.CX*S+c.X, c.CY*S+c.Y, int(rules.GetReach())) {
		return nil, fail(409, "too-far-away")
	}
	if c.Oil+int(rules.GetWicksPerOil()) > int(rules.GetMaxWicks()) {
		return nil, fail(409, "lantern-full")
	}
	if err = takeOil(ctx, tx, s.AccountID, c.ID, now); err != nil {
		return nil, err
	}
	_, err = tx.ExecContext(ctx, "UPDATE camps SET oil=oil+?,dimming=0 WHERE id=?", rules.GetWicksPerOil(), c.ID)
	return c, err
}

// buildAtCamp sets a carried piece out, or plants a seed, at a camp the
// caller may build at: on open land of its held chunk, in reach, clear of
// what stands there.
func (a *Server) buildAtCamp(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CampRequest, now int64) (*camp, error) {
	rules := content.HomeRules.GetWayLamp()
	cx, cy, lx, ly := campTile(req.X, req.Y)
	c, err := campAt(ctx, tx, s.WorldID, cx, cy)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, fail(409, "no-camp")
	}
	if err = mayBuildAtCamp(ctx, tx, c, s.AccountID); err != nil {
		return nil, err
	}
	if !nearTile(s, outdoorsArea, int(req.X), int(req.Y), int(rules.GetReach())) {
		return nil, fail(409, "too-far-away")
	}
	here := rect{lx, ly, 1, 1}
	var def string
	if req.Action == "place" {
		if def, err = carriedPiece(ctx, tx, s.AccountID, req.ItemId); err != nil {
			return nil, err
		}
		d, ok := content.HomeItemFor(def)
		rot := int(req.Rotation)
		if !ok || !slices.Contains(d.GetWhere(), "outdoor") || def == content.HomeRules.GetLanternPosts().GetItem() || def == stableItemID() || !slices.Contains([]int{0, 90, 180, 270}, rot) {
			return nil, fail(400, "invalid-placement")
		}
		w, h := footprint(homeInstance{ItemDef: def}, rot)
		here = rect{lx, ly, w, h}
		if here.x+w > chunkSize() || here.y+h > chunkSize() {
			return nil, fail(409, "out-of-bounds")
		}
	} else {
		def = req.ItemDef
		if !content.IsGatheringSeed(def) {
			return nil, fail(400, "not-a-seed")
		}
	}
	g, err := a.campGround(ctx, tx, s.WorldID, cx, cy, now)
	if err != nil {
		return nil, err
	}
	for y := here.y; y < here.y+here.h; y++ {
		for x := here.x; x < here.x+here.w; x++ {
			if g == nil || !g.buildable(x, y) {
				return nil, fail(409, "land-blocked")
			}
		}
	}
	pieces, _, err := campPieces(ctx, tx, c.ID)
	if err != nil {
		return nil, err
	}
	for _, v := range pieces {
		if r, ok := placedRect(v); ok && r.overlaps(here) {
			return nil, fail(409, "placement-overlap")
		}
	}
	plants, err := campPlants(ctx, tx, c.ID)
	if err != nil {
		return nil, err
	}
	for _, p := range plants {
		if here.overlaps(rect{p.X, p.Y, 1, 1}) {
			return nil, fail(409, "plant-in-the-way")
		}
	}
	if req.Action == "plant" {
		if len(plants) >= int(content.GatheringRules.GetPlantsPerHome()) {
			return nil, fail(409, "land-blocked")
		}
		if _, err = packTake(ctx, tx, s.AccountID, def, nil, 1, "camp-plant", c.ID, now); err != nil {
			return nil, err
		}
		id, err := store.Random()
		if err != nil {
			return nil, err
		}
		_, err = tx.ExecContext(ctx, "INSERT INTO camp_plants(id,camp_id,account_id,item_def,x,y,planted_at,planted_day) VALUES(?,?,?,?,?,?,?,?)", id, c.ID, s.AccountID, def, lx, ly, now, utcDay(now))
		return c, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE homestead_items SET location='camp',camp_id=?,scene='camp',x=?,y=?,rotation=? WHERE id=? AND location='inventory' AND account_id=?", c.ID, lx, ly, req.Rotation, req.ItemId, s.AccountID); err != nil {
		return nil, err
	}
	return c, currency(ctx, tx, s.AccountID, "decoration:"+def, -1, "camp-place", req.ItemId, now)
}

// removeFromCamp picks up a piece of the caller's from a camp, into their
// pack, whatever the rule. The keeper may also move anyone else's
// piece off: it goes to its owner's crate at Pell's, still theirs. The lamp
// comes down only when nothing else stands there: with it go the camp, its
// unspent oil (back to the setter), its rule and, at the turning, the hold.
func (a *Server) removeFromCamp(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CampRequest, now int64) (*camp, error) {
	var campID, def, owner string
	var x, y, rot int
	err := tx.QueryRowContext(ctx, "SELECT i.camp_id,i.item_def,i.account_id,i.x,i.y,i.rotation FROM homestead_items i JOIN camps c ON c.id=i.camp_id WHERE i.id=? AND i.location='camp' AND c.world_id=?", req.ItemId, s.WorldID).Scan(&campID, &def, &owner, &x, &y, &rot)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, fail(409, "not-placed")
	}
	if err != nil {
		return nil, err
	}
	c, err := campByID(ctx, tx, s.WorldID, campID)
	if err != nil {
		return nil, err
	}
	// Taking your own things back isn't building: never refused by the
	// rule. Anyone else's is the keeper's to move.
	if owner != s.AccountID && s.AccountID != c.Setter {
		return nil, fail(409, "item-not-owned")
	}
	S := chunkSize()
	if !nearTile(s, outdoorsArea, c.CX*S+x, c.CY*S+y, int(content.HomeRules.GetWayLamp().GetReach())) {
		return nil, fail(409, "too-far-away")
	}
	if owner != s.AccountID {
		return c, crateCampPiece(ctx, tx, c, req.ItemId, def, owner, x, y, rot, now)
	}
	lamp := req.ItemId == c.ID
	if lamp {
		var others int
		if err = tx.QueryRowContext(ctx, "SELECT (SELECT count(*) FROM homestead_items WHERE camp_id=? AND id<>?)+(SELECT count(*) FROM camp_plants WHERE camp_id=?)", c.ID, c.ID, c.ID).Scan(&others); err != nil {
			return nil, err
		}
		if others > 0 {
			return nil, fail(409, "camp-not-empty")
		}
	}
	if _, err = tx.ExecContext(ctx, "UPDATE homestead_items SET location='inventory',camp_id=NULL,scene=NULL,x=NULL,y=NULL,rotation=NULL WHERE id=?", req.ItemId); err != nil {
		return nil, err
	}
	if err = currency(ctx, tx, s.AccountID, "decoration:"+def, 1, "camp-remove", req.ItemId, now); err != nil {
		return nil, err
	}
	if !lamp {
		return c, nil
	}
	if flasks := c.Oil / int(content.HomeRules.GetWayLamp().GetWicksPerOil()); flasks > 0 {
		if err = packPut(ctx, tx, c.Setter, content.HomeRules.GetWayLamp().GetOil(), []makerQty{{Qty: flasks}}, "camp-remove", c.ID, now); err != nil {
			return nil, err
		}
	}
	if err = dropCamp(ctx, tx, c); err != nil {
		return nil, err
	}
	if held, ok := a.Config.Epochs.(*store.Chunks); ok {
		if _, err = held.Release(ctx, tx, s.WorldID, int32(c.CX), int32(c.CY), wayLampKind, c.ID, now); err != nil {
			return nil, err
		}
	}
	return nil, nil
}

// campBuilderAt: in a camp's chunk only those who may build there change
// its ground (clear, lay, lift); elsewhere anyone may.
func (a *Server) campBuilderAt(ctx context.Context, tx *sql.Tx, s *store.Snapshot, cx, cy int) error {
	c, err := campAt(ctx, tx, s.WorldID, cx, cy)
	if err != nil || c == nil {
		return err
	}
	return mayBuildAtCamp(ctx, tx, c, s.AccountID)
}

// setCampRule is the keeper's: who may build at their camp, from anywhere.
func setCampRule(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CampRequest, now int64) (*camp, error) {
	c, err := campByID(ctx, tx, s.WorldID, req.Camp)
	if err != nil {
		return nil, err
	}
	if c == nil {
		return nil, fail(404, "no-camp")
	}
	if c.Setter != s.AccountID {
		return nil, fail(409, "not-your-lamp")
	}
	return c, setClaimRule(ctx, tx, c.claim(), c.Setter, req.Rule, req.Members, now)
}

// dropCamp ends a camp: its row and its rule.
func dropCamp(ctx context.Context, tx *sql.Tx, c *camp) error {
	if err := dropClaimRule(ctx, tx, c.claim()); err != nil {
		return err
	}
	_, err := tx.ExecContext(ctx, "DELETE FROM camps WHERE id=?", c.ID)
	return err
}

// crateCampPiece moves someone's piece off a camp into their own entry in
// a crate at Pell's, the same instance where it stood. Its state names the
// keeper who moved it (movedBy), so Pell can say so.
func crateCampPiece(ctx context.Context, tx *sql.Tx, c *camp, id, def, owner string, x, y, rot int, now int64) error {
	crate, err := recoveryCrate(ctx, tx, c.World, "camp:"+c.ID, c.CX, c.CY, now)
	if err != nil {
		return err
	}
	state, _ := json.Marshal(map[string]any{"x": x, "y": y, "rotation": rot, "movedBy": c.Setter})
	if err = addRecoveryEntry(ctx, tx, crate, owner, "piece", def, 1, id, string(state)); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "UPDATE homestead_items SET location='crate',camp_id=NULL,scene=NULL,x=NULL,y=NULL,rotation=NULL WHERE id=?", id)
	return err
}

// wayLampHolder judges camps at the turning (roadmap rule 4).
type wayLampHolder struct{}

// Keeps burns a wick of oil; with none left a lit lamp dims for one wick
// (a full wick of warning); dimming and still empty, the camp lapses.
func (wayLampHolder) Keeps(ctx context.Context, tx *sql.Tx, h store.Hold, now int64) (bool, error) {
	var oil int
	var dimming bool
	err := tx.QueryRowContext(ctx, "SELECT oil,dimming FROM camps WHERE id=? AND world_id=?", h.HolderID, h.World).Scan(&oil, &dimming)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	switch {
	case oil >= 1:
		_, err = tx.ExecContext(ctx, "UPDATE camps SET oil=oil-1,dimming=0 WHERE id=?", h.HolderID)
		return true, err
	case !dimming:
		_, err = tx.ExecContext(ctx, "UPDATE camps SET dimming=1 WHERE id=?", h.HolderID)
		return true, err
	}
	return false, nil
}

// Released: the camp has lapsed and its chunk turns. Nothing a player
// placed is lost (roadmap rule 3): it all packs into a crate at Pell's.
func (wayLampHolder) Released(ctx context.Context, tx *sql.Tx, h store.Hold, now int64) error {
	return packCamp(ctx, tx, h, false, now)
}

// packCamp packs a lapsed camp into one crate at Pell's, in the turning's
// transaction, before its chunk turns: every piece (the lamp too) as the
// same instance, every plant with its planting kept (its seed to collect),
// the unspent oil to the lamp's setter, and each laid path tile's stone or
// plank to whoever laid it. Then the camp is gone. A hold released with no
// camp left (its lamp taken down, or the camp packed up) still refunds its
// paths. packedUp: its keeper packed it up (camp_teardown.go), not a lapse:
// the paths wait for the turning, and what was someone else's names the
// keeper who moved it off (movedBy), as crateCampPiece does.
func packCamp(ctx context.Context, tx *sql.Tx, h store.Hold, packedUp bool, now int64) error {
	type entry struct {
		account, kind, def string
		qty                int
		instance           any
		state              string
	}
	entries := []entry{}
	stacks := map[[2]string]int{}
	var c *camp
	if v, err := campByID(ctx, tx, h.World, h.HolderID); err != nil {
		return err
	} else if v != nil {
		c = v
	}
	if c != nil {
		pieces, owners, err := campPieces(ctx, tx, c.ID)
		if err != nil {
			return err
		}
		for i, p := range pieces {
			st := map[string]any{"x": *p.X, "y": *p.Y, "rotation": *p.Rotation}
			if packedUp && owners[i] != c.Setter {
				st["movedBy"] = c.Setter
			}
			state, _ := json.Marshal(st)
			entries = append(entries, entry{owners[i], "piece", p.ItemDef, 1, p.ID, string(state)})
		}
		plants, err := campPlants(ctx, tx, c.ID)
		if err != nil {
			return err
		}
		for _, p := range plants {
			st := map[string]any{"id": p.ID, "x": p.X, "y": p.Y, "plantedAt": p.At, "plantedDay": p.Day}
			if packedUp && p.Owner != c.Setter {
				st["movedBy"] = c.Setter
			}
			state, _ := json.Marshal(st)
			entries = append(entries, entry{p.Owner, "plant", p.Def, 1, nil, string(state)})
		}
		if flasks := c.Oil / int(content.HomeRules.GetWayLamp().GetWicksPerOil()); flasks > 0 {
			stacks[[2]string{c.Setter, content.HomeRules.GetWayLamp().GetOil()}] += flasks
		}
	}
	if !packedUp {
		g, err := groundChanges(ctx, tx, h.World, &contract.WildsEpoch{Id: h.Epoch}, int(h.CX), int(h.CY), now)
		if err != nil {
			return err
		}
		for _, ch := range g.GetChanges() {
			if lay := chunks.LayKind(ch.Change); lay != nil && ch.By != "" {
				stacks[[2]string{ch.By, lay.GetMaterial()}] += int(lay.GetCost())
			}
		}
	}
	var err error
	keys := make([][2]string, 0, len(stacks))
	for k := range stacks {
		keys = append(keys, k)
	}
	slices.SortFunc(keys, func(a, b [2]string) int {
		if a[0] != b[0] {
			return strings.Compare(a[0], b[0])
		}
		return strings.Compare(a[1], b[1])
	})
	for _, k := range keys {
		var known bool
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM players WHERE account_id=?)", k[0]).Scan(&known); err != nil {
			return err
		}
		if known {
			entries = append(entries, entry{k[0], "stack", k[1], stacks[k], nil, "{}"})
		}
	}
	if len(entries) > 0 {
		crate, err := recoveryCrate(ctx, tx, h.World, "camp:"+h.HolderID, int(h.CX), int(h.CY), now)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if err = addRecoveryEntry(ctx, tx, crate, e.account, e.kind, e.def, e.qty, e.instance, e.state); err != nil {
				return err
			}
		}
	}
	if c == nil {
		return nil
	}
	if _, err = tx.ExecContext(ctx, "UPDATE homestead_items SET location='crate',camp_id=NULL,scene=NULL,x=NULL,y=NULL,rotation=NULL WHERE camp_id=?", c.ID); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM camp_plants WHERE camp_id=?", c.ID); err != nil {
		return err
	}
	return dropCamp(ctx, tx, c)
}
