package api

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/store"
)

// giveItem hands something to a player standing next to the caller. Gifts
// only; heirlooms and story keepsakes stay with the one they were given to.
func (a *Server) giveItem(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest, now int64, out *itemResult) (string, error) {
	if req.Asset == nil {
		return "", fail(400, "invalid-asset")
	}
	v := *req.Asset
	if req.ToID == s.AccountID || req.ToID == "" {
		return "", fail(400, "self-gift")
	}
	if err := validAsset(v); err != nil {
		return "", err
	}
	if v.Kind == "decoration" {
		if v.ID == "door-fox" {
			return "", fail(409, "not-giveable")
		}
	} else if d, _ := content.ItemFor(v.ID); !d.Giveable() {
		return "", fail(409, "not-giveable")
	}
	var world string
	err := tx.QueryRowContext(ctx, "SELECT world_id FROM players WHERE account_id=?", req.ToID).Scan(&world)
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
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM allowlist WHERE habitica_id=(SELECT subject FROM sign_ins WHERE account_id=? AND method='habitica')) AND NOT EXISTS(SELECT 1 FROM access_removals WHERE habitica_id=(SELECT subject FROM sign_ins WHERE account_id=? AND method='habitica'))", req.ToID, req.ToID).Scan(&eligible); err != nil {
		return "", err
	}
	if !eligible {
		return "", fail(403, "recipient-unavailable")
	}
	radius := float64(content.ItemsRules.Rules.Give.RadiusTiles * wildsTileSize)
	if a.presence == nil || !a.presence.together(s.WorldID, s.AccountID, req.ToID, radius) {
		return "", fail(409, "not-together")
	}
	if v.Kind == "instance" {
		warden, err := isWardenSet(ctx, tx, v.Instance)
		if err != nil {
			return "", err
		}
		if warden {
			has, err := hasWardenSetInPack(ctx, tx, req.ToID, "")
			if err != nil {
				return "", err
			}
			if has {
				return "", fail(409, "two-wardens-grind")
			}
		}
	}
	to := pack(req.ToID)
	got, err := takeAsset(ctx, tx, s, v, to, "give", req.ToID, now)
	if err != nil {
		return "", err
	}
	switch v.Kind {
	case "material", "item":
		err = packPut(ctx, tx, req.ToID, v.ID, got.Makers, "gift", s.AccountID, now)
	case "instance":
		if err = currency(ctx, tx, req.ToID, content.StackCurrency(v.ID), 1, "gift", s.AccountID, now); err == nil {
			err = fittedLedger(ctx, tx, req.ToID, v.Instance, 1, "gift", s.AccountID, now)
		}
	default:
		err = currency(ctx, tx, req.ToID, "decoration:"+v.ID, v.Qty, "gift", s.AccountID, now)
	}
	if err != nil {
		return "", err
	}
	// The recipient's revision stays as it is: their carried items live in
	// the item tables (every read rebuilds them), and a bumped revision would
	// turn their next progress upload into a stale merge that moves them back
	// to their last saved spot. Presence tells them (presenceGift).
	out.Given = &v
	return req.ToID, nil
}
