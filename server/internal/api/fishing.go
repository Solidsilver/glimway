package api

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/store"
	"glimway/server/internal/wilds"
	"glimway/server/internal/worldchange"
	"google.golang.org/protobuf/encoding/protojson"
	"net/http"
	"slices"
	"time"
)

// ------------------------------------------------------------ fishing at the mill pond (design 5)
//
// One curated fishery, one rod, one species. The stock is shared world state
// (the mill pond's row is the world-changes table's first writer, 5.4); a
// cast is one account's own row. Time is worked out, never ticked: recovery,
// the bite and the lapse are functions of the clock, computed when someone
// looks, and only an operation that changes stock stores it.

// stillBand is what the wire calls a water with no fish in it: the "still"
// band has no content row (5.4), so the server names it and the client words
// it (lane G reads "still" and "" alike).
const stillBand = "still"

// fisheryKey is where a water's stock lives: one row per world entity, the
// curated place's realm and no chunk or epoch (5.4). No row means untouched.
func fisheryKey(worldID string, w *content.FishWater) worldchange.Key {
	return worldchange.Key{WorldID: worldID, Realm: w.GetArea(), Entity: w.GetId()}
}

// fisheryAt reads a water's stock recovered to `at` — reads compute, only
// writes store (5.3). A pond nobody has fished is full.
func fisheryAt(ctx context.Context, q worldchange.Queryer, worldID string, w *content.FishWater, at float64) (*contract.FisheryState, error) {
	f := &contract.FisheryState{Stock: float64(w.GetCapacity()), At: at}
	row, err := worldchange.Get(ctx, q, fisheryKey(worldID, w), "fishery", int64(at))
	if err != nil {
		return nil, err
	}
	if row != nil {
		f = &contract.FisheryState{}
		if err := protojson.Unmarshal(row.State, f); err != nil {
			return nil, err
		}
		f.Stock = content.Recovered(f.Stock, 1/w.GetRecoverySeconds(), float64(w.GetCapacity()), f.At, at)
	}
	f.At = at
	return f, nil
}

// putFishery stores the recovered stock and the clock it was recovered at
// together (5.3), so the next read carries recovery on from here.
func putFishery(ctx context.Context, e worldchange.Execer, worldID, who string, w *content.FishWater, f *contract.FisheryState, now int64) error {
	raw, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(f)
	if err != nil {
		return err
	}
	return worldchange.Put(ctx, e, worldchange.Row{Key: fisheryKey(worldID, w), Kind: "fishery", State: raw, ChangedBy: who}, now)
}

// changeFishery lets an operation change a water's recovered stock and
// stores it with its clock.
func changeFishery(ctx context.Context, tx *sql.Tx, worldID, who string, w *content.FishWater, at float64, now int64, change func(*contract.FisheryState)) (*contract.FisheryState, error) {
	f, err := fisheryAt(ctx, tx, worldID, w, at)
	if err != nil {
		return nil, err
	}
	change(f)
	return f, putFishery(ctx, tx, worldID, who, w, f, now)
}

// freeFish is what a cast may take: the stock in the water minus the fish
// already on lines (5.3: a reserved fish counts against capacity, so
// recovery can't overfill around it).
func freeFish(f *contract.FisheryState) float64 { return f.Stock - f.Reserved }

// bandFor is the band a water's stock is in (5.3): BandAt on the fullness
// after reserved fish. Nil is "still" — a water with no fish has no band,
// and an empty water refuses.
func bandFor(w *content.FishWater, f *contract.FisheryState) *content.FishBand {
	if freeFish(f) < 1 {
		return nil
	}
	return content.BandAt(100 * freeFish(f) / float64(w.GetCapacity()))
}

// bandID is what the wire carries: the band's id, or stillBand.
func bandID(w *content.FishWater, f *contract.FisheryState) string {
	if b := bandFor(w, f); b != nil {
		return b.GetId()
	}
	return stillBand
}

// ------------------------------------------------------------ the account's casts

type castRow struct {
	ID, Account, World, Water, Bank, Rod, Species, Band, State string
	Seq                                                        int
	StartedAt, ReadyAt, HoldUntil                              float64
}

const castColumns = "id,account_id,world_id,water,bank,rod,species,band,seq,started_at,ready_at,hold_until,state"

