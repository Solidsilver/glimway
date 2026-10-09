// The item system core (docs/items/): instances with condition, fittings
// and a maker; wear, breaking and blunting; mending at the bench or by a
// mender; consumables; handing things over; pockets and the off hand; and
// pickups lying in the world. Every change is a keyed mutation.

package api

import (
	"context"
	"database/sql"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"net/http"
	"strings"
)

func (a *Server) itemsMutation(w http.ResponseWriter, r *http.Request) error {
	op := strings.TrimPrefix(r.URL.Path, "/api/items/")
	var req contract.ItemsRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	var notify []func()
	err := a.keyedOp(w, r, req.Op, req.Where, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		out := &contract.ItemsResult{}
		var err error
		switch op {
		case "use":
			if req.Instance == "" && consumableVitals(req.ItemDef) {
				if err = barrier(ctx, tx, s, req.Op); err != nil {
					return nil, err
				}
			}
			err = a.useItem(ctx, tx, s, &req, now, out)
		case "repair":
			err = repairTool(ctx, tx, s, &req, now, out)
		case "fit":
			err = fitTool(ctx, tx, s, &req, now)
		case "unfit":
			err = unfitTool(ctx, tx, s, &req, now)
		case "give":
			var to string
			to, err = a.giveItem(ctx, tx, s, &req, now, out)
			if err == nil {
				notify = append(notify, func() { a.presenceGift(s.WorldID, to, s.DisplayName, assetOf(req.Asset)) })
			}
		case "pocket":
			err = pocketItem(ctx, tx, s, &req)
		case "offhand":
			err = offHandItem(ctx, tx, s, &req)
		case "pickup":
			err = pickUp(ctx, tx, s, &req, now, out)
		case "gather":
			err = a.gather(ctx, tx, s, &req, now, out)
		case "plant":
			err = a.plant(ctx, tx, s, &req, now, out)
		case "return":
			err = a.returnKeepsake(ctx, tx, s, &req, now, out)
		case "heirloom":
			err = a.grantHeirloom(ctx, tx, s, &req, now, out)
		case "ada-oil":
			err = a.giveAdaOil(ctx, tx, s, &req, now, out)
		case "buy":
			err = a.marketBuy(ctx, tx, s, &req, now, out)
		default:
			err = fail(404, "not-found")
		}
		if err != nil {
			return nil, err
		}
		if err = settleSlots(ctx, tx, s); err != nil {
			return nil, err
		}
		if err = refreshItems(ctx, tx, s); err != nil {
			return nil, err
		}
		// Every view of the pack shows warden-set tools healed overnight.
		if err = healWardens(ctx, tx, s.AccountID, now); err != nil {
			return nil, err
		}
		items, err := readItems(ctx, tx, s, now)
		if err != nil {
			return nil, err
		}
		out.Items = itemsViewProto(items)
		return protoResult(out)
	}, func() {
		for _, n := range notify {
			n()
		}
	})
	return err
}

func consumableVitals(id string) bool {
	def, ok := content.ItemFor(id)
	if !ok {
		return false
	}
	for _, e := range def.Use {
		if e.Type == "restore-hp" || e.Type == "restore-mana" {
			return true
		}
	}
	return false
}
