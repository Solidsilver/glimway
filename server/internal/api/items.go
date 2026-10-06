package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
	"math"
	"net/http"
	"slices"
	"strings"
)

// The item system core (docs/items/): instances with condition, fittings
// and a maker; wear, breaking and blunting; mending at the bench or by a
// mender; consumables; handing things over; pockets and the off hand; and
// pickups lying in the world. Every change is a keyed mutation.

// ------------------------------------------------------------ instances

// instanceAt is where an instance lies: a pack, a chest or a parcel (owner:
// the player or the home), or 'fitted' on a tool (owner: the tool's id).
type instanceAt struct{ location, owner string }

func (h holder) instancePlace() instanceAt {
	switch h.location {
	case "inventory":
		return instanceAt{"pack", h.player}
	case "storage":
		return instanceAt{"storage", h.home}
	}
	return instanceAt{h.location, h.player}
}

type makerView struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}
type fittingView struct {
	ID           string     `json:"id"`
	ItemDef      string     `json:"itemDef"`
	Fitting      string     `json:"fitting"`
	Condition    int        `json:"condition"`
	MaxCondition int        `json:"maxCondition"`
	UsesLeft     int        `json:"usesLeft"`
	Maker        *makerView `json:"maker"`
}

// instanceView: condition in wear points; usesLeft at today's rate; state
// is whole, worn, blunt, cracked or dull (a warden-set tool at zero).
type instanceView struct {
	ID           string        `json:"id"`
	ItemDef      string        `json:"itemDef"`
	Condition    int           `json:"condition"`
	MaxCondition int           `json:"maxCondition"`
	UsesLeft     int           `json:"usesLeft"`
	State        string        `json:"state"`
	WardenSet    bool          `json:"wardenSet"`
	Fittings     []fittingView `json:"fittings"`
	Maker        *makerView    `json:"maker"`
}

type instanceRow struct {
	ID, Def, Location, Owner string
	Condition, Max           int
	Maker                    string
	WornDay                  int64
}

func scanInstance(row interface{ Scan(...any) error }) (instanceRow, error) {
	var v instanceRow
	err := row.Scan(&v.ID, &v.Def, &v.Location, &v.Owner, &v.Condition, &v.Max, &v.Maker, &v.WornDay)
	return v, err
}

const instanceColumns = "id,item_def,location,owner,condition,max_condition,maker_id,worn_day"