func scanCast(row interface{ Scan(...any) error }) (castRow, error) {
	var v castRow
	err := row.Scan(&v.ID, &v.Account, &v.World, &v.Water, &v.Bank, &v.Rod, &v.Species, &v.Band, &v.Seq, &v.StartedAt, &v.ReadyAt, &v.HoldUntil, &v.State)
	return v, err
}

func castProto(v castRow) *contract.FishingCast {
	return &contract.FishingCast{
		Id: v.ID, Water: v.Water, Bank: v.Bank, Species: v.Species,
		StartedAt: v.StartedAt, ReadyAt: v.ReadyAt, HoldUntil: v.HoldUntil, Band: v.Band,
	}
}

// openCast is the caller's own open cast by id. Anything else — another
// account's, one already settled, cancelled or lapsed — answers no-cast
// (5.4).
func openCast(ctx context.Context, tx *sql.Tx, account, id string) (castRow, error) {
	if id == "" {
		return castRow{}, fail(409, "no-cast")
	}
	v, err := scanCast(tx.QueryRowContext(ctx, "SELECT "+castColumns+" FROM fishing_casts WHERE id=? AND account_id=? AND state='open'", id, account))
	if errors.Is(err, sql.ErrNoRows) {
		return castRow{}, fail(409, "no-cast")
	}
	return v, err
}

// closeCasts closes every open cast the filter names and gives each reserved
// fish back to its water: 'lapsed' when the hold ran out (a ready fish waits
// holdSeconds after the bite, then slips back), 'cancelled' when a world
// move pulled the line in (5.4).
func closeCasts(ctx context.Context, tx *sql.Tx, at float64, now int64, to, filter string, args ...any) error {
	rows, err := tx.QueryContext(ctx, "SELECT id,account_id,world_id,water FROM fishing_casts WHERE state='open' AND "+filter, args...)
	if err != nil {
		return err
	}
	found := []struct{ id, account, world, water string }{}
	for rows.Next() {
		var v struct{ id, account, world, water string }
		if err := rows.Scan(&v.id, &v.account, &v.world, &v.water); err != nil {
			rows.Close()
			return err
		}
		found = append(found, v)
	}
	if err := rows.Err(); err != nil {
		rows.Close()
		return err
	}
	rows.Close()
	for _, v := range found {
		res, err := tx.ExecContext(ctx, "UPDATE fishing_casts SET state=?,closed_at=? WHERE id=? AND state='open'", to, now, v.id)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		if n != 1 {
			continue
		}
		w, ok := content.WaterFor(v.water)
		if !ok {
			return fmt.Errorf("fishing: %s is not a water", v.water)
		}
		if _, err := changeFishery(ctx, tx, v.world, v.account, w, at, now, func(f *contract.FisheryState) {
			f.Reserved = max(0, f.Reserved-1)
		}); err != nil {
			return err
		}
	}
	return nil
}

// lapseCasts is the lazy lapse (5.4): a cast past hold_until is closed and
// its fish returned by the next operation or read that touches that water or
// that account. Nothing runs on a timer; the filter and args name the casts.
func lapseCasts(ctx context.Context, tx *sql.Tx, at float64, now int64, filter string, args ...any) error {
	return closeCasts(ctx, tx, at, now, "lapsed", "hold_until<=? AND "+filter, append([]any{at}, args...)...)
}

// closeOpenCasts is a world move pulling the line in (5.4): every open cast
// of the account closes as cancelled and its fish goes back.
func closeOpenCasts(ctx context.Context, tx *sql.Tx, account string, at float64, now int64) error {
	return closeCasts(ctx, tx, at, now, "cancelled", "account_id=?", account)
}

// ------------------------------------------------------------ the rod

// fishingRod runs useTool's checks without the wear (5.4): the rod is one of
// the caller's instances in their pack, a tool with the fish action, with a
// use left. settle wears it for real.
func fishingRod(ctx context.Context, tx *sql.Tx, s *store.Snapshot, id string, now int64) error {
	if err := healWardens(ctx, tx, s.AccountID, now); err != nil {
		return err
	}
	v, err := loadInstance(ctx, tx, id)
	if err != nil {
		return err
	}
	def, ok := content.ItemFor(v.Def)
	if !ok || v.Location != "pack" || v.Owner != s.AccountID {
		return fail(404, "item-not-found")
	}
	if def.GetKind() != "tool" {
		return fail(409, "not-a-tool")
	}
	if !slices.Contains(def.Actions, "fish") {
		return fail(409, "wrong-tool")
	}
	fittings, err := fittingRows(ctx, tx, v.ID)
	if err != nil {
		return err
	}
	if v.Condition == 0 && !hasFitting(fittings, "remember") {
		return fail(409, "tool-blunt")
	}
	return nil
}

