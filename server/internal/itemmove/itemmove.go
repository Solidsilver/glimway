// Package itemmove contains transaction-level item movement, without gameplay
// authorization, return policy, revisions or commits. Callers own the transaction.
package itemmove

import (
	"context"
	"database/sql"
	"errors"
	"glimway/content"
	"strings"
)

var ErrUnavailable = errors.New("item unavailable")

// MakerQty is one maker's share of a moved stack (the empty string is unmarked).
type MakerQty struct {
	Maker string `json:"maker"`
	Qty   int    `json:"qty"`
}

func SplitTotal(split []MakerQty) int {
	n := 0
	for _, m := range split {
		n += m.Qty
	}
	return n
}

// RestoreShare preserves the maker identity when goods return to a location.
func RestoreShare(ctx context.Context, tx *sql.Tx, location, owner, def string, m MakerQty) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO item_stacks(location,owner,item_def,maker_id,qty) VALUES(?,?,?,?,?) ON CONFLICT(location,owner,item_def,maker_id) DO UPDATE SET qty=qty+excluded.qty", location, owner, def, m.Maker, m.Qty)
	return err
}

// MoveInstance leaves fittings attached. The caller chooses rack time and policy.
func MoveInstance(ctx context.Context, tx *sql.Tx, id, def, fromLocation, fromOwner, toLocation, toOwner string, rackedAt int64) error {
	res, err := tx.ExecContext(ctx, "UPDATE item_instances SET location=?,owner=?,racked_at=? WHERE id=? AND item_def=? AND location=? AND owner=?", toLocation, toOwner, rackedAt, id, def, fromLocation, fromOwner)
	if err != nil {
		return err
	}
	return movedOne(res)
}

// ReturnDecoration verifies the definition as well as the parcel's owner.
func ReturnDecoration(ctx context.Context, tx *sql.Tx, id, owner, def string) error {
	res, err := tx.ExecContext(ctx, "UPDATE homestead_items SET location='inventory' WHERE id=? AND habitica_id=? AND item_def=? AND location='mail' AND scene IS NULL", id, owner, def)
	if err != nil {
		return err
	}
	return movedOne(res)
}

type DecorationPlace struct{ Location, Player, Home string }

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}
func MoveDecorations(ctx context.Context, tx *sql.Tx, ids []string, from, to DecorationPlace) error {
	for _, id := range ids {
		res, err := tx.ExecContext(ctx, "UPDATE homestead_items SET location=?,habitica_id=?,homestead_id=? WHERE id=? AND location=? AND habitica_id IS ? AND homestead_id IS ? AND scene IS NULL", to.Location, nullable(to.Player), nullable(to.Home), id, from.Location, nullable(from.Player), nullable(from.Home))
		if err != nil {
			return err
		}
		if err = movedOne(res); err != nil {
			return err
		}
	}
	return nil
}
func movedOne(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrUnavailable
	}
	return nil
}

func Currency(kind, def string) string                   { return kind + ":" + def }
func LocationCurrency(location, kind, def string) string { return location + ":" + Currency(kind, def) }
func RecordCurrency(ctx context.Context, tx *sql.Tx, id, currency string, delta int, reason, ref string, now int64) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO ledger(habitica_id,currency,delta,earned_delta,reason,ref,created_at) VALUES(?,?,?,0,?,?,?)", id, currency, delta, reason, ref, now)
	return err
}

func WardenDefsSQL() string {
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

// FittedLedger moves the fitting audit with a tool entering or leaving a pack.
func FittedLedger(ctx context.Context, tx *sql.Tx, player, tool string, delta int, reason, ref string, now int64) error {
	_, err := tx.ExecContext(ctx, "INSERT INTO ledger(habitica_id,currency,delta,earned_delta,reason,ref,created_at) SELECT ?,'fitted:'||item_def,?,0,?,?,? FROM item_instances WHERE location='fitted' AND owner=? ORDER BY item_def,id", player, delta, reason, ref, now, tool)
	return err
}
