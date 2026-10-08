package api

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/store"
	"math"
	"net/http"
)

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
		out.UsesLeft = usesLeft(v.Condition, wearCost(fittings))
		if warden {
			out.UsesLeft = wardenUsesLeft(v.Max, v.Condition, fittings)
			dull := math.Max(0, math.Min(1, 1.0-float64(v.Condition)/float64(v.Max)))
			minSpeed := 0.5
			if hasFitting(fittings, "bite") {
				minSpeed = 0.75
			}
			speed := math.Round((1.0-dull*(1.0-minSpeed))*100) / 100
			out.Dullness = &dull
			out.Speed = &speed
		}
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

func readItems(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (itemsView, error) {
	v := itemsView{Stacks: []stackView{}, Pockets: []slotView{}, PickedUp: []string{}, Thanks: []thanksView{}}
	makers := map[string]*makerView{}
	// Fresh bloom flowers dry once the wick has turned (the pack only).
	if err := dryFlowers(ctx, tx, s, now); err != nil {
		return v, err
	}
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
	v, err := readItems(r.Context(), tx, &s, now)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Items itemsView `json:"items"`
	}{s, v})
}
