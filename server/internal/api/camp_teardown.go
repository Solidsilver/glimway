package api

// Taking a camp apart (lamps.md 2.5): digging up a plant there, and its
// keeper packing the whole camp up at once. A lamp comes down only from an
// empty camp (removeFromCamp), so without these one planted seed kept a
// camp standing until it lapsed. Digging up takes a trowel, here and on
// home land (digUpPlant; uprootHomePlant in plants.go).

import (
	"context"
	"database/sql"
	"errors"
	"slices"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

// trowelAction is the tool action that digs a planted thing up: the
// trowel's (content/items.json). Nothing else digs a plant up.
const trowelAction = "uproot"

// packTrowel is the trowel a dig wears, the one the belt holds
// (src/lib/belt.ts beltFor): one that still works before a blunt one,
// then the one with the most condition left. "" when none is carried.
func packTrowel(ctx context.Context, tx *sql.Tx, account string) (string, error) {
	rows, err := tx.QueryContext(ctx, "SELECT "+instanceColumns+" FROM item_instances WHERE location='pack' AND owner=? ORDER BY id", account)
	if err != nil {
		return "", err
	}
	defer rows.Close()
	best, bestRank := "", -1
	for rows.Next() {
		v, err := scanInstance(rows)
		if err != nil {
			return "", err
		}
		d, ok := content.ItemFor(v.Def)
		if !ok || d.GetKind() != "tool" || !slices.Contains(d.GetActions(), trowelAction) {
			continue
		}
		// Working tools rank above blunt ones; among them, the keener wins.
		rank := v.Condition
		if v.Max == 0 {
			rank = 1 << 30
		} else if v.Condition > 0 {
			rank += 1 << 20
		}
		if rank > bestRank {
			best, bestRank = v.ID, rank
		}
	}
	return best, rows.Err()
}

// digUpPlant is the end every dig-up shares, at a camp (camp_plants) or on
// home land (homestead_plants): a trowel from the pack is used once (the
// same wear as any tool use: useTool, breaking at zero), and the plant
// comes out of the ground whole, into the digger's pack as a carried plant
// with its id and growth kept (carryPlant), to plant again where they may.
func (a *Server) digUpPlant(ctx context.Context, tx *sql.Tx, s *store.Snapshot, table, id, def string, now int64) (*contract.WearResult, error) {
	trowel, err := packTrowel(ctx, tx, s.AccountID)
	if err != nil {
		return nil, err
	}
	if trowel == "" {
		return nil, fail(409, "wrong-tool")
	}
	res, err := useTool(ctx, tx, s, trowel, trowelAction, now)
	if err != nil {
		return nil, err
	}
	// A made trowel that gives out on this dig thanks its maker, as any use does.
	if (res.Broke || res.WoreOut) && res.MakerID != "" {
		if err = a.thankMaker(ctx, tx, s, res.MakerID, res.ItemDef, now); err != nil {
			return nil, err
		}
	}
	var plantedAt int64
	if err = tx.QueryRowContext(ctx, "SELECT planted_at FROM "+table+" WHERE id=?", id).Scan(&plantedAt); err != nil {
		return nil, err
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM "+table+" WHERE id=?", id); err != nil {
		return nil, err
	}
	return wearProto(&res), carryPlant(ctx, tx, s.AccountID, id, def, plantedAt, now)
}

// uprootCampPlant digs a camp plant up with a trowel, from beside it: anyone
// who may build at the camp, or whoever planted it (taking your own back
// isn't building).
func (a *Server) uprootCampPlant(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CampRequest, now int64) (*camp, *contract.WearResult, error) {
	var campID, def, owner string
	var x, y int
	err := tx.QueryRowContext(ctx, "SELECT p.camp_id,p.item_def,p.account_id,p.x,p.y FROM camp_plants p JOIN camps c ON c.id=p.camp_id WHERE p.id=? AND c.world_id=?", req.ItemId, s.WorldID).Scan(&campID, &def, &owner, &x, &y)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil, fail(409, "not-placed")
	}
	if err != nil {
		return nil, nil, err
	}
	c, err := campByID(ctx, tx, s.WorldID, campID)
	if err != nil {
		return nil, nil, err
	}
	if owner != s.AccountID {
		if err = mayBuildAtCamp(ctx, tx, c, s.AccountID); err != nil {
			return nil, nil, err
		}
	}
	S := chunkSize()
	if !nearTile(s, outdoorsArea, c.CX*S+x, c.CY*S+y, int(content.HomeRules.GetWayLamp().GetReach())) {
		return nil, nil, fail(409, "too-far-away")
	}
	wear, err := a.digUpPlant(ctx, tx, s, "camp_plants", req.ItemId, def, now)
	return c, wear, err
}

// packUpCamp is the keeper's, from beside the lamp: the whole camp goes to
// Pell's as it would at a lapse (packCamp), every piece to its owner's
// crate entry, the lamp too, every plant, and the unspent oil; what was
// someone else's names the keeper who moved it off. The claim ends now;
// its hold lets go at the turning, which refunds any path laid there, as
// when the lamp is taken down.
func (a *Server) packUpCamp(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CampRequest, now int64) error {
	c, err := campByID(ctx, tx, s.WorldID, req.Camp)
	if err != nil {
		return err
	}
	if c == nil {
		return fail(404, "no-camp")
	}
	if c.Setter != s.AccountID {
		return fail(409, "not-your-lamp")
	}
	S := chunkSize()
	if !nearTile(s, outdoorsArea, c.CX*S+c.X, c.CY*S+c.Y, int(content.HomeRules.GetWayLamp().GetReach())) {
		return fail(409, "too-far-away")
	}
	h := store.Hold{World: c.World, CX: int32(c.CX), CY: int32(c.CY), HolderKind: wayLampKind, HolderID: c.ID}
	if err = packCamp(ctx, tx, h, true, now); err != nil {
		return err
	}
	if held, ok := a.Config.Epochs.(*store.Chunks); ok {
		_, err = held.Release(ctx, tx, c.World, h.CX, h.CY, wayLampKind, c.ID, now)
	}
	return err
}
