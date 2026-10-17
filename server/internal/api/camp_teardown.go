package api

// Taking a camp apart (lamps.md 2.5): digging up a plant there, and its
// keeper packing the whole camp up at once. A lamp comes down only from an
// empty camp (removeFromCamp), so without these one planted seed kept a
// camp standing until it lapsed.

import (
	"context"
	"database/sql"
	"errors"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

// uprootCampPlant digs a camp plant up, from beside it, into the digger's
// pack: anyone who may build at the camp, or whoever planted it (taking
// your own back isn't building). It comes up as its seed, as a home plant
// would: nothing planted grows into a crop yet, so there is no crop to
// pick.
func uprootCampPlant(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.CampRequest, now int64) (*camp, error) {
	var campID, def, owner string
	var x, y int
	err := tx.QueryRowContext(ctx, "SELECT p.camp_id,p.item_def,p.account_id,p.x,p.y FROM camp_plants p JOIN camps c ON c.id=p.camp_id WHERE p.id=? AND c.world_id=?", req.ItemId, s.WorldID).Scan(&campID, &def, &owner, &x, &y)
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
	if owner != s.AccountID {
		if err = mayBuildAtCamp(ctx, tx, c, s.AccountID); err != nil {
			return nil, err
		}
	}
	S := chunkSize()
	if !nearTile(s, outdoorsArea, c.CX*S+x, c.CY*S+y, int(content.HomeRules.GetWayLamp().GetReach())) {
		return nil, fail(409, "too-far-away")
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM camp_plants WHERE id=?", req.ItemId); err != nil {
		return nil, err
	}
	return c, packPut(ctx, tx, s.AccountID, def, []makerQty{{Qty: 1}}, "camp-uproot", req.ItemId, now)
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
