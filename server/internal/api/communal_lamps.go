package api

// Communal lamps (roadmap 0.13; lamps.md 1.1, 1.3, 2.4): Common light, a
// public rest and wayfinding light that claims no land around it. Anyone may
// relight a dark lamp stone of the Lantern Road, burning a lamp wick (content
// communalLamp), or set a way-lamp as a communal post, with no oil, store or
// deposit. Neither needs the Keeper's hand.
//
// Presence keeps them, never oil (common_ways.go): a lamp whose chunk
// somebody stood in during the wick stays lit through the turning. One
// nobody came to turns: a relit stone goes dark again (its wick was burnt,
// as oil is), and a post waits for whoever set it in a crate at Pell's, the
// same piece, so nothing is lost. Each operation visits the lamp's chunk in
// its own transaction, even from across a seam.
//
// Nobody takes down another player's post; its setter may lift it. A lamp's
// id is stable for its life and through recovery (a stone's is its road
// site's, a post's its piece's), so the Keeper's naming (lamp_namings) finds
// it again.

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"

	"glimway/content"
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

// commonLampKind is a communal lamp's mark on the map (map_tiers.go).
const commonLampKind = "common-lamp"

// The kinds of communal lamp.
const (
	lampStone = "stone"
	lampPost  = "post"
)

// communalLamp is a lit communal lamp's row (x, y chunk-local).
type communalLamp struct {
	ID, World, Kind, Setter string
	CX, CY, X, Y            int
	LitAt                   int64
}

const communalLampSelect = "SELECT id,world_id,kind,cx,cy,x,y,setter,lit_at FROM communal_lamps "

func scanCommunalLamp(row interface{ Scan(...any) error }) (communalLamp, error) {
	var l communalLamp
	err := row.Scan(&l.ID, &l.World, &l.Kind, &l.CX, &l.CY, &l.X, &l.Y, &l.Setter, &l.LitAt)
	return l, err
}

// communalLampByID is a lit lamp of the world, or nil.
func communalLampByID(ctx context.Context, tx *sql.Tx, world, id string) (*communalLamp, error) {
	l, err := scanCommunalLamp(tx.QueryRowContext(ctx, communalLampSelect+"WHERE world_id=? AND id=?", world, id))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	return &l, err
}

// communalLamps are the world's lit lamps.
func communalLamps(ctx context.Context, tx *sql.Tx, world string) ([]communalLamp, error) {
	rows, err := tx.QueryContext(ctx, communalLampSelect+"WHERE world_id=? ORDER BY cy,cx,y,x", world)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []communalLamp{}
	for rows.Next() {
		l, err := scanCommunalLamp(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, l)
	}
	return out, rows.Err()
}

// displayName is an account's display name, capped, or "" when it's gone.
func displayName(ctx context.Context, tx *sql.Tx, account string) (string, error) {
	var name string
	if err := tx.QueryRowContext(ctx, "SELECT display_name FROM players WHERE account_id=?", account).Scan(&name); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return "", err
	}
	return capDonor(name), nil
}

// lampNaming is a lamp's naming, or nil while it has none (lamps.md 2.8).
func lampNaming(ctx context.Context, tx *sql.Tx, world, id string) (*contract.LampNaming, error) {
	var parts, landmark, text, short string
	var namer sql.NullString
	var at int64
	err := tx.QueryRowContext(ctx, "SELECT parts,landmark,text,short_name,namer,named_at FROM lamp_namings WHERE world_id=? AND lamp_id=?", world, id).Scan(&parts, &landmark, &text, &short, &namer, &at)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	n := &contract.LampNaming{Parts: []string{}, Landmark: landmark, Text: text, ShortName: short, NamerId: namer.String, NamedAt: float64(at)}
	if err = json.Unmarshal([]byte(parts), &n.Parts); err != nil {
		return nil, err
	}
	if namer.Valid {
		if n.NamerName, err = displayName(ctx, tx, namer.String); err != nil {
			return nil, err
		}
	}
	return n, nil
}