// rollSpecies is the species roll (5.2): weighted from the water's table and
// seeded by the account's cast sequence, so a cast's roll is its own and a
// retried cast keeps it. (The table's weights carry the roll in 0.5; the
// habitat and fullness weighting of fishing.md's model has no columns yet —
// the pond's table has one row.)
func rollSpecies(w *content.FishWater, account string, seq int) string {
	species := w.GetSpecies()
	total := 0
	for _, sp := range species {
		total += int(sp.GetWeight())
	}
	n := wilds.NewRng(wilds.Hash(account, seq)).NextInt(max(1, total))
	for _, sp := range species {
		n -= int(sp.GetWeight())
		if n < 0 {
			return sp.GetItem()
		}
	}
	return species[len(species)-1].GetItem()
}

// nearBank is where a cast may be made from (5.4): in the water's area and
// within reachTiles of one of the bank's tiles, measured to the tile's
// centre as nearTile measures (lane G's bankDistance is the same measure).
func nearBank(s *store.Snapshot, w *content.FishWater, b *content.FishBank) bool {
	if s.State.Area != w.GetArea() {
		return false
	}
	reach := content.FishingRules.GetReachTiles() * wildsTileSize
	for _, t := range b.GetTiles() {
		dx := s.State.Position.X - float64(int(t.GetTx())*wildsTileSize+wildsTileSize/2)
		dy := s.State.Position.Y - float64(int(t.GetTy())*wildsTileSize+wildsTileSize/2)
		if dx*dx+dy*dy <= reach*reach {
			return true
		}
	}
	return false
}

// ------------------------------------------------------------ the three operations (6.2)

// fishCast (POST /api/fishing/cast) puts the line out. The checks run in the
// design's order (5.4): the rod, then the bank — on that water, open in
// today's mark, and where the hero stands — then one open cast, the spacing,
// and a free fish. The band and its wait freeze on the cast (a retry can't
// reroll them) and the fish is reserved, so a friend can't take it during
// the wait.
func (a *Server) fishCast(w http.ResponseWriter, r *http.Request) error {
	var req contract.FishCastRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	at := float64(a.Config.Now().UnixNano()) / 1e9
	return a.keyedOp(w, r, req.Op, req.Where, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := lapseCasts(ctx, tx, at, now, "account_id=?", s.AccountID); err != nil {
			return nil, err
		}
		if err := fishingRod(ctx, tx, s, req.Rod, now); err != nil {
			return nil, err
		}
		water, ok := content.WaterFor(req.Water)
		if !ok {
			return nil, fail(400, "invalid-request")
		}
		bank, ok := content.BankFor(water, req.Bank)
		if !ok {
			return nil, fail(400, "invalid-request")
		}
		if slices.Contains(bank.GetClosedIn(), content.CalendarAt(content.CalendarRules, now).Mark) {
			return nil, fail(409, "not-in-season")
		}
		if !nearBank(s, water, bank) {
			return nil, fail(409, "too-far-away")
		}
		var open string
		err := tx.QueryRowContext(ctx, "SELECT id FROM fishing_casts WHERE account_id=? AND state='open'", s.AccountID).Scan(&open)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if err == nil {
			return nil, fail(409, "already-casting")
		}
		var seq int
		var last sql.NullFloat64
		err = tx.QueryRowContext(ctx, "SELECT cast_seq,last_start FROM player_fishing WHERE account_id=?", s.AccountID).Scan(&seq, &last)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return nil, err
		}
		if last.Valid && at-last.Float64 < content.FishingRules.GetCastSpacingSeconds() {
			return nil, fail(409, "cast-too-soon")
		}
		// The band is read before the reservation (5.3) and frozen with its
		// wait; hold_until runs from the bite (5.3's table).
		f, err := fisheryAt(ctx, tx, s.WorldID, water, at)
		if err != nil {
			return nil, err
		}
		band := bandFor(water, f)
		if band == nil {
			return nil, fail(409, "water-still")
		}
		id, err := store.Random()
		if err != nil {
			return nil, err
		}
		cast := &contract.FishingCast{
			Id: "cast:" + id, Water: water.GetId(), Bank: bank.GetId(),
			Species:   rollSpecies(water, s.AccountID, seq),
			StartedAt: at, ReadyAt: at + band.GetWaitSeconds(),
			HoldUntil: at + band.GetWaitSeconds() + content.FishingRules.GetHoldSeconds(),
			Band:      band.GetId(),
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO fishing_casts(id,account_id,world_id,water,bank,rod,species,band,seq,started_at,ready_at,hold_until,state)
 VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, cast.Id, s.AccountID, s.WorldID, water.GetId(), bank.GetId(), req.Rod, cast.Species, cast.Band, seq, cast.StartedAt, cast.ReadyAt, cast.HoldUntil, "open"); err != nil {
			return nil, err
		}
		// The cast reserves its fish; the fullness the band came from was
		// the one before this (5.3).
		if _, err := changeFishery(ctx, tx, s.WorldID, s.AccountID, water, at, now, func(f *contract.FisheryState) {
			f.Reserved += 1
		}); err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, `INSERT INTO player_fishing(account_id,cast_seq,last_start) VALUES(?,?,?)
 ON CONFLICT(account_id) DO UPDATE SET cast_seq=excluded.cast_seq,last_start=excluded.last_start`, s.AccountID, seq+1, at); err != nil {
			return nil, err
		}
		return &contract.FishCastResult{Cast: cast, Band: cast.Band}, nil
	})
}

