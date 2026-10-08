package api

import (
	"context"
	"database/sql"
	"glimway/content"
	"glimway/server/internal/itemmove"
	"glimway/server/internal/store"
)

// instanceAt is where an instance lies: a pack, a chest or a parcel (owner:
// the player or the home), or 'fitted' on a tool (owner: the tool's id).
type instanceAt struct{ location, owner string }

func (h holder) instancePlace() instanceAt {
	switch h.location {
	case "inventory":
		return instanceAt{"pack", h.player}
	case "storage":
		return instanceAt{"storage", h.home}
	case "shelf":
		return instanceAt{"shelf", h.home}
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
	Dullness     *float64      `json:"dullness,omitempty"`
	Speed        *float64      `json:"speed,omitempty"`
	Fittings     []fittingView `json:"fittings"`
	Maker        *makerView    `json:"maker"`
}

type instanceRow struct {
	ID, Def, Location, Owner string
	Condition, Max           int
	Maker                    string
	WornDay                  int64
	WornAt                   int64
	RackedAt                 int64
}

func scanInstance(row interface{ Scan(...any) error }) (instanceRow, error) {
	var v instanceRow
	err := row.Scan(&v.ID, &v.Def, &v.Location, &v.Owner, &v.Condition, &v.Max, &v.Maker, &v.WornDay, &v.WornAt, &v.RackedAt)
	return v, err
}

const instanceColumns = "id,item_def,location,owner,condition,max_condition,maker_id,worn_day,worn_at,racked_at"

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
	rackedAt := int64(0)
	if at.location == "storage" {
		rackedAt = now
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO item_instances(id,item_def,location,owner,condition,max_condition,maker_id,worn_day,worn_at,racked_at,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)", id, def.ID, at.location, at.owner, condition, full, maker, 0, now, rackedAt, now)
	return id, err
}

// moveInstance moves one instance (its fittings travel with it); anything
// that leaves a pack leaves that player's pockets and off hand too.
func moveInstance(ctx context.Context, tx *sql.Tx, id, def string, from, to instanceAt, now int64) error {
	rackedAt := int64(0)
	if to.location == "storage" {
		rackedAt = now
	}
	err := itemmove.MoveInstance(ctx, tx, id, def, from.location, from.owner, to.location, to.owner, rackedAt)
	if err == itemmove.ErrUnavailable {
		return fail(409, "item-not-available")
	}
	if err != nil {
		return err
	}
	if from.location == "pack" {
		_, err = tx.ExecContext(ctx, "DELETE FROM item_slots WHERE instance_id=?", id)
	}
	return err
}

// fittedLedger moves the audit of a tool's fittings with the tool: whoever
// holds a tool in their pack carries `fitted:<def>` for each fitting on it.
// delta is -1 as it leaves a holder's pack, +1 as it arrives in one.
func fittedLedger(ctx context.Context, tx *sql.Tx, player, tool string, delta int, reason, ref string, now int64) error {
	return itemmove.FittedLedger(ctx, tx, player, tool, delta, reason, ref, now)
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
