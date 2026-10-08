package api

import (
	"context"
	"database/sql"
	"fmt"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"net/http"
	"strconv"
)

type shelfSlotView struct {
	Slot      int        `json:"slot"`
	Kind      string     `json:"kind"`
	ItemDef   string     `json:"itemDef"`
	Qty       int        `json:"qty"`
	Maker     *makerView `json:"maker,omitempty"`
	Instance  *string    `json:"instance,omitempty"`
	StockedBy string     `json:"stockedBy"`
	StockedAt int64      `json:"stockedAt"`
}

type shelfView struct {
	Gate       int             `json:"gate"`
	HomeID     string          `json:"homeId"`
	OwnerName  string          `json:"ownerName"`
	Names      []string        `json:"names"`
	Slots      []shelfSlotView `json:"slots"`
	TakenToday bool            `json:"takenToday"`
	CanStock   bool            `json:"canStock"`
	HasShelf   bool            `json:"hasShelf"`
}

func loadShelfView(ctx context.Context, tx *sql.Tx, s store.Snapshot, homeID string, gate int, now int64) (shelfView, error) {
	out := shelfView{
		Gate:   gate,
		HomeID: homeID,
		Names:  []string{},
		Slots:  []shelfSlotView{},
	}
	if err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM homestead_items WHERE homestead_id=? AND scene='gate')", homeID).Scan(&out.HasShelf); err != nil {
		return out, err
	}
	mem, err := members(ctx, tx, homeID)
	if err != nil {
		return out, err
	}
	for _, m := range mem {
		out.Names = append(out.Names, m.DisplayName)
		if m.ID == s.AccountID {
			out.CanStock = true
		}
	}
	if len(out.Names) > 0 {
		out.OwnerName = out.Names[0]
	} else {
		out.OwnerName = ""
	}
	day := utcDay(now)
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM gate_shelf_takes WHERE homestead_id=? AND account_id=? AND day=?)", homeID, s.AccountID, day).Scan(&out.TakenToday); err != nil {
		return out, err
	}
	if !out.HasShelf {
		return out, nil
	}
	rows, err := tx.QueryContext(ctx, "SELECT slot, kind, item_def, qty, maker_id, instance_id, stocked_by, stocked_at FROM gate_shelf_slots WHERE homestead_id=? ORDER BY slot", homeID)
	if err != nil {
		return out, err
	}
	defer rows.Close()
	makers := map[string]*makerView{}
	for rows.Next() {
		var slot shelfSlotView
		var makerID string
		var instanceID sql.NullString
		if err = rows.Scan(&slot.Slot, &slot.Kind, &slot.ItemDef, &slot.Qty, &makerID, &instanceID, &slot.StockedBy, &slot.StockedAt); err != nil {
			return out, err
		}
		if instanceID.Valid {
			slot.Instance = &instanceID.String
		}
		if makerID != "" {
			if m, ok := makers[makerID]; ok {
				slot.Maker = m
			} else {
				var name string
				if err = tx.QueryRowContext(ctx, "SELECT display_name FROM players WHERE account_id=?", makerID).Scan(&name); err == nil {
					mv := &makerView{ID: makerID, Name: name}
					makers[makerID] = mv
					slot.Maker = mv
				}
			}
		}
		out.Slots = append(out.Slots, slot)
	}
	return out, rows.Err()
}

func (a *Server) shelfRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	now := a.Config.Now().Unix()
	if err = settleHomes(ctx, tx, s.WorldID, now); err != nil {
		return err
	}
	gateParam := r.URL.Query().Get("gate")
	homeParam := r.URL.Query().Get("homeId")
	var homeID string
	var gate int
	var vacantSince *int64
	if gateParam != "" {
		g, err := strconv.Atoi(gateParam)
		if err != nil {
			return fail(400, "invalid-gate")
		}
		gate = g
		err = tx.QueryRowContext(ctx, "SELECT id, vacant_since FROM homesteads WHERE world_id=? AND gate=?", s.WorldID, gate).Scan(&homeID, &vacantSince)
		if err == sql.ErrNoRows {
			return fail(404, "homestead-not-found")
		}
		if err != nil {
			return err
		}
	} else if homeParam != "" {
		homeID = homeParam
		err = tx.QueryRowContext(ctx, "SELECT gate, vacant_since FROM homesteads WHERE world_id=? AND id=?", s.WorldID, homeID).Scan(&gate, &vacantSince)
		if err == sql.ErrNoRows {
			return fail(404, "homestead-not-found")
		}
		if err != nil {
			return err
		}
	} else {
		return fail(400, "gate-required")
	}
	view, err := loadShelfView(ctx, tx, s, homeID, gate, now)
	if err != nil {
		return err
	}
	return a.finishRead(w, r, tx, s, struct {
		Shelf shelfView `json:"shelf"`
	}{view})
}

