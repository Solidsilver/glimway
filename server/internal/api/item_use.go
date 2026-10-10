package api

import (
	"context"
	"database/sql"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"math"
)

// useItem: one use of a tool (instance), or eating/drinking one consumable.
func (a *Server) useItem(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req *contract.ItemsRequest, now int64, out *contract.ItemsResult) error {
	if req.Instance != "" {
		res, err := useTool(ctx, tx, s, req.Instance, req.Action, now)
		out.Wear = wearProto(&res)
		if err != nil {
			return err
		}
		if (res.Broke || res.WoreOut) && res.MakerID != "" {
			if err = a.thankMaker(ctx, tx, s, res.MakerID, res.ItemDef, now); err != nil {
				return err
			}
		}
		return nil
	}
	def, ok := content.ItemFor(req.ItemDef)
	if !ok || def.GetKind() != "consumable" {
		return fail(400, "invalid-item")
	}
	if !content.ItemUsableNow(def) {
		return fail(409, "not-usable-yet")
	}
	// A hero at 0 HP is too far gone to eat or drink. Only a sync, a rest or
	// a fall lifts the zero-HP lock.
	if s.State.HP <= 0 {
		return fail(409, "too-weak")
	}

	helps := false
	for _, e := range def.Use {
		switch e.Type {
		case "restore-hp":
			if s.State.HP < s.State.MaxHP {
				helps = true
				s.VitalsWritten = true
				s.State.HP = math.Min(s.State.MaxHP, s.State.HP+float64(e.GetAmount()))
			}
		case "restore-mana":
			if s.State.Mana < s.State.MaxMana {
				helps = true
				s.VitalsWritten = true
				s.State.Mana = math.Min(s.State.MaxMana, s.State.Mana+float64(e.GetAmount()))
			}
		case "clear-unmoored", "ease-unmoored":
			if req.Unmoored {
				helps = true
			}
		}
	}
	if !helps {
		return fail(409, "not-needed")
	}
	var maker *string
	if req.Maker != nil {
		m := req.Maker.GetValue()
		maker = &m
	}
	split, err := packTake(ctx, tx, s.AccountID, def.GetId(), maker, 1, "use", def.GetId(), now)
	if err != nil {
		return err
	}
	out.Used = def.GetId()
	// A quiet thank-you to the maker, unless they're right here.
	for _, m := range split {
		if err = a.thankMaker(ctx, tx, s, m.Maker, def.GetId(), now); err != nil {
			return err
		}
	}
	return nil
}

func (a *Server) thankMaker(ctx context.Context, tx *sql.Tx, s *store.Snapshot, makerID, itemDef string, now int64) error {
	if makerID == "" || makerID == s.AccountID {
		return nil
	}
	radius := float64(content.ItemsRules.Rules.Thanks.NearbyTiles * wildsTileSize)
	if a.presence != nil && a.presence.together(s.WorldID, s.AccountID, makerID, radius) {
		return nil
	}
	var makerWorld string
	err := tx.QueryRowContext(ctx, "SELECT world_id FROM players WHERE account_id=? AND NOT EXISTS(SELECT 1 FROM access_removals WHERE habitica_id=(SELECT subject FROM sign_ins WHERE account_id=? AND method='habitica'))", makerID, makerID).Scan(&makerWorld)
	if err == sql.ErrNoRows {
		return nil
	}
	if err != nil {
		return err
	}
	if makerWorld != s.WorldID {
		return nil
	}
	todayStart := utcDayStart(now)
	var already bool
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM mail WHERE kind='thanks' AND from_id=? AND to_id=? AND sent_at>=?)", s.AccountID, makerID, todayStart).Scan(&already); err != nil {
		return err
	}
	if already {
		return nil
	}
	mailID, err := store.Random()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES(?,?,?,?,?,?,0,'[]','[]',?)", mailID, s.WorldID, s.AccountID, makerID, "thanks", itemDef, now)
	return err
}