// communalLampView is a lamp as the wire shows it, in world tiles.
func communalLampView(ctx context.Context, tx *sql.Tx, l *communalLamp, now int64) (*contract.CommunalLampView, error) {
	S := chunkSize()
	v := &contract.CommunalLampView{Id: l.ID, Kind: l.Kind, Cx: int32(l.CX), Cy: int32(l.CY), X: int32(l.CX*S + l.X), Y: int32(l.CY*S + l.Y), SetterId: l.Setter, LitAt: float64(l.LitAt)}
	var err error
	if v.SetterName, err = displayName(ctx, tx, l.Setter); err != nil {
		return nil, err
	}
	if v.Visited, err = store.Visited(ctx, tx, l.World, l.CX, l.CY, now); err != nil {
		return nil, err
	}
	v.Naming, err = lampNaming(ctx, tx, l.World, l.ID)
	return v, err
}

// communalLampsRead is GET /api/communal-lamps: the world's lit lamps.
func (a *Server) communalLampsRead(w http.ResponseWriter, r *http.Request) error {
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
	all, err := communalLamps(ctx, tx, s.WorldID)
	if err != nil {
		return err
	}
	out := &contract.CommunalLampsRead{Lamps: []*contract.CommunalLampView{}}
	for i := range all {
		v, err := communalLampView(ctx, tx, &all[i], now)
		if err != nil {
			return err
		}
		out.Lamps = append(out.Lamps, v)
	}
	return a.finishRead(w, r, tx, s, out)
}