func loadInstance(ctx context.Context, tx *sql.Tx, id string) (instanceRow, error) {
	v, err := scanInstance(tx.QueryRowContext(ctx, "SELECT "+instanceColumns+" FROM item_instances WHERE id=?", id))
	if err == sql.ErrNoRows {
		return v, fail(404, "item-not-found")
	}
	return v, err
}
func fittingRows(ctx context.Context, tx *sql.Tx, tool string) ([]instanceRow, error) {
	rows, err := tx.QueryContext(ctx, "SELECT "+instanceColumns+" FROM item_instances WHERE location='fitted' AND owner=? ORDER BY item_def,id", tool)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []instanceRow{}
	for rows.Next() {
		v, err := scanInstance(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// newInstance makes one instance at a place; condition < 0 means full.
func newInstance(ctx context.Context, tx *sql.Tx, def content.ItemDef, at instanceAt, maker string, condition int, now int64) (string, error) {
	id, err := store.Random()
	if err != nil {
		return "", err
	}
	full := def.MaxPoints()
	if condition < 0 || condition > full {
		condition = full
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO item_instances(id,item_def,location,owner,condition,max_condition,maker_id,created_at) VALUES(?,?,?,?,?,?,?,?)", id, def.ID, at.location, at.owner, condition, full, maker, now)
	return id, err
}

// moveInstance moves one instance (its fittings travel with it); anything
// that leaves a pack leaves that player's pockets and off hand too.
func moveInstance(ctx context.Context, tx *sql.Tx, id, def string, from, to instanceAt) error {
	res, err := tx.ExecContext(ctx, "UPDATE item_instances SET location=?,owner=? WHERE id=? AND item_def=? AND location=? AND owner=?", to.location, to.owner, id, def, from.location, from.owner)
	if err != nil {
		return err
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n != 1 {
		return fail(409, "item-not-available")
	}
	if from.location == "pack" {
		_, err = tx.ExecContext(ctx, "DELETE FROM item_slots WHERE instance_id=?", id)
	}
	return err
}

func makerOf(ctx context.Context, tx *sql.Tx, id string, cache map[string]*makerView) (*makerView, error) {
	if id == "" {
		return nil, nil
	}
	if v, ok := cache[id]; ok {
		return v, nil
	}
	var name string
	err := tx.QueryRowContext(ctx, "SELECT display_name FROM players WHERE habitica_id=?", id).Scan(&name)
	if err == sql.ErrNoRows {
		cache[id] = nil
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	v := &makerView{id, capDonor(name)}
	cache[id] = v
	return v, nil
}

func hasFitting(fittings []instanceRow, kind string) bool {
	return slices.ContainsFunc(fittings, func(f instanceRow) bool {
		d, _ := content.ItemFor(f.Def)
		return d.Fitting == kind
	})
}

// wearCost is the points one use takes off a tool: less with a Hold fitting;
// a warden-set tool dulls from sharp in rules.wear.wardenDullUses uses (half
// as fast with Hold).
func wearCost(max int, fittings []instanceRow) int {
	w := content.ItemsRules.Rules.Wear
	hold := hasFitting(fittings, "hold")
	if hasFitting(fittings, "remember") {
		cost := int(math.Ceil(float64(max) / float64(w.WardenDullUses)))
		if hold {
			cost = (cost + 1) / 2
		}
		return max1(cost)
	}
	if hold {
		return w.HoldPointsPerUse
	}
	return w.PointsPerUse
}
func max1(n int) int { return max(1, n) }
func usesLeft(condition, cost int) int {
	return (condition + cost - 1) / max1(cost)
}

func toolState(def content.ItemDef, v instanceRow, warden bool) string {
	if v.Max == 0 {
		return "whole"
	}
	if v.Condition == 0 {
		if warden {
			return "dull"
		}
		if r := def.AtZeroRule(); r == "blunt" || r == "cracked" {
			return r
		}
		return "worn"
	}
	if v.Condition*100 < v.Max*content.ItemsRules.Rules.Wear.WornBelowPercent {
		return "worn"
	}
	return "whole"
}

func viewInstance(ctx context.Context, tx *sql.Tx, v instanceRow, makers map[string]*makerView) (instanceView, error) {
	def, _ := content.ItemFor(v.Def)
	fittings, err := fittingRows(ctx, tx, v.ID)
	if err != nil {
		return instanceView{}, err
	}
	warden := hasFitting(fittings, "remember")
	out := instanceView{ID: v.ID, ItemDef: v.Def, Condition: v.Condition, MaxCondition: v.Max, State: toolState(def, v, warden), WardenSet: warden, Fittings: []fittingView{}}
	if v.Max > 0 {
		out.UsesLeft = usesLeft(v.Condition, wearCost(v.Max, fittings))
	}
	if out.Maker, err = makerOf(ctx, tx, v.Maker, makers); err != nil {
		return out, err
	}
	for _, f := range fittings {
		fd, _ := content.ItemFor(f.Def)
		fv := fittingView{ID: f.ID, ItemDef: f.Def, Fitting: fd.Fitting, Condition: f.Condition, MaxCondition: f.Max}
		if f.Max > 0 {
			fv.UsesLeft = usesLeft(f.Condition, content.ItemsRules.Rules.Wear.PointsPerUse)
		}
		if fv.Maker, err = makerOf(ctx, tx, f.Maker, makers); err != nil {
			return out, err
		}
		out.Fittings = append(out.Fittings, fv)
	}
	return out, nil
}

// instancesAt lists the instances lying at a place, fittings included.
func instancesAt(ctx context.Context, tx *sql.Tx, at instanceAt) ([]instanceView, error) {
	rows, err := tx.QueryContext(ctx, "SELECT "+instanceColumns+" FROM item_instances WHERE location=? AND owner=? ORDER BY item_def,created_at,id", at.location, at.owner)
	if err != nil {
		return nil, err
	}
	list := []instanceRow{}
	for rows.Next() {
		v, err := scanInstance(rows)
		if err != nil {
			rows.Close()
			return nil, err
		}
		list = append(list, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return nil, err
	}
	out := []instanceView{}
	makers := map[string]*makerView{}
	for _, v := range list {
		iv, err := viewInstance(ctx, tx, v, makers)
		if err != nil {
			return nil, err
		}
		out = append(out, iv)
	}
	return out, nil
}

// ------------------------------------------------------------ wear

func utcDay(now int64) int64 { return now / 86400 }

// healWardens: warden-set tools in a pack are sharp again the morning after.
func healWardens(ctx context.Context, tx *sql.Tx, player string, now int64) error {
	_, err := tx.ExecContext(ctx, `UPDATE item_instances SET condition=max_condition WHERE location='pack' AND owner=? AND worn_day<? AND condition<max_condition
 AND EXISTS(SELECT 1 FROM item_instances f WHERE f.location='fitted' AND f.owner=item_instances.id AND f.item_def IN (`+wardenDefs()+`))`, player, utcDay(now))
	return err
}
func wardenDefs() string {
	ids := []string{}
	for _, d := range content.ItemsRules.Items {
		if d.Fitting == "remember" {
			ids = append(ids, "'"+d.ID+"'")
		}
	}
	if len(ids) == 0 {
		return "''"
	}
	return strings.Join(ids, ",")
}

type wearResult struct {
	Broke     bool          `json:"broke"`
	State     string        `json:"state"`
	WornOut   []string      `json:"wornOut"`
	Instance  *instanceView `json:"instance"`
	Returned  []string      `json:"returned"`
	ItemDef   string        `json:"itemDef"`
	UsesLeft  int           `json:"usesLeft"`
	Condition int           `json:"condition"`
}

// useTool spends one use of a tool in the caller's pack. The use that
// reaches zero still happens; then a cheap tool breaks (its fittings drop
// into the pack) and an heirloom is blunt (or cracked) until mended. A
// warden-set tool only dulls. Fittings wear on their own count and fall
// away worn out; a warden-stone sliver never wears.
func useTool(ctx context.Context, tx *sql.Tx, s *store.Snapshot, id, action string, now int64) (wearResult, error) {
	out := wearResult{WornOut: []string{}, Returned: []string{}}
	if err := healWardens(ctx, tx, s.HabiticaID, now); err != nil {
		return out, err
	}
	v, err := loadInstance(ctx, tx, id)
	if err != nil {
		return out, err
	}
	def, _ := content.ItemFor(v.Def)
	if v.Location != "pack" || v.Owner != s.HabiticaID {
		return out, fail(404, "item-not-found")
	}
	if def.Kind != "tool" {
		return out, fail(409, "not-a-tool")
	}
	if action != "" && !slices.Contains(def.Actions, action) {
		return out, fail(409, "wrong-tool")
	}
	if action == "draw" {
		if !nearTile(s, "village", 13, 12, 4) {
			return out, fail(409, "too-far-away")
		}
		var mendedAt sql.NullInt64
		err = tx.QueryRowContext(ctx, "SELECT mended_at FROM village_repairs WHERE world_id=? AND repair_id='well-rope'", s.WorldID).Scan(&mendedAt)
		if err == sql.ErrNoRows || !mendedAt.Valid {
			return out, fail(409, "well-rope-broken")
		}
		if err != nil {
			return out, err
		}
	}
	out.ItemDef = v.Def
	fittings, err := fittingRows(ctx, tx, v.ID)
	if err != nil {
		return out, err
	}
	warden := hasFitting(fittings, "remember")
	if v.Max > 0 {
		if v.Condition == 0 && !warden {
			return out, fail(409, "tool-blunt")
		}
		v.Condition = max(0, v.Condition-wearCost(v.Max, fittings))
		if _, err = tx.ExecContext(ctx, "UPDATE item_instances SET condition=?,worn_day=? WHERE id=?", v.Condition, utcDay(now), v.ID); err != nil {
			return out, err
		}
	}
	// Fittings wear on their own.
	per := content.ItemsRules.Rules.Wear.PointsPerUse
	for _, f := range fittings {
		if f.Max == 0 {
			continue
		}
		left := f.Condition - per
		if left > 0 {
			if _, err = tx.ExecContext(ctx, "UPDATE item_instances SET condition=? WHERE id=?", left, f.ID); err != nil {
				return out, err
			}
			continue
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM item_instances WHERE id=?", f.ID); err != nil {
			return out, err
		}
		if err = currency(ctx, tx, s.HabiticaID, "fitted:"+f.Def, -1, "fitting-worn", v.ID, now); err != nil {
			return out, err
		}
		out.WornOut = append(out.WornOut, f.Def)
	}
	if v.Max > 0 && v.Condition == 0 && !warden && def.AtZeroRule() == "breaks" {
		// Broken and gone. Whatever was fitted drops into the pack.
		remaining, err := fittingRows(ctx, tx, v.ID)
		if err != nil {
			return out, err
		}
		for _, f := range remaining {
			if err = moveInstance(ctx, tx, f.ID, f.Def, instanceAt{"fitted", v.ID}, instanceAt{"pack", s.HabiticaID}); err != nil {
				return out, err
			}
			if err = currency(ctx, tx, s.HabiticaID, "fitted:"+f.Def, -1, "tool-broke", v.ID, now); err != nil {
				return out, err
			}
			if err = currency(ctx, tx, s.HabiticaID, content.StackCurrency(f.Def), 1, "tool-broke", v.ID, now); err != nil {
				return out, err
			}
			out.Returned = append(out.Returned, f.Def)
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM item_slots WHERE instance_id=?", v.ID); err != nil {
			return out, err
		}
		if _, err = tx.ExecContext(ctx, "DELETE FROM item_instances WHERE id=?", v.ID); err != nil {
			return out, err
		}
		out.Broke = true
		out.State = "broken"
		return out, currency(ctx, tx, s.HabiticaID, content.StackCurrency(v.Def), -1, "tool-broke", v.ID, now)
	}
	view, err := viewInstance(ctx, tx, v, map[string]*makerView{})
	if err != nil {
		return out, err
	}
	out.Instance = &view
	out.State = view.State
	out.UsesLeft = view.UsesLeft
	out.Condition = view.Condition
	return out, nil
}

// ------------------------------------------------------------ position

// near: the caller's last uploaded spot is in an area, within r tiles of a tile.
func nearTile(s *store.Snapshot, area string, tx, ty, r int) bool {
	if s.State.Area != area {
		return false
	}
	cx, cy := float64(tx*wildsTileSize+wildsTileSize/2), float64(ty*wildsTileSize+wildsTileSize/2)
	dx, dy := s.State.Position.X-cx, s.State.Position.Y-cy
	rr := float64(r * wildsTileSize)
	return dx*dx+dy*dy <= rr*rr
}

func offHandOpen(s *store.Snapshot) (bool, *string) {
	if s.ImportedProfile == nil || s.ImportedProfile.Class == nil || *s.ImportedProfile.Class == "" {
		return false, nil
	}
	return true, s.ImportedProfile.Class
}

// ------------------------------------------------------------ pockets and the off hand

func carriesGear(ctx context.Context, tx *sql.Tx, player string) (bool, error) {
	ids := []string{}
	for _, d := range content.ItemsRules.Items {
		if d.Kind == "carry-gear" {
			ids = append(ids, "'"+d.ID+"'")
		}
	}
	if len(ids) == 0 {
		return false, nil
	}
	var n int
	err := tx.QueryRowContext(ctx, "SELECT count(*) FROM item_instances WHERE location='pack' AND owner=? AND item_def IN ("+strings.Join(ids, ",")+")", player).Scan(&n)
	return n > 0, err
}
func pocketCount(ctx context.Context, tx *sql.Tx, player string) (int, error) {
	gear, err := carriesGear(ctx, tx, player)
	if gear {
		return content.ItemsRules.Rules.Pockets.WithCarryGear, err
	}
	return content.ItemsRules.Rules.Pockets.Base, err
}

type slotRow struct {
	slot, def string
	instance  sql.NullString
}

func slots(ctx context.Context, tx *sql.Tx, player string) ([]slotRow, error) {
	rows, err := tx.QueryContext(ctx, "SELECT slot,item_def,instance_id FROM item_slots WHERE habitica_id=? ORDER BY slot", player)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []slotRow{}
	for rows.Next() {
		var v slotRow
		if err = rows.Scan(&v.slot, &v.def, &v.instance); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// slotHolds: the thing a slot points at is still in the pack and allowed there.
func slotHolds(ctx context.Context, tx *sql.Tx, player string, v slotRow) (bool, error) {
	def, ok := content.ItemFor(v.def)
	if !ok {
		return false, nil
	}
	if v.instance.Valid {
		var n int
		err := tx.QueryRowContext(ctx, "SELECT count(*) FROM item_instances WHERE id=? AND item_def=? AND location='pack' AND owner=?", v.instance.String, v.def, player).Scan(&n)
		return n == 1 && v.slot == "off-hand" && def.OffHandable(), err
	}
	n, err := stackTotal(ctx, tx, packOf(player), v.def)
	if v.slot == "off-hand" {
		return n > 0 && def.OffHandable() && def.Kind == "keepsake", err
	}
	return n > 0 && def.Kind == "keepsake", err
}

// settleSlots drops anything a pocket or the off hand points at that is no
// longer carried or allowed: a second pocket without carry gear, an off hand
// without a class.
func settleSlots(ctx context.Context, tx *sql.Tx, s *store.Snapshot) error {
	list, err := slots(ctx, tx, s.HabiticaID)
	if err != nil || len(list) == 0 {
		return err
	}
	pockets, err := pocketCount(ctx, tx, s.HabiticaID)
	if err != nil {
		return err
	}
	open, _ := offHandOpen(s)
	pocketed := map[string]bool{}
	for _, v := range list {
		keep, err := slotHolds(ctx, tx, s.HabiticaID, v)
		if err != nil {
			return err
		}
		switch v.slot {
		case "off-hand":
			keep = keep && open
		case "pocket-2":
			keep = keep && pockets >= 2 && !pocketed[v.def]
		}
		if v.slot != "off-hand" && keep {
			pocketed[v.def] = true
		}
		if !keep {
			if _, err = tx.ExecContext(ctx, "DELETE FROM item_slots WHERE habitica_id=? AND slot=?", s.HabiticaID, v.slot); err != nil {
				return err
			}
		}
	}
	return nil
}

// ------------------------------------------------------------ the view

type stackView struct {
	ItemDef string     `json:"itemDef"`
	Qty     int        `json:"qty"`
	Maker   *makerView `json:"maker"`
}
type slotView struct {
	Slot     string  `json:"slot"`
	ItemDef  *string `json:"itemDef"`
	Instance *string `json:"instance"`
}
type offHandView struct {
	Open     bool    `json:"open"`
	Class    *string `json:"class"`
	ItemDef  *string `json:"itemDef"`
	Instance *string `json:"instance"`
}
type thanksView struct {
	FromName string `json:"fromName"`
	ItemDef  string `json:"itemDef"`
	At       int64  `json:"at"`
}
type itemsView struct {
	Stacks    []stackView    `json:"stacks"`
	Instances []instanceView `json:"instances"`
	Pockets   []slotView     `json:"pockets"`
	OffHand   offHandView    `json:"offHand"`
	PickedUp  []string       `json:"pickedUp"`
	Thanks    []thanksView   `json:"thanks"`
}

func readItems(ctx context.Context, tx *sql.Tx, s *store.Snapshot) (itemsView, error) {
	v := itemsView{Stacks: []stackView{}, Pockets: []slotView{}, PickedUp: []string{}, Thanks: []thanksView{}}
	makers := map[string]*makerView{}
	rows, err := tx.QueryContext(ctx, "SELECT item_def,maker_id,qty FROM item_stacks WHERE location='pack' AND owner=? ORDER BY item_def,maker_id", s.HabiticaID)
	if err != nil {
		return v, err
	}
	type raw struct {
		def, maker string
		qty        int
	}
	list := []raw{}
	for rows.Next() {
		var r raw
		if err = rows.Scan(&r.def, &r.maker, &r.qty); err != nil {
			rows.Close()
			return v, err
		}
		list = append(list, r)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return v, err
	}
	for _, r := range list {
		if _, ok := content.ItemFor(r.def); !ok {
			continue
		}
		m, err := makerOf(ctx, tx, r.maker, makers)
		if err != nil {
			return v, err
		}
		v.Stacks = append(v.Stacks, stackView{r.def, r.qty, m})
	}
	if v.Instances, err = instancesAt(ctx, tx, instanceAt{"pack", s.HabiticaID}); err != nil {
		return v, err
	}
	pockets, err := pocketCount(ctx, tx, s.HabiticaID)
	if err != nil {
		return v, err
	}
	held, err := slots(ctx, tx, s.HabiticaID)
	if err != nil {
		return v, err
	}
	at := func(slot string) (*string, *string) {
		for _, h := range held {
			if h.slot == slot {
				def := h.def
				var inst *string
				if h.instance.Valid {
					inst = &h.instance.String
				}
				return &def, inst
			}
		}
		return nil, nil
	}
	for i := 1; i <= pockets; i++ {
		slot := "pocket-" + string(rune('0'+i))
		def, _ := at(slot)
		v.Pockets = append(v.Pockets, slotView{Slot: slot, ItemDef: def})
	}
	v.OffHand.Open, v.OffHand.Class = offHandOpen(s)
	if v.OffHand.Open {
		v.OffHand.ItemDef, v.OffHand.Instance = at("off-hand")
	}
	rows, err = tx.QueryContext(ctx, "SELECT substr(outcome_id,8) FROM outcomes WHERE habitica_id=? AND outcome_id LIKE 'pickup:%' ORDER BY outcome_id", s.HabiticaID)
	if err != nil {
		return v, err
	}
	for rows.Next() {
		var id string
		if err = rows.Scan(&id); err != nil {
			rows.Close()
			return v, err
		}
		v.PickedUp = append(v.PickedUp, id)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return v, err
	}
	rows, err = tx.QueryContext(ctx, "SELECT p.display_name,t.item_def,t.at FROM item_thanks t JOIN players p ON p.habitica_id=t.user_id WHERE t.maker_id=? ORDER BY t.at DESC,t.id DESC LIMIT 10", s.HabiticaID)
	if err != nil {
		return v, err
	}
	defer rows.Close()
	for rows.Next() {
		var t thanksView
		if err = rows.Scan(&t.FromName, &t.ItemDef, &t.At); err != nil {
			return v, err
		}
		t.FromName = capDonor(t.FromName)
		v.Thanks = append(v.Thanks, t)
	}
	return v, rows.Err()
}

// ------------------------------------------------------------ endpoints

func (a *Server) itemsRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if s.SaveOrigin == nil {
		return fail(409, "origin-required")
	}
	now := a.Config.Now().Unix()
	if err = healWardens(r.Context(), tx, s.HabiticaID, now); err != nil {
		return err
	}
	v, err := readItems(r.Context(), tx, &s)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Items itemsView `json:"items"`
	}{s, v})
}

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
}

// itemResult: the caller's items after the change, and what happened.
type itemResult struct {
	Items    itemsView      `json:"items"`
	Wear     *wearResult    `json:"wear,omitempty"`
	Used     string         `json:"used,omitempty"`
	Pickup   string         `json:"pickup,omitempty"`
	Given    *content.Asset `json:"given,omitempty"`
	Mended   string         `json:"mended,omitempty"`
	Created  []string       `json:"created,omitempty"`
	Returned string         `json:"returned,omitempty"`
	Paper    *string        `json:"paper,omitempty"`
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
		case "return":
			err = a.returnKeepsake(ctx, tx, s, req, now, &out)
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
		out.Items, err = readItems(ctx, tx, s)
		return out, err
	}, func() {
		for _, n := range notify {
			n()
		}
	})
	return err
}

// useItem: one use of a tool (instance), or eating/drinking one consumable.
func (a *Server) useItem(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest, now int64, out *itemResult) error {
	if req.Instance != "" {
		res, err := useTool(ctx, tx, s, req.Instance, req.Action, now)
		out.Wear = &res
		return err
	}
	def, ok := content.ItemFor(req.ItemDef)
	if !ok || def.Kind != "consumable" {
		return fail(400, "invalid-item")
	}
	if !def.UsableNow() {
		return fail(409, "not-usable-yet")
	}
	helps := false
	for _, e := range def.Use {
		switch e.Type {
		case "restore-hp":
			if s.State.HP < s.State.MaxHP {
				helps = true
				s.State.HP = math.Min(s.State.MaxHP, s.State.HP+float64(e.Amount))
			}
		case "restore-mana":
			if s.State.Mana < s.State.MaxMana {
				helps = true
				s.State.Mana = math.Min(s.State.MaxMana, s.State.Mana+float64(e.Amount))
			}
		}
	}
	if !helps {
		return fail(409, "not-needed")
	}
	split, err := packTake(ctx, tx, s.HabiticaID, def.ID, req.Maker, 1, "use", def.ID, now)
	if err != nil {
		return err
	}
	out.Used = def.ID
	// A quiet thank-you to the maker, unless they're right here.
	for _, m := range split {
		if m.Maker == "" || m.Maker == s.HabiticaID {
			continue
		}
		radius := float64(content.ItemsRules.Rules.Thanks.NearbyTiles * wildsTileSize)
		if a.presence != nil && a.presence.together(s.WorldID, s.HabiticaID, m.Maker, radius) {
			continue
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO item_thanks(maker_id,user_id,item_def,at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM players WHERE habitica_id=? AND world_id=?)", m.Maker, s.HabiticaID, def.ID, now, m.Maker, s.WorldID); err != nil {
			return err
		}
	}
	return nil
}

// repairTool mends an heirloom at the caller's bench (Workshop) or by a
// mender (standing near Silas or Orrin). Cheap tools can't be mended.
func repairTool(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest, now int64, out *itemResult) error {
	v, err := loadInstance(ctx, tx, req.Instance)
	if err != nil {
		return err
	}
	if v.Location != "pack" || v.Owner != s.HabiticaID {
		return fail(404, "item-not-found")
	}
	def, _ := content.ItemFor(v.Def)
	if def.Repair == nil {
		return fail(409, "cannot-mend")
	}
	if v.Condition >= v.Max {
		return fail(409, "not-needed")
	}
	cost, embers := def.Repair.Bench, 0
	if req.At == "bench" {
		if _, err = workshop(ctx, tx, s); err != nil {
			return err
		}
	} else {
		m, ok := content.MenderFor(req.At)
		if !ok {
			return fail(400, "invalid-mender")
		}
		if !nearTile(s, m.Area, m.TX, m.TY, m.RadiusTiles) {
			return fail(409, "too-far-away")
		}
		cost, embers = def.Repair.Mender, def.Repair.MenderEmbers
	}
	if err = checkMaterials(ctx, tx, s.HabiticaID, cost); err != nil {
		return err
	}
	if embers > 0 {
		if err = debitEmbers(ctx, tx, s, embers, "mend", v.Def, now); err != nil {
			return err
		}
	}
	if err = debitMaterials(ctx, tx, s, cost, 1, "mend", v.ID, now); err != nil {
		return err
	}
	if _, err = tx.ExecContext(ctx, "UPDATE item_instances SET condition=max_condition WHERE id=?", v.ID); err != nil {
		return err
	}
	out.Mended = v.ID
	return currency(ctx, tx, s.HabiticaID, "mend:"+v.Def, 0, "mend", req.At, now)
}

// fitTool puts a fitting on a tool at the bench: from the pack, or moved
// straight from another tool (keeping its wear). One of each kind per tool,
// up to the tool's slots.
func fitTool(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest, now int64) error {
	if _, err := workshop(ctx, tx, s); err != nil {
		return err
	}
	tool, err := loadInstance(ctx, tx, req.Tool)
	if err != nil {
		return err
	}
	if tool.Location != "pack" || tool.Owner != s.HabiticaID {
		return fail(404, "item-not-found")
	}
	f, err := loadInstance(ctx, tx, req.Instance)
	if err != nil {
		return err
	}
	tdef, _ := content.ItemFor(tool.Def)
	fdef, _ := content.ItemFor(f.Def)
	if fdef.Kind != "fitting" || tdef.Kind != "tool" {
		return fail(400, "invalid-item")
	}
	from := instanceAt{f.Location, f.Owner}
	switch {
	case f.Location == "pack" && f.Owner == s.HabiticaID:
	case f.Location == "fitted":
		other, err := loadInstance(ctx, tx, f.Owner)
		if err != nil || other.Location != "pack" || other.Owner != s.HabiticaID {
			return fail(404, "item-not-found")
		}
		if other.ID == tool.ID {
			return fail(409, "already-fitted")
		}
	default:
		return fail(404, "item-not-found")
	}
	fitted, err := fittingRows(ctx, tx, tool.ID)
	if err != nil {
		return err
	}
	if len(fitted) >= tdef.SlotCount() {
		return fail(409, "no-free-slot")
	}
	if hasFitting(fitted, fdef.Fitting) {
		return fail(409, "fitting-kind-taken")
	}
	if err = moveInstance(ctx, tx, f.ID, f.Def, from, instanceAt{"fitted", tool.ID}); err != nil {
		return err
	}
	if from.location == "pack" {
		if err = currency(ctx, tx, s.HabiticaID, content.StackCurrency(f.Def), -1, "fit", tool.ID, now); err != nil {
			return err
		}
		return currency(ctx, tx, s.HabiticaID, "fitted:"+f.Def, 1, "fit", tool.ID, now)
	}
	return nil
}

// unfitTool takes a fitting off a tool (at the bench) into the pack.
func unfitTool(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest, now int64) error {
	if _, err := workshop(ctx, tx, s); err != nil {
		return err
	}
	f, err := loadInstance(ctx, tx, req.Instance)
	if err != nil {
		return err
	}
	if f.Location != "fitted" {
		return fail(409, "not-fitted")
	}
	tool, err := loadInstance(ctx, tx, f.Owner)
	if err != nil || tool.Location != "pack" || tool.Owner != s.HabiticaID {
		return fail(404, "item-not-found")
	}
	if err = moveInstance(ctx, tx, f.ID, f.Def, instanceAt{"fitted", tool.ID}, instanceAt{"pack", s.HabiticaID}); err != nil {
		return err
	}
	if err = currency(ctx, tx, s.HabiticaID, "fitted:"+f.Def, -1, "unfit", tool.ID, now); err != nil {
		return err
	}
	return currency(ctx, tx, s.HabiticaID, content.StackCurrency(f.Def), 1, "unfit", tool.ID, now)
}

// giveItem hands something to a player standing next to the caller. Gifts
// only; heirlooms and story keepsakes stay with the one they were given to.
func (a *Server) giveItem(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest, now int64, out *itemResult) (string, error) {
	if req.Asset == nil {
		return "", fail(400, "invalid-asset")
	}
	v := *req.Asset
	if req.ToID == s.HabiticaID || req.ToID == "" {
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
	err := tx.QueryRowContext(ctx, "SELECT world_id FROM players WHERE habitica_id=?", req.ToID).Scan(&world)
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
	if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM allowlist WHERE habitica_id=?) AND NOT EXISTS(SELECT 1 FROM access_removals WHERE habitica_id=?)", req.ToID, req.ToID).Scan(&eligible); err != nil {
		return "", err
	}
	if !eligible {
		return "", fail(403, "recipient-unavailable")
	}
	radius := float64(content.ItemsRules.Rules.Give.RadiusTiles * wildsTileSize)
	if a.presence == nil || !a.presence.together(s.WorldID, s.HabiticaID, req.ToID, radius) {
		return "", fail(409, "not-together")
	}
	to := pack(req.ToID)
	got, err := takeAsset(ctx, tx, s, v, to, "give", req.ToID, now)
	if err != nil {
		return "", err
	}
	switch v.Kind {
	case "material", "item":
		err = packPut(ctx, tx, req.ToID, v.ID, got.Makers, "gift", s.HabiticaID, now)
	case "instance":
		err = currency(ctx, tx, req.ToID, content.StackCurrency(v.ID), 1, "gift", s.HabiticaID, now)
	default:
		err = currency(ctx, tx, req.ToID, "decoration:"+v.ID, v.Qty, "gift", s.HabiticaID, now)
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

// pocketItem puts a carried keepsake in pocket 1 or 2 (empty itemDef: empty it).
func pocketItem(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest) error {
	n, err := pocketCount(ctx, tx, s.HabiticaID)
	if err != nil {
		return err
	}
	if req.Slot < 1 || req.Slot > content.ItemsRules.Rules.Pockets.WithCarryGear {
		return fail(400, "invalid-slot")
	}
	if req.Slot > n {
		return fail(409, "no-such-pocket")
	}
	slot := "pocket-" + string(rune('0'+req.Slot))
	if _, err = tx.ExecContext(ctx, "DELETE FROM item_slots WHERE habitica_id=? AND slot=?", s.HabiticaID, slot); err != nil {
		return err
	}
	if req.ItemDef == "" {
		return nil
	}
	def, ok := content.ItemFor(req.ItemDef)
	if !ok || def.Kind != "keepsake" {
		return fail(400, "not-a-keepsake")
	}
	if have, err := stackTotal(ctx, tx, packOf(s.HabiticaID), def.ID); err != nil {
		return err
	} else if have == 0 {
		return fail(409, "insufficient-items")
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM item_slots WHERE habitica_id=? AND slot LIKE 'pocket-%' AND item_def=?", s.HabiticaID, def.ID); err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO item_slots(habitica_id,slot,item_def) VALUES(?,?,?)", s.HabiticaID, slot, def.ID)
	return err
}

// offHandItem carries one thing in the off hand (it opens with a class):
// an off-hand instance by id, or an off-hand keepsake by definition.
func offHandItem(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest) error {
	if open, _ := offHandOpen(s); !open {
		return fail(409, "off-hand-closed")
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM item_slots WHERE habitica_id=? AND slot='off-hand'", s.HabiticaID); err != nil {
		return err
	}
	if req.Instance == "" && req.ItemDef == "" {
		return nil
	}
	row := slotRow{slot: "off-hand", def: req.ItemDef}
	if req.Instance != "" {
		v, err := loadInstance(ctx, tx, req.Instance)
		if err != nil {
			return err
		}
		row.def = v.Def
		row.instance = sql.NullString{String: v.ID, Valid: true}
	}
	ok, err := slotHolds(ctx, tx, s.HabiticaID, row)
	if err != nil {
		return err
	}
	if !ok {
		return fail(409, "not-for-the-off-hand")
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO item_slots(habitica_id,slot,item_def,instance_id) VALUES(?,?,?,?)", s.HabiticaID, "off-hand", row.def, row.instance)
	return err
}

// pickUp takes a thing lying in the world, once per player, standing by it.
func pickUp(ctx context.Context, tx *sql.Tx, s *store.Snapshot, req itemRequest, now int64, out *itemResult) error {
	p, ok := content.PickupFor(req.Pickup)
	if !ok {
		return fail(404, "pickup-not-found")
	}
	if !nearTile(s, p.Area, p.TX, p.TY, 3) {
		return fail(409, "too-far-away")
	}
	added, err := store.Outcome(ctx, tx, s.HabiticaID, "pickup:"+p.ID, "pickup", now)
	if err != nil {
		return err
	}
	if !added {
		return fail(409, "already-picked-up")
	}
	def, _ := content.ItemFor(p.Item)
	out.Pickup = p.ID
	if def.Instanced() {
		condition := -1
		if p.UsesLeft > 0 {
			condition = p.UsesLeft * content.ItemsRules.Rules.Wear.PointsPerUse
		}
		id, err := newInstance(ctx, tx, def, instanceAt{"pack", s.HabiticaID}, "", condition, now)
		if err != nil {
			return err
		}
		out.Created = []string{id}
		return currency(ctx, tx, s.HabiticaID, content.StackCurrency(def.ID), 1, "pickup", p.ID, now)
	}
	return packPut(ctx, tx, s.HabiticaID, def.ID, []makerQty{{"", p.Qty}}, "pickup", p.ID, now)
}

// ------------------------------------------------------------ presence

// together: both players are connected in this world, in the same room, and
// stood within radius px of each other when they last moved.
func (h *presenceHub) together(world, a, b string, radius float64) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	p, q := h.peers[a], h.peers[b]
	if p == nil || q == nil || p.detached || q.detached || p.identity.World != world || q.identity.World != world || p.area == "" || p.area != q.area || p.pos == nil || q.pos == nil {
		return false
	}
	dx, dy := p.pos.X-q.pos.X, p.pos.Y-q.pos.Y
	return dx*dx+dy*dy <= radius*radius
}

// presenceGift tells the recipient, if connected, what was handed to them.
func (a *Server) presenceGift(world, to, fromName string, v content.Asset) {
	h := a.presence
	if h == nil {
		return
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	p := h.peers[to]
	if p == nil || p.identity.World != world || p.queue == nil {
		return
	}
	h.send(p, struct {
		Type     string `json:"type"`
		FromName string `json:"fromName"`
		Kind     string `json:"kind"`
		ItemDef  string `json:"itemDef"`
		Qty      int    `json:"qty"`
	}{"gift", capDonor(fromName), v.Kind, v.ID, v.Qty})
}

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

	// Proximity check
	switch target {
	case "ada":
		if !nearTile(s, "village", 35, 8, 4) {
			return fail(409, "too-far-away")
		}
	case "hazel":
		if !nearTile(s, "village", 12, 15, 4) {
			return fail(409, "too-far-away")
		}
	case "silas":
		if !nearTile(s, "commons", 51, 21, 4) {
			return fail(409, "too-far-away")
		}
	case "bett", "nan":
		if s.State.Area != "wilds" {
			return fail(409, "too-far-away")
		}
	default:
		return fail(400, "unknown-target")
	}

	ref := target + ":" + itemID
	if _, err := packTake(ctx, tx, s.HabiticaID, itemID, nil, 1, "return-keepsake", ref, now); err != nil {
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

