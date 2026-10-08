package api

import (
	"context"
	"database/sql"
	"fmt"
	"glimway/content"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"slices"
	"strings"
)

func (a *Server) returnKeepsake(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest, now int64, out *itemResult) error {
	itemID := req.ItemDef
	if itemID == "" {
		return fail(400, "invalid-item")
	}
	def, ok := content.ItemFor(itemID)
	if !ok || def.Kind != "keepsake" {
		return fail(400, "not-a-keepsake")
	}
	if !def.Bound {
		// Only story keepsakes come back to a person (the mirror foxes stay carved).
		return fail(400, "not-giveable")
	}
	target := req.Target
	if target == "" {
		return fail(400, "invalid-target")
	}
	if def.BelongsTo != target {
		return fail(400, "wrong-recipient")
	}

	if slices.Contains(s.State.Flags, "returned:"+itemID) {
		return fail(409, "already-returned")
	}

	// Proximity check: where each resident stands is shared content — Ada
	// and Hazel from the residents' spots, Silas from the menders, the Echo
	// camps anywhere in the deep Wilds until camps are placed per person.
	switch target {
	case "ada", "hazel":
		spot, ok := content.ResidentFor(target)
		if !ok || !nearTile(s, spot.Area, spot.TX, spot.TY, residentReachTiles) {
			return fail(409, "too-far-away")
		}
	case "silas":
		m, ok := content.MenderFor("silas")
		if !ok || !nearTile(s, m.Area, m.TX, m.TY, m.RadiusTiles) {
			return fail(409, "too-far-away")
		}
	case "bett", "nan":
		if !strings.HasPrefix(s.State.Area, "wilds:") {
			return fail(409, "too-far-away")
		}
	default:
		return fail(400, "unknown-target")
	}

	ref := target + ":" + itemID
	if _, err := packTake(ctx, tx, s.AccountID, itemID, nil, 1, "return-keepsake", ref, now); err != nil {
		return err
	}

	s.State.Flags = rules.AddUnique(s.State.Flags, "returned:"+itemID)

	var paperGranted *string
	switch target {
	case "ada":
		p := "adas-oil-receipts"
		paperGranted = &p
		s.State.Flags = rules.AddUnique(s.State.Flags, "paper:"+p)
	case "hazel":
		p := "keepers-twists-recipe-card"
		paperGranted = &p
		s.State.Flags = rules.AddUnique(s.State.Flags, "paper:"+p)
	case "silas":
		// Story conversation only, no paper
	case "bett":
		s.State.Flags = rules.AddUnique(s.State.Flags, "echo:bett:softened")
	case "nan":
		s.State.Flags = rules.AddUnique(s.State.Flags, "echo:nan:softened")
	}

	out.Returned = itemID
	out.Paper = paperGranted
	return nil
}