// communalLampOp is POST /api/communal-lamps: relight, tend, post or lift.
func (a *Server) communalLampOp(w http.ResponseWriter, r *http.Request) error {
	req := &contract.CommunalLampRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := a.turnWick(ctx, tx, s.WorldID, now); err != nil {
			return nil, err
		}
		var l *communalLamp
		var err error
		switch req.Action {
		case "relight":
			l, err = a.relightStone(ctx, tx, s, req, now)
		case "tend":
			l, err = tendLamp(ctx, tx, s, req, now)
		case "post":
			l, err = a.setCommunalPost(ctx, tx, s, req, now)
		case "lift":
			err = liftCommunalPost(ctx, tx, s, req, now)
		default:
			err = fail(400, "invalid-request")
		}
		if err != nil {
			return nil, err
		}
		out := &contract.CommunalLampResult{}
		if l != nil {
			if l, err = communalLampByID(ctx, tx, s.WorldID, l.ID); err != nil {
				return nil, err
			}
			if out.Lamp, err = communalLampView(ctx, tx, l, now); err != nil {
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

// nearLamp: the caller stands within the communal reach of a lamp's tile.
func nearLamp(s *store.Snapshot, cx, cy, x, y int) bool {
	S := chunkSize()
	return nearTile(s, outdoorsArea, cx*S+x, cy*S+y, int(content.HomeRules.GetCommunalLamp().GetReach()))
}

// wickChunk is a Common chunk's land this wick, with its ground changes.
func (a *Server) wickChunk(ctx context.Context, tx *sql.Tx, world string, cx, cy int, now int64) (*chunks.Effective, error) {
	e, err := a.epochAt(ctx, tx, world, cx, cy, now)
	if err != nil {
		return nil, chunkError(err)
	}
	m, err := a.Config.Chunks.Chunk(ctx, tx, world, e.Id, 0, int32(cx), int32(cy))
	if err != nil {
		return nil, chunkError(err)
	}
	g, err := groundChanges(ctx, tx, world, e, cx, cy, now)
	if err != nil {
		return nil, err
	}
	eff := chunks.NewEffective(m, g)
	return &eff, nil
}

// relightStone lights a dark lamp stone of the Lantern Road, anyone's to
// light, for the wick it burns. A stone stands only in a Common chunk.
func (a *Server) relightStone(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CommunalLampRequest, now int64) (*communalLamp, error) {
	var cx, cy int
	if n, _ := fmt.Sscanf(req.Lamp, "lamp-stone:%d:%d", &cx, &cy); n != 2 || req.Lamp != fmt.Sprintf("lamp-stone:%d:%d", cx, cy) || !visitable(s.WorldID, cx, cy) {
		return nil, fail(404, "no-lamp")
	}
	land, err := a.wickChunk(ctx, tx, s.WorldID, cx, cy, now)
	if err != nil {
		return nil, err
	}
	var site *contract.StorySite
	for _, v := range land.Chunk.Sites {
		if v.Id == req.Lamp && v.Kind == contract.SiteKind_SITE_KIND_LAMP_STONE {
			site = v
		}
	}
	if site == nil {
		return nil, fail(404, "no-lamp")
	}
	if !nearLamp(s, cx, cy, int(site.Tx), int(site.Ty)) {
		return nil, fail(409, "too-far-away")
	}
	if lit, err := communalLampByID(ctx, tx, s.WorldID, req.Lamp); err != nil || lit != nil {
		if err == nil {
			err = fail(409, "lamp-lit")
		}
		return nil, err
	}
	rules := content.HomeRules.GetCommunalLamp()
	if qty := int(rules.GetRelightQty()); qty > 0 {
		if n, err := stackTotal(ctx, tx, packOf(s.AccountID), rules.GetRelight()); err != nil {
			return nil, err
		} else if n < qty {
			return nil, fail(409, "insufficient-materials")
		}
		if _, err = packTake(ctx, tx, s.AccountID, rules.GetRelight(), nil, qty, "lamp-relight", req.Lamp, now); err != nil {
			return nil, err
		}
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO communal_lamps(world_id,id,kind,cx,cy,x,y,setter,lit_at) VALUES(?,?,?,?,?,?,?,?,?)", s.WorldID, req.Lamp, lampStone, cx, cy, site.Tx, site.Ty, s.AccountID, now); err != nil {
		return nil, err
	}
	return &communalLamp{ID: req.Lamp}, store.Visit(ctx, tx, s.WorldID, cx, cy, now)
}

// tendLamp looks after a lit lamp, anyone's: it visits the lamp's chunk.
func tendLamp(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CommunalLampRequest, now int64) (*communalLamp, error) {
	l, err := communalLampByID(ctx, tx, s.WorldID, req.Lamp)
	if err != nil {
		return nil, err
	}
	if l == nil {
		return nil, fail(404, "no-lamp")
	}
	if !nearLamp(s, l.CX, l.CY, l.X, l.Y) {
		return nil, fail(409, "too-far-away")
	}
	return l, store.Visit(ctx, tx, s.WorldID, l.CX, l.CY, now)
}

// setCommunalPost sets a carried way-lamp as a communal post on open,
// unlaid land of a Common chunk: not held (a lot's backland, a camp), the
// town or the Tangle. No oil goes in.
func (a *Server) setCommunalPost(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CommunalLampRequest, now int64) (*communalLamp, error) {
	def, err := carriedPiece(ctx, tx, s.AccountID, req.ItemId)
	if err != nil {
		return nil, err
	}
	if def != content.HomeRules.GetWayLamp().GetItem() {
		return nil, fail(409, "invalid-item")
	}
	cx, cy, lx, ly := campTile(req.X, req.Y)
	if !nearLamp(s, cx, cy, lx, ly) {
		return nil, fail(409, "too-far-away")
	}
	if !visitable(s.WorldID, cx, cy) || chunks.BacklandAt(cx, cy) >= 0 {
		return nil, fail(409, "not-common")
	}
	if held, err := store.HeldEpoch(ctx, tx, s.WorldID, cx, cy); err != nil || held != nil {
		if err == nil {
			err = fail(409, "not-common")
		}
		return nil, err
	}
	land, err := a.wickChunk(ctx, tx, s.WorldID, cx, cy, now)
	if err != nil {
		return nil, err
	}
	if !(&backland{eff: *land}).buildable(lx, ly) || land.Laid(lx, ly) {
		return nil, fail(409, "land-blocked")
	}
	if taken, err := lampStandsAt(ctx, tx, s.WorldID, cx, cy, lx, ly); err != nil {
		return nil, err
	} else if taken {
		return nil, fail(409, "placement-overlap")
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO communal_lamps(world_id,id,kind,cx,cy,x,y,setter,lit_at) VALUES(?,?,?,?,?,?,?,?,?)", s.WorldID, req.ItemId, lampPost, cx, cy, lx, ly, s.AccountID, now); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE homestead_items SET location='lamp' WHERE id=? AND location='inventory' AND account_id=?", req.ItemId, s.AccountID); err != nil {
		return nil, err
	}
	if err = currency(ctx, tx, s.AccountID, "decoration:"+def, -1, "communal-post", req.ItemId, now); err != nil {
		return nil, err
	}
	return &communalLamp{ID: req.ItemId}, store.Visit(ctx, tx, s.WorldID, cx, cy, now)
}

// liftCommunalPost takes the caller's own post back into their pack.
func liftCommunalPost(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CommunalLampRequest, now int64) error {
	l, err := communalLampByID(ctx, tx, s.WorldID, req.Lamp)
	if err != nil {
		return err
	}
	if l == nil || l.Kind != lampPost {
		return fail(404, "no-lamp")
	}
	if l.Setter != s.AccountID {
		return fail(409, "not-your-lamp")
	}
	if !nearLamp(s, l.CX, l.CY, l.X, l.Y) {
		return fail(409, "too-far-away")
	}
	var def string
	if err = tx.QueryRowContext(ctx, "UPDATE homestead_items SET location='inventory' WHERE id=? AND location='lamp' AND account_id=? RETURNING item_def", l.ID, s.AccountID).Scan(&def); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM communal_lamps WHERE world_id=? AND id=?", s.WorldID, l.ID); err != nil {
		return err
	}
	if err = currency(ctx, tx, s.AccountID, "decoration:"+def, 1, "communal-lift", l.ID, now); err != nil {
		return err
	}
	return store.Visit(ctx, tx, s.WorldID, l.CX, l.CY, now)
}

// turnLamps judges the world's communal lamps at the turning (from
// commonWays.Turn), before the ended wick's visits are trimmed. A lamp in a
// chunk whose hold lapsed now turns with its land; one inside a standing
// hold is under that claim's upkeep and stays; any other stays lit if its
// chunk was visited through every wick since it was last judged. A kept
// post must still stand on the new wick's land (generated land, nothing on
// its tile), or it goes to Pell's like one that turned.
func (c commonWays) turnLamps(ctx context.Context, tx *sql.Tx, world string, ended, next *contract.WildsEpoch, gone map[[2]int]bool, now int64) error {
	lamps, err := communalLamps(ctx, tx, world)
	if err != nil {
		return err
	}
	for i := range lamps {
		l := &lamps[i]
		keep := false
		if !gone[[2]int{l.CX, l.CY}] {
			held, err := store.HeldEpoch(ctx, tx, world, l.CX, l.CY)
			if err != nil {
				return err
			}
			if keep = held != nil; !keep {
				from := l.LitAt
				if ended != nil && int64(ended.StartsAt) > from {
					from = int64(ended.StartsAt)
				}
				if keep, err = store.VisitedThrough(ctx, tx, world, l.CX, l.CY, from, int64(next.StartsAt)); err != nil {
					return err
				}
			}
		}
		if keep && l.Kind == lampPost {
			m, err := c.a.Config.Chunks.Chunk(ctx, tx, world, next.Id, 0, int32(l.CX), int32(l.CY))
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if m == nil {
				keep = false
			} else {
				land := chunks.NewEffective(m, nil)
				keep = carries(&land, l.X, l.Y)
			}
		}
		if keep {
			continue
		}
		if l.Kind == lampPost {
			if err = crateCommunalPost(ctx, tx, l, now); err != nil {
				return err
			}
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM communal_lamps WHERE world_id=? AND id=?", world, l.ID); err != nil {
			return err
		}
	}
	return nil
}

// crateCommunalPost packs a post that turned into a crate at Pell's for its
// setter: the way-lamp piece itself, waiting at location 'crate'.
func crateCommunalPost(ctx context.Context, tx *sql.Tx, l *communalLamp, now int64) error {
	var def string
	err := tx.QueryRowContext(ctx, "UPDATE homestead_items SET location='crate' WHERE id=? AND location='lamp' AND account_id=? RETURNING item_def", l.ID, l.Setter).Scan(&def)
	if errors.Is(err, sql.ErrNoRows) {
		return nil
	}
	if err != nil {
		return err
	}
	crate, err := store.Random()
	if err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "INSERT INTO recovery_crates(id,world_id,source,cx,cy,lapsed_at) VALUES(?,?,?,?,?,?)", crate, l.World, "communal:"+l.ID, l.CX, l.CY, now); err != nil {
		return err
	}
	state, _ := json.Marshal(map[string]int{"x": l.X, "y": l.Y})
	_, err = tx.ExecContext(ctx, "INSERT INTO recovery_entries(crate_id,account_id,kind,item_def,qty,instance_id,state) VALUES(?,?,'piece',?,1,?,?)", crate, l.Setter, def, l.ID, string(state))
	return err
}

// lampStandsAt: a lit communal lamp stands on the chunk-local tile (nothing
// is set or laid there).
func lampStandsAt(ctx context.Context, tx *sql.Tx, world string, cx, cy, x, y int) (bool, error) {
	var taken bool
	err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM communal_lamps WHERE world_id=? AND cx=? AND cy=? AND x=? AND y=?)", world, cx, cy, x, y).Scan(&taken)
	return taken, err
}
