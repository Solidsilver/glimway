// The wardrobe (docs/design/purse-and-wardrobe.md 4): per slot, Habitica's
// look, a piece you own on Habitica, or nothing. The choice is the game's
// own — nothing is ever written to Habitica — and it is only how the hero
// looks; stats come from the battle gear there. Every key is checked against
// the account's latest owned list when someone looks: a lapsed piece reads as
// Habitica's and its stored row waits, unchanged, for a piece that comes
// back. The owned list is filled by the server's own reads of Habitica only
// (4.3): sign-in, a top-up and the wardrobe check — never a browser report.
package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/store"
	"google.golang.org/protobuf/types/known/wrapperspb"
	"net/http"
	"slices"
)

// wardrobeReader is *sql.Tx or *sql.DB.
type wardrobeReader interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}

// gearCatalogued: the catalog knows this key, so it can be drawn at all.
func gearCatalogued(key string) bool {
	_, ok := content.HabiticaGearRules.Gear[key]
	return ok
}

// wearThisSlot: a key the player owns (4.3's own list), the catalog knows,
// of this slot's type, and not one of the `*_base_0` "none" pieces — those
// draw nothing and are never offered (4.2).
func wearThisSlot(key, slot string, owned []string) bool {
	if !slices.Contains(owned, key) {
		return false
	}
	item, ok := content.HabiticaGearRules.Gear[key]
	if !ok || item.GetType() != slot {
		return false
	}
	return !slices.Contains(content.HabiticaGearRules.SpritelessGear, key)
}

// ownedGear is the account's owned list: the sorted, catalogued keys the
// server's own reads kept (4.3), and when it last looked. The checked time is
// absent before the first read. The `*_base_0` "none" pieces drop out here:
// they draw nothing and choosing one is refused (4.2), so the picker shows
// exactly what the operation will accept — "Nothing" is the choice for
// nothing (4.1).
func ownedGear(ctx context.Context, q wardrobeReader, account string) ([]string, *int64, error) {
	var raw string
	var checked int64
	err := q.QueryRowContext(ctx, "SELECT owned_json,checked_at FROM player_gear WHERE account_id=?", account).Scan(&raw, &checked)
	if err == sql.ErrNoRows {
		return []string{}, nil, nil
	}
	if err != nil {
		return nil, nil, err
	}
	var keys []string
	if err = json.Unmarshal([]byte(raw), &keys); err != nil {
		return nil, nil, err
	}
	out := []string{}
	for _, key := range keys {
		if gearCatalogued(key) && !slices.Contains(content.HabiticaGearRules.SpritelessGear, key) {
			out = append(out, key)
		}
	}
	slices.Sort(out)
	return out, &checked, nil
}

// wardrobeRows is the stored choice, unresolved: slot to key or "none".
func wardrobeRows(ctx context.Context, q wardrobeReader, account string) (map[string]string, error) {
	rows, err := q.QueryContext(ctx, "SELECT slot,gear_key FROM player_wardrobe WHERE account_id=?", account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]string{}
	for rows.Next() {
		var slot, key string
		if err = rows.Scan(&slot, &key); err != nil {
			return nil, err
		}
		out[slot] = key
	}
	return out, rows.Err()
}

// resolvedWardrobe is the choice as it reads right now (4.2): lapsed and
// uncatalogued keys drop out and the stored rows wait for them. Nothing
// chosen answers without touching player_gear — the owned list (about 60 KB
// for a collector) is read only by the wardrobe's operation and read and by
// visualAvatar (4.3, "Sizes").
func resolvedWardrobe(ctx context.Context, q wardrobeReader, account string) (map[string]string, error) {
	rows, err := wardrobeRows(ctx, q, account)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return rows, nil
	}
	owned, _, err := ownedGear(ctx, q, account)
	if err != nil {
		return nil, err
	}
	return rules.Resolve(rows, owned, gearCatalogued), nil
}

// wardrobeProto is the resolved choice on the wire: absent = as on Habitica,
// "none" = nothing worn there, else an owned gear key.
func wardrobeProto(chosen map[string]string) *contract.Wardrobe {
	if chosen == nil {
		chosen = map[string]string{}
	}
	return &contract.Wardrobe{Chosen: chosen}
}

// wardrobeComposition fills PlayerState.wardrobe on every answer (4.4): the
// resolved choice, so the tab, the preview and the world avatar read the same
// thing. Guests keep the wire's null-less empty choice — they have no
// Habitica to dress from (section 5).
type wardrobeComposition struct{ store.StateComposition }

func (w wardrobeComposition) PlayerState(ctx context.Context, tx *sql.Tx, s store.Snapshot) (*contract.PlayerState, error) {
	state, err := w.StateComposition.PlayerState(ctx, tx, s)
	if err != nil {
		return nil, err
	}
	chosen, err := resolvedWardrobe(ctx, tx, s.AccountID)
	if err != nil {
		return nil, err
	}
	state.Wardrobe = wardrobeProto(chosen)
	return state, nil
}