func (a *Server) shelfMutation(w http.ResponseWriter, r *http.Request) error {
	var req contract.ShelfRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := settleHomes(ctx, tx, s.WorldID, now); err != nil {
			return nil, err
		}
		var homeID string
		var vacantSince *int64
		err := tx.QueryRowContext(ctx, "SELECT id, vacant_since FROM homesteads WHERE world_id=? AND gate=?", s.WorldID, req.Gate).Scan(&homeID, &vacantSince)
		if err == sql.ErrNoRows {
			return nil, fail(404, "homestead-not-found")
		}
		if err != nil {
			return nil, err
		}
		if desolate(vacantSince, now) {
			return nil, fail(409, "homestead-desolate")
		}
		// Shelf actions are not proximity-gated yet: Commons gate coordinates are
		// client layout data. The server still enforces one take per traveller/day.
		var hasShelf bool
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM homestead_items WHERE homestead_id=? AND scene='gate')", homeID).Scan(&hasShelf); err != nil {
			return nil, err
		}
		if !hasShelf {
			return nil, fail(409, "shelf-not-placed")
		}
		if req.Slot < 0 || req.Slot >= 6 {
			return nil, fail(400, "invalid-slot")
		}
		switch req.Action {
		case "stock":
			var isMember bool
			if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM homestead_members WHERE homestead_id=? AND account_id=?)", homeID, s.AccountID).Scan(&isMember); err != nil {
				return nil, err
			}
			if !isMember {
				return nil, fail(403, "not-a-member")
			}
			if req.Asset == nil {
				return nil, fail(400, "asset-required")
			}
			// A shelf slot represents one takeable item. Keeping it to one also
			// preserves individual decoration IDs and a single maker's mark.
			if req.Asset.Qty != 1 {
				return nil, fail(400, "invalid-quantity")
			}
			if err = validAsset(assetOf(req.Asset)); err != nil {
				return nil, err
			}
			if !isGiveable(assetOf(req.Asset)) {
				return nil, fail(409, "not-giveable")
			}
			var occupied bool
			if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM gate_shelf_slots WHERE homestead_id=? AND slot=?)", homeID, req.Slot).Scan(&occupied); err != nil {
				return nil, err
			}
			if occupied {
				return nil, fail(409, "slot-occupied")
			}
			to := holder{"shelf", "", homeID}
			got, err := takeAsset(ctx, tx, s, assetOf(req.Asset), to, "shelf-stock", req.Op.Key, now)
			if err != nil {
				return nil, err
			}
			makerID := ""
			if len(got.Makers) > 0 {
				makerID = got.Makers[0].Maker
			}
			var instanceID any = nil
			if len(got.IDs) > 0 {
				instanceID = got.IDs[0]
				if req.Asset.Kind == "instance" {
					if err = tx.QueryRowContext(ctx, "SELECT maker_id FROM item_instances WHERE id=?", got.IDs[0]).Scan(&makerID); err != nil {
						return nil, err
					}
				}
			}
			if _, err = tx.ExecContext(ctx, "INSERT INTO gate_shelf_slots(homestead_id, slot, kind, item_def, qty, maker_id, instance_id, stocked_by, stocked_at) VALUES(?,?,?,?,?,?,?,?,?)", homeID, req.Slot, req.Asset.Kind, req.Asset.Id, int(req.Asset.Qty), makerID, instanceID, s.AccountID, now); err != nil {
				return nil, err
			}
			if err = currency(ctx, tx, s.AccountID, "shelf:"+req.Asset.Kind+":"+req.Asset.Id, int(req.Asset.Qty), "shelf-stock", req.Op.Key, now); err != nil {
				return nil, err
			}
			shelf, err := loadShelfView(ctx, tx, *s, homeID, int(req.Gate), now)
			if err != nil {
				return nil, err
			}
			inv, err := packCounts(ctx, tx, s.AccountID)
			if err != nil {
				return nil, err
			}
			result := &contract.ShelfResult{Shelf: shelfViewProto(shelf), Inventory: countsProto(inv)}
			return protoResult(result)

		case "take":
			day := utcDay(now)
			var alreadyTaken bool
			if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM gate_shelf_takes WHERE homestead_id=? AND account_id=? AND day=?)", homeID, s.AccountID, day).Scan(&alreadyTaken); err != nil {
				return nil, err
			}
			if alreadyTaken {
				return nil, fail(409, "already-taken-today")
			}
			var slotKind, itemDef, makerID string
			var slotQty int
			var instanceID sql.NullString
			err = tx.QueryRowContext(ctx, "SELECT kind, item_def, qty, maker_id, instance_id FROM gate_shelf_slots WHERE homestead_id=? AND slot=?", homeID, req.Slot).Scan(&slotKind, &itemDef, &slotQty, &makerID, &instanceID)
			if err == sql.ErrNoRows {
				return nil, fail(404, "slot-empty")
			}
			if err != nil {
				return nil, err
			}
			if _, err = tx.ExecContext(ctx, "INSERT INTO gate_shelf_takes(homestead_id, account_id, day) VALUES(?,?,?)", homeID, s.AccountID, day); err != nil {
				return nil, err
			}
			if slotQty > 1 {
				if _, err = tx.ExecContext(ctx, "UPDATE gate_shelf_slots SET qty=qty-1 WHERE homestead_id=? AND slot=?", homeID, req.Slot); err != nil {
					return nil, err
				}
			} else {
				if _, err = tx.ExecContext(ctx, "DELETE FROM gate_shelf_slots WHERE homestead_id=? AND slot=?", homeID, req.Slot); err != nil {
					return nil, err
				}
			}
			takeQty := 1
			takenAsset := content.Asset{Kind: slotKind, ID: itemDef, Qty: takeQty}
			got := moved{Makers: []makerQty{}, IDs: []string{}}
			if instanceID.Valid {
				got.IDs = []string{instanceID.String}
				takenAsset.Instance = instanceID.String
			} else {
				got.Makers = []makerQty{{Maker: makerID, Qty: takeQty}}
			}
			from := holder{"shelf", "", homeID}
			if err = giveAsset(ctx, tx, s, takenAsset, got, from, "shelf-take", req.Op.Key, now); err != nil {
				return nil, err
			}
			if err = currency(ctx, tx, s.AccountID, "shelf:"+slotKind+":"+itemDef, -takeQty, "shelf-take", req.Op.Key, now); err != nil {
				return nil, err
			}
			shelf, err := loadShelfView(ctx, tx, *s, homeID, int(req.Gate), now)
			if err != nil {
				return nil, err
			}
			inv, err := packCounts(ctx, tx, s.AccountID)
			if err != nil {
				return nil, err
			}
			itemDisplayName := itemDef
			if d, ok := content.ItemFor(itemDef); ok {
				itemDisplayName = d.Name
			} else if h, ok := content.HomeItemFor(itemDef); ok {
				itemDisplayName = h.Name
			}
			line := fmt.Sprintf("You took %s from %s’s shelf.", giftPhrase(itemDisplayName, 1), shelf.OwnerName)
			if shelf.OwnerName == "" {
				line = fmt.Sprintf("You took %s from Lot %d’s shelf.", giftPhrase(itemDisplayName, 1), int(req.Gate)+1)
			}
			return protoResult(&contract.ShelfResult{Shelf: shelfViewProto(shelf), Inventory: countsProto(inv), Taken: assetProto(takenAsset), Line: line})

		default:
			return nil, fail(400, "invalid-operation")
		}
	})
}
