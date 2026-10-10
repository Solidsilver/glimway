package api

import (
	"context"
	"database/sql"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
)

// giveItem hands something to a player standing next to the caller. Gifts
// only; heirlooms and story keepsakes stay with the one they were given to.
// A give hands over an item or gold (design 3.4): `gold` in place of an
// asset, with the same checks — same world, allowed in, and together (within
// the give radius, as presence last saw you both).
func (a *Server) giveItem(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.ItemsRequest, now int64, out *contract.ItemsResult) (string, error) {
	gold := int(req.GetGold())
	if (req.Asset != nil) == (gold != 0) {
		return "", fail(400, "invalid-request")
	}
	v := assetOf(req.Asset)
	if req.ToId == s.AccountID || req.ToId == "" {
		return "", fail(400, "self-gift")
	}
	if gold != 0 {
		if gold < 1 {
			return "", fail(400, "invalid-quantity")
		}
	} else {
		if err := validAsset(v); err != nil {
			return "", err
		}
		if v.GetKind() == "decoration" {
			if v.GetId() == "door-fox" {
				return "", fail(409, "not-giveable")
			}
		} else if d, _ := content.ItemFor(v.GetId()); !content.ItemGiveable(d) {
			return "", fail(409, "not-giveable")
		}
	}
	var world string
	err := tx.QueryRowContext(ctx, "SELECT world_id FROM players WHERE account_id=?", req.ToId).Scan(&world)
	if err == sql.ErrNoRows {
		return "", fail(404, "recipient-not-found")
	}
	if err != nil {
		return "", err
	}
	if world != s.WorldID {
		return "", fail(403, "world-access-denied")
	}
	var eligible bool
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM allowlist WHERE habitica_id=(SELECT subject FROM sign_ins WHERE account_id=? AND method='habitica')) AND NOT EXISTS(SELECT 1 FROM access_removals WHERE habitica_id=(SELECT subject FROM sign_ins WHERE account_id=? AND method='habitica'))", req.ToId, req.ToId).Scan(&eligible); err != nil {
		return "", err
	}
	if !eligible {
		return "", fail(403, "recipient-unavailable")
	}
	radius := float64(content.ItemsRules.Rules.Give.RadiusTiles * wildsTileSize)
	if !a.presence.together(s.WorldID, s.AccountID, req.ToId, radius) {
		return "", fail(409, "not-together")
	}
	if gold > 0 {
		// Gold by hand (3.4, 3.5): both purses in one transaction — the
		// giver's gold out with reason `give` and the recipient's in with
		// `gift`, each row naming the other account. Both gold writes move
		// the account's version (store/gold.go), so the recipient's next
		// answer carries their new purse even mid-session; that is safe with
		// today's operations — reports only refuse a basis past the current
		// version, and every operation is keyed, not revision-checked.
		if err := store.DebitGold(ctx, tx, s.AccountID, gold, "give", req.ToId, now); err != nil {
			return "", insufficientGold(err)
		}
		if err := store.CreditGold(ctx, tx, req.ToId, gold, "gift", s.AccountID, now); err != nil {
			return "", err
		}
		out.Given = assetProto(goldAsset(gold))
		out.GoldGiven = int32(gold)
		return req.ToId, nil
	}
	if v.GetKind() == "instance" {
		warden, err := isWardenSet(ctx, tx, v.GetInstance())
		if err != nil {
			return "", err
		}
		if warden {
			has, err := hasWardenSetInPack(ctx, tx, req.ToId, "")
			if err != nil {
				return "", err
			}
			if has {
				return "", fail(409, "two-wardens-grind")
			}
		}
	}
	to := pack(req.ToId)
	got, err := takeAsset(ctx, tx, s, v, to, "give", req.ToId, now)
	if err != nil {
		return "", err
	}
	switch v.GetKind() {
	case "material", "item":
		err = packPut(ctx, tx, req.ToId, v.GetId(), got.Makers, "gift", s.AccountID, now)
	case "instance":
		if err = currency(ctx, tx, req.ToId, content.StackCurrency(v.GetId()), 1, "gift", s.AccountID, now); err == nil {
			err = fittedLedger(ctx, tx, req.ToId, v.GetInstance(), 1, "gift", s.AccountID, now)
		}
	default:
		err = currency(ctx, tx, req.ToId, "decoration:"+v.GetId(), int(v.GetQty()), "gift", s.AccountID, now)
	}
	if err != nil {
		return "", err
	}
	// The recipient's revision stays as it is for items: their carried things
	// live in the item tables (every read rebuilds them), and a bumped
	// revision would turn their next progress upload into a stale merge that
	// moves them back to their last saved spot. Gold is different (3.4): it
	// is part of PlayerState, so its give moves the version (above).
	// Presence tells them (presenceGift).
	out.Given = assetProto(v)
	return req.ToId, nil
}

// givenAsset is what the give handed over, for the recipient's presence
// notice: the asset, or the gold display asset (kind "gold", its amount) for
// a gold give.
func givenAsset(req *contract.ItemsRequest) *content.Asset {
	if req.Asset == nil {
		return goldAsset(int(req.GetGold()))
	}
	return assetOf(req.Asset)
}