// grantHeirloom validates conditions and grants an heirloom tool once per player.
func (a *Server) grantHeirloom(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest, now int64, out *itemResult) error {
	itemID := req.ItemDef
	if itemID == "" {
		return fail(400, "invalid-item")
	}
	def, ok := content.ItemFor(itemID)
	if !ok || def.Grade != "heirloom" {
		return fail(400, "invalid-item")
	}

	// Proximity check per heirloom giver
	switch itemID {
	case "brack-felling-axe":
		m, ok := content.MenderFor("silas")
		if !ok || !nearTile(s, m.Area, m.TX, m.TY, m.RadiusTiles) {
			return fail(409, "too-far-away")
		}
	case "orrins-mason-pick":
		m, ok := content.MenderFor("orrin")
		if !ok || !nearTile(s, m.Area, m.TX, m.TY, m.RadiusTiles) {
			return fail(409, "too-far-away")
		}
	case "ada-garden-spade":
		spot, ok := content.ResidentFor("ada")
		if !ok || !nearTile(s, spot.Area, spot.TX, spot.TY, residentReachTiles) {
			return fail(409, "too-far-away")
		}
	case "nans-lamplighter-pole":
		if !strings.HasPrefix(s.State.Area, "wilds:") {
			return fail(409, "too-far-away")
		}
	default:
		return fail(400, "invalid-item")
	}

	// Validate story conditions per heirloom tool
	switch itemID {
	case "brack-felling-axe":
		// Silas: Hollis's name known
		// Authoritative check on server ledger for Silas's returned fox,
		// plus echo and paper flags from progress.
		var foxReturned bool
		err := tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM ledger WHERE account_id=? AND reason='return-keepsake' AND ref='silas:whittled-fox')", s.AccountID).Scan(&foxReturned)
		if err != nil {
			return err
		}
		met := foxReturned ||
			slices.Contains(s.State.Flags, "echo:hollis") ||
			slices.Contains(s.State.Flags, "paper:ashwatch-ledger-excerpts") ||
			slices.Contains(s.State.Flags, "paper:silas-pine-offcut-scrap")
		if !met {
			return fail(409, "condition-unmet")
		}

	case "orrins-mason-pick":
		// Orrin: north bridge mended
		// Authoritative check on the projects table only.
		var completed sql.NullInt64
		err := tx.QueryRowContext(ctx, "SELECT completed_at FROM projects WHERE world_id=? AND project_def='north-bridge'", s.WorldID).Scan(&completed)
		if err != nil && err != sql.ErrNoRows {
			return err
		}
		if err == sql.ErrNoRows || !completed.Valid || completed.Int64 <= 0 {
			return fail(409, "condition-unmet")
		}

	case "ada-garden-spade":
		// Ada: window oil brought 3 times
		// Authoritative count on outcomes table only.
		var oilCount int
		err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM outcomes WHERE account_id=? AND reason='ada-oil'", s.AccountID).Scan(&oilCount)
		if err != nil {
			return err
		}
		if oilCount < 3 {
			return fail(409, "condition-unmet")
		}

	case "nans-lamplighter-pole":
		// Nan: echo settled
		met := slices.Contains(s.State.Flags, "echo:nan")
		if !met {
			return fail(409, "condition-unmet")
		}

	default:
		return fail(400, "invalid-item")
	}

	// Outcomes table guarantees once per player
	added, err := store.Outcome(ctx, tx, s.AccountID, "heirloom:"+itemID, "heirloom", now)
	if err != nil {
		return err
	}
	if !added {
		return fail(409, "already-granted")
	}

	condition := -1
	if def.Uses > 0 {
		condition = def.Uses * content.ItemsRules.Rules.Wear.PointsPerUse
	}
	instID, err := newInstance(ctx, tx, def, instanceAt{"pack", s.AccountID}, "", condition, now)
	if err != nil {
		return err
	}
	out.Created = []string{instID}
	out.Heirloom = itemID
	s.State.Flags = rules.AddUnique(s.State.Flags, "heirloom:"+itemID)

	return currency(ctx, tx, s.AccountID, content.StackCurrency(itemID), 1, "heirloom", itemID, now)
}

// giveAdaOil accepts hearth-oil for Ada's window, up to 3 gifts.
func (a *Server) giveAdaOil(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest, now int64, out *itemResult) error {
	spot, ok := content.ResidentFor("ada")
	if !ok || !nearTile(s, spot.Area, spot.TX, spot.TY, residentReachTiles) {
		return fail(409, "too-far-away")
	}

	if req.ItemDef != "hearth-oil" {
		return fail(400, "invalid-item")
	}

	// Count check runs first before checking pack inventory
	var currentGifts int
	err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM outcomes WHERE account_id=? AND reason='ada-oil'", s.AccountID).Scan(&currentGifts)
	if err != nil {
		return err
	}
	if currentGifts >= 3 {
		return fail(409, "not-needed")
	}

	haveHearth, err := stackTotal(ctx, tx, packOf(s.AccountID), "hearth-oil")
	if err != nil {
		return err
	}
	if haveHearth <= 0 {
		return fail(409, "insufficient-items")
	}

	if _, err := packTake(ctx, tx, s.AccountID, "hearth-oil", nil, 1, "ada-oil", "ada", now); err != nil {
		return err
	}

	nextCount := currentGifts + 1
	if _, err := store.Outcome(ctx, tx, s.AccountID, fmt.Sprintf("ada-oil:%d", nextCount), "ada-oil", now); err != nil {
		return err
	}

	s.State.Flags = rules.AddUnique(s.State.Flags, fmt.Sprintf("ada-oil-gifts:%d", nextCount))
	out.AdaOilCount = nextCount
	out.Used = "hearth-oil"
	return nil
}