// fishSettle (POST /api/fishing/settle) keeps the fish or lets it go (5.4).
// The cast is the caller's and open (else no-cast); now is at least ready_at
// (else not-yet) and before hold_until — past it the cast has lapsed, and
// the lazy lapse above closed it, so the answer is no-cast.
func (a *Server) fishSettle(w http.ResponseWriter, r *http.Request) error {
	var req contract.FishSettleRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	at := float64(a.Config.Now().UnixNano()) / 1e9
	return a.keyedOp(w, r, req.Op, req.Where, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := lapseCasts(ctx, tx, at, now, "account_id=?", s.AccountID); err != nil {
			return nil, err
		}
		c, err := openCast(ctx, tx, s.AccountID, req.Cast)
		if err != nil {
			return nil, err
		}
		if at < c.ReadyAt {
			return nil, fail(409, "not-yet")
		}
		water, ok := content.WaterFor(c.Water)
		if !ok {
			return nil, fmt.Errorf("fishing: %s is not a water", c.Water)
		}
		out := &contract.FishSettleResult{Cast: c.ID, Kept: req.Keep}
		if req.Keep {
			// One use of the rod per kept fish (5.2). A rod that has left
			// the pack can't wear one: it is a wrong tool now (5.4).
			if err := fishingRod(ctx, tx, s, c.Rod, now); err != nil {
				var f *failure
				if errors.As(err, &f) && f.code == "item-not-found" {
					err = fail(409, "wrong-tool")
				}
				if err != nil {
					return nil, err
				}
			}
			res, err := useTool(ctx, tx, s, c.Rod, "fish", now)
			if err != nil {
				return nil, err
			}
			out.Wear = wearProto(&res)
			out.Item = c.Species
			if err := itemChange(ctx, tx, s, c.Species, 1, "fish", c.ID, now); err != nil {
				return nil, err
			}
		}
		// Keep takes the fish out of the water; letting it go gives the
		// reserved fish back (5.3). Either way the cast closes.
		f, err := changeFishery(ctx, tx, s.WorldID, s.AccountID, water, at, now, func(f *contract.FisheryState) {
			if req.Keep {
				f.Stock = max(0, f.Stock-1)
			}
			f.Reserved = max(0, f.Reserved-1)
		})
		if err != nil {
			return nil, err
		}
		state := "released"
		if req.Keep {
			state = "kept"
		}
		if _, err := tx.ExecContext(ctx, "UPDATE fishing_casts SET state=?,closed_at=? WHERE id=? AND state='open'", state, now, c.ID); err != nil {
			return nil, err
		}
		out.Band = bandID(water, f)
		return out, nil
	})
}