// visualAvatarFor is visualAvatar with the wardrobe resolved from the store
// (4.4): presence carries the resolved look as the costume.
func visualAvatarFor(ctx context.Context, q wardrobeReader, account string, p rules.Profile, c store.Companions) (*presenceAvatarMsg, error) {
	chosen, err := resolvedWardrobe(ctx, q, account)
	if err != nil {
		return nil, err
	}
	return visualAvatar(p, c, chosen), nil
}

// wardrobe is the operation (`POST /api/wardrobe`, 6.2): the whole choice at
// once, a map of slot to key or "none"; slots left out go back to As on
// Habitica. Each key must be in the account's owned list, known to the
// catalog, of that slot's type and not a none-piece (`gear-not-owned`); each
// slot must be one of the drawn eight (`invalid-slot`). No homestead gate —
// clothes work anywhere (question 4). The room hears an avatar change.
func (a *Server) wardrobeMutation(w http.ResponseWriter, r *http.Request) error {
	req := &contract.WardrobeRequest{}
	if err := decodeOp(w, r, req); err != nil {
		return err
	}
	var account string
	var avatar *presenceAvatarMsg
	err := a.keyedOpStay(w, r, req.Op, req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if s.ProfileSource != "habitica" {
			return nil, fail(409, "needs-habitica")
		}
		p := s.ImportedProfile
		if p == nil {
			return nil, fail(409, "needs-habitica")
		}
		owned, _, err := ownedGear(ctx, tx, s.AccountID)
		if err != nil {
			return nil, err
		}
		chosen := req.GetChosen()
		// Refusals in a fixed order (a map walks in no order, so a request
		// with two faults must always answer the same way): every slot name
		// first, then the keys in slot order.
		for slot := range chosen {
			if !rules.IsDrawnSlot(slot) {
				return nil, fail(400, "invalid-slot")
			}
		}
		for _, slot := range rules.DrawnSlots {
			key, sent := chosen[slot]
			if !sent || key == rules.NoGear {
				continue
			}
			if !wearThisSlot(key, slot, owned) {
				return nil, fail(409, "gear-not-owned")
			}
		}
		// The whole choice is written at once: a slot the request leaves out
		// goes back to As on Habitica — except one whose row is currently
		// lapsed (4.2). The client only ever sees the resolved choice, so it
		// cannot send that slot back (and asking for it is refused above):
		// leaving it out means "I didn't touch it", and the row stays until
		// the player changes that slot or presses Wear Habitica's look — an
		// empty choice, which clears every row.
		stored, err := wardrobeRows(ctx, tx, s.AccountID)
		if err != nil {
			return nil, err
		}
		write := map[string]string{}
		if len(chosen) > 0 {
			lapsed := rules.Resolve(stored, owned, gearCatalogued)
			for slot, key := range stored {
				if _, sent := chosen[slot]; !sent {
					if _, visible := lapsed[slot]; !visible {
						write[slot] = key
					}
				}
			}
		}
		for slot, key := range chosen {
			if key != "" {
				write[slot] = key
			}
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM player_wardrobe WHERE account_id=?", s.AccountID); err != nil {
			return nil, err
		}
		for _, slot := range rules.DrawnSlots {
			if key := write[slot]; key != "" {
				if _, err = tx.ExecContext(ctx, "INSERT INTO player_wardrobe(account_id,slot,gear_key) VALUES(?,?,?)", s.AccountID, slot, key); err != nil {
					return nil, err
				}
			}
		}
		resolved := rules.Resolve(write, owned, gearCatalogued)
		c, err := store.CompanionsFor(ctx, tx, s.AccountID, s.WorldID, s.ProfileSource, p)
		if err != nil {
			return nil, err
		}
		account = s.AccountID
		avatar = visualAvatar(*p, c, resolved)
		return &contract.WardrobeResult{Wardrobe: wardrobeProto(resolved)}, nil
	}, func() {
		if avatar != nil {
			a.avatarChanged(account, avatar)
		}
	})
	return err
}

// wardrobeRead (`GET /api/wardrobe`) is what the picker needs: the owned,
// catalogued keys, when the server last read them from Habitica (absent
// before the first check), and the resolved choice.
func (a *Server) wardrobeRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx := r.Context()
	owned, checked, err := ownedGear(ctx, tx, s.AccountID)
	if err != nil {
		return err
	}
	chosen, err := resolvedWardrobe(ctx, tx, s.AccountID)
	if err != nil {
		return err
	}
	out := &contract.WardrobeRead{Owned: owned, Wardrobe: wardrobeProto(chosen)}
	if checked != nil {
		out.CheckedAt = wrapperspb.Double(float64(*checked))
	}
	raw, err := protoResult(out)
	if err != nil {
		return err
	}
	return a.finishRead(w, r, tx, s, raw)
}
