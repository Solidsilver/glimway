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
func (a *Server) giveItem(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.ItemsRequest, now int64, out *contract.ItemsResult) (string, error) {
	if req.Asset == nil {
		return "", fail(400, "invalid-asset")
	}
	v := assetOf(req.Asset)
	if req.ToId == s.AccountID || req.ToId == "" {
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
	if a.presence == nil || !a.presence.together(s.WorldID, s.AccountID, req.ToId, radius) {
		return "", fail(409, "not-together")
	}
	if v.Kind == "instance" {
		warden, err := isWardenSet(ctx, tx, v.Instance)
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
	switch v.Kind {
	case "material", "item":
		err = packPut(ctx, tx, req.ToId, v.ID, got.Makers, "gift", s.AccountID, now)
	case "instance":
		if err = currency(ctx, tx, req.ToId, content.StackCurrency(v.ID), 1, "gift", s.AccountID, now); err == nil {
			err = fittedLedger(ctx, tx, req.ToId, v.Instance, 1, "gift", s.AccountID, now)
		}
	default:
		err = currency(ctx, tx, req.ToId, "decoration:"+v.ID, v.Qty, "gift", s.AccountID, now)
	}
	if err != nil {
		return "", err
	}
	// The recipient's revision stays as it is: their carried items live in
	// the item tables (every read rebuilds them), and a bumped revision would
	// turn their next progress upload into a stale merge that moves them back
	// to their last saved spot. Presence tells them (presenceGift).
	out.Given = assetProto(v)
	return req.ToId, nil
}
