package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"glimway/content"
	"glimway/server/internal/store"
	"net/http"
	"strings"
)

type itemRequest struct {
	Mutation
	Key      string          `json:"key"`
	Progress json.RawMessage `json:"progress,omitempty"`
	Instance string          `json:"instance,omitempty"`
	ItemDef  string          `json:"itemDef,omitempty"`
	Maker    *string         `json:"maker,omitempty"`
	Action   string          `json:"action,omitempty"`
	At       string          `json:"at,omitempty"`
	Tool     string          `json:"tool,omitempty"`
	Slot     int             `json:"slot,omitempty"`
	ToID     string          `json:"toId,omitempty"`
	Asset    *content.Asset  `json:"asset,omitempty"`
	Pickup   string          `json:"pickup,omitempty"`
	Target   string          `json:"target,omitempty"`
	// Unmoored comes from client UI state; remedy consumption remains a keyed server mutation.
	Unmoored bool    `json:"unmoored,omitempty"`
	VisitID  string  `json:"visitId,omitempty"`
	Tile     *[2]int `json:"tile,omitempty"`
	// Region: which Wilds region a wilds gather is in (the progress area
	// is "wilds" for both; the client's save marker names the region).
	Region string `json:"region,omitempty"`
	// Buying from a seller (Hazel's kitchen, Finn's mill door, a market stall).
	Seller string `json:"seller,omitempty"`
	Good   string `json:"good,omitempty"`
}

// itemResult: the caller's items after the change, and what happened.
type itemResult struct {
	Items       itemsView       `json:"items"`
	Wear        *wearResult     `json:"wear,omitempty"`
	Used        string          `json:"used,omitempty"`
	Pickup      string          `json:"pickup,omitempty"`
	Given       *content.Asset  `json:"given,omitempty"`
	Mended      string          `json:"mended,omitempty"`
	Created     []string        `json:"created,omitempty"`
	Gathered    []stackView     `json:"gathered,omitempty"`
	Plant       *homePlantView  `json:"plant,omitempty"`
	Land        *homeLandChange `json:"land,omitempty"`
	Returned    string          `json:"returned,omitempty"`
	Paper       *string         `json:"paper,omitempty"`
	Heirloom    string          `json:"heirloom,omitempty"`
	AdaOilCount int             `json:"adaOilCount,omitempty"`
	Bought      *boughtView     `json:"bought,omitempty"`
}

// boughtView: what a seller just handed over.
type boughtView struct {
	Seller  string `json:"seller"`
	ItemDef string `json:"itemDef"`
	Qty     int    `json:"qty"`
	Embers  int    `json:"embers"`
}

func (a *Server) itemsMutation(w http.ResponseWriter, r *http.Request) error {
	op := strings.TrimPrefix(r.URL.Path, "/api/items/")
	var req itemRequest
	if err := decode(w, r, &req); err != nil {
		return err
	}
	var notify []func()
	err := a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		out := itemResult{}
		var err error
		switch op {
		case "use":
			err = a.useItem(ctx, tx, s, req, now, &out)
		case "repair":
			err = repairTool(ctx, tx, s, req, now, &out)
		case "fit":
			err = fitTool(ctx, tx, s, req, now)
		case "unfit":
			err = unfitTool(ctx, tx, s, req, now)
		case "give":
			var to string
			to, err = a.giveItem(ctx, tx, s, req, now, &out)
			if err == nil {
				notify = append(notify, func() { a.presenceGift(s.WorldID, to, s.DisplayName, *req.Asset) })
			}
		case "pocket":
			err = pocketItem(ctx, tx, s, req)
		case "offhand":
			err = offHandItem(ctx, tx, s, req)
		case "pickup":
			err = pickUp(ctx, tx, s, req, now, &out)
		case "gather":
			err = a.gather(ctx, tx, s, req, now, &out)
		case "plant":
			err = a.plant(ctx, tx, s, req, now, &out)
		case "return":
			err = a.returnKeepsake(ctx, tx, s, req, now, &out)
		case "heirloom":
			err = a.grantHeirloom(ctx, tx, s, req, now, &out)
		case "ada-oil":
			err = a.giveAdaOil(ctx, tx, s, req, now, &out)
		case "buy":
			err = a.marketBuy(ctx, tx, s, req, now, &out)
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
		if err = healWardens(ctx, tx, s.HabiticaID, now); err != nil {
			return nil, err
		}
		out.Items, err = readItems(ctx, tx, s, now)
		return out, err
	}, func() {
		for _, n := range notify {
			n()
		}
	})
	return err
}