// fishCancel (POST /api/fishing/cancel) pulls the line in and gives the fish
// back (5.4). The request carries no where — the line comes in wherever the
// hero is — so the place stays as the server has it. A cast already closed
// answers its stored result (it is idempotent by key) or no-cast.
func (a *Server) fishCancel(w http.ResponseWriter, r *http.Request) error {
	var req contract.FishCancelRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	at := float64(a.Config.Now().UnixNano()) / 1e9
	return a.keyedOpStay(w, r, req.Op, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if err := lapseCasts(ctx, tx, at, now, "account_id=?", s.AccountID); err != nil {
			return nil, err
		}
		c, err := openCast(ctx, tx, s.AccountID, req.Cast)
		if err != nil {
			return nil, err
		}
		water, ok := content.WaterFor(c.Water)
		if !ok {
			return nil, fmt.Errorf("fishing: %s is not a water", c.Water)
		}
		f, err := changeFishery(ctx, tx, s.WorldID, s.AccountID, water, at, now, func(f *contract.FisheryState) {
			f.Reserved = max(0, f.Reserved-1)
		})
		if err != nil {
			return nil, err
		}
		if _, err := tx.ExecContext(ctx, "UPDATE fishing_casts SET state='cancelled',closed_at=? WHERE id=? AND state='open'", now, c.ID); err != nil {
			return nil, err
		}
		return &contract.FishCancelResult{Cast: c.ID, Band: bandID(water, f)}, nil
	})
}

// fishingWaters (GET /api/fishing/waters?area=) answers each water's band,
// and nothing else: no counts, no countdown (5.4). The read touches the
// waters, so their lapsed casts close first and their fish go back — the
// band is the one after that.
func (a *Server) fishingWaters(w http.ResponseWriter, r *http.Request) error {
	area := r.URL.Query().Get("area")
	if area == "" || !validArea(area) {
		return fail(400, "invalid-request")
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	at := float64(a.Config.Now().UnixNano()) / 1e9
	now := a.Config.Now().Unix()
	out := &contract.FishingWaters{Waters: []*contract.WaterView{}}
	for _, water := range content.FishingRules.GetWaters() {
		if water.GetArea() != area {
			continue
		}
		if err := lapseCasts(r.Context(), tx, at, now, "world_id=? AND water=?", s.WorldID, water.GetId()); err != nil {
			return err
		}
		f, err := fisheryAt(r.Context(), tx, s.WorldID, water, at)
		if err != nil {
			return err
		}
		out.Waters = append(out.Waters, &contract.WaterView{Id: water.GetId(), Band: bandID(water, f)})
	}
	// The answer is the plain waters message (lane G decodes it as one):
	// each water's band, and nothing else.
	return a.finish(w, r, tx, out)
}

// ------------------------------------------------------------ PlayerState.fishing (5.5)

// fishingStateFor is the account's fishing state: the open cast (a reload at
// the bank puts the float back, and a cast out on another device shows here
// too) and the earliest time the next cast may start. The lazy lapse runs
// first — the state read touches the account (5.4) — so a cast past its hold
// reads as gone and its fish is back in the water.
func fishingStateFor(ctx context.Context, tx *sql.Tx, account string, at float64, now int64) (*contract.FishingState, error) {
	if err := lapseCasts(ctx, tx, at, now, "account_id=?", account); err != nil {
		return nil, err
	}
	out := &contract.FishingState{}
	c, err := scanCast(tx.QueryRowContext(ctx, "SELECT "+castColumns+" FROM fishing_casts WHERE account_id=? AND state='open'", account))
	if err == nil {
		out.Cast = castProto(c)
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	var last sql.NullFloat64
	if err := tx.QueryRowContext(ctx, "SELECT last_start FROM player_fishing WHERE account_id=?", account).Scan(&last); err != nil && !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if last.Valid {
		out.NextCastAt = last.Float64 + content.FishingRules.GetCastSpacingSeconds()
	}
	return out, nil
}

// fishingComposition fills PlayerState.fishing on every answer (5.5): the
// open cast and the cast spacing. Fishing is the account's, not a screen's,
// so a reload or another device shows the same line.
type fishingComposition struct {
	store.StateComposition
	now func() time.Time
}

func (f fishingComposition) PlayerState(ctx context.Context, tx *sql.Tx, s store.Snapshot) (*contract.PlayerState, error) {
	state, err := f.StateComposition.PlayerState(ctx, tx, s)
	if err != nil || s.AccountID == "" {
		return state, err
	}
	t := f.now()
	fishing, err := fishingStateFor(ctx, tx, s.AccountID, float64(t.UnixNano())/1e9, t.Unix())
	if err != nil {
		return nil, err
	}
	state.Fishing = fishing
	return state, nil
}
