package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"fingersnap/content"
	"fmt"
	"strings"
)

// ReturnMail settles transit exactly once inside the caller's immediate tx.
// Explicit recalls use the keyed mutation's Persist; unattended returns bump
// the sender's revision here without rewriting their progress or last-seen time.
func ReturnMail(ctx context.Context, tx *sql.Tx, id, reason string, now int64, bumpRevision bool) (bool, error) {
	var sender, kind, def, raw, makers string
	var qty int
	var claimed, returned sql.NullInt64
	err := tx.QueryRowContext(ctx, "SELECT from_id,kind,item_def,qty,instance_ids,makers,claimed_at,returned_at FROM mail WHERE id=?", id).Scan(&sender, &kind, &def, &qty, &raw, &makers, &claimed, &returned)
	if err != nil {
		return false, err
	}
	if claimed.Valid || returned.Valid {
		return false, nil
	}
	result, err := tx.ExecContext(ctx, "UPDATE mail SET returned_at=?,return_reason=? WHERE id=? AND claimed_at IS NULL AND returned_at IS NULL", now, reason, id)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	if err != nil || n != 1 {
		return false, err
	}
	pack := kind + ":" + def
	switch kind {
	case "material", "item":
		var split []struct {
			Maker string `json:"maker"`
			Qty   int    `json:"qty"`
		}
		if err = json.Unmarshal([]byte(makers), &split); err != nil {
			return false, err
		}
		total := 0
		for _, m := range split {
			total += m.Qty
			if _, err = tx.ExecContext(ctx, "INSERT INTO item_stacks(location,owner,item_def,maker_id,qty) VALUES('pack',?,?,?,?) ON CONFLICT(location,owner,item_def,maker_id) DO UPDATE SET qty=qty+excluded.qty", sender, def, m.Maker, m.Qty); err != nil {
				return false, err
			}
		}
		if total != qty {
			return false, fmt.Errorf("invalid mail makers")
		}
	case "decoration", "instance":
		var ids []string
		if err = json.Unmarshal([]byte(raw), &ids); err != nil {
			return false, err
		}
		if len(ids) != qty {
			return false, fmt.Errorf("invalid mail instances")
		}
		q := "UPDATE homestead_items SET location='inventory' WHERE id=? AND habitica_id=? AND item_def=? AND location='mail' AND scene IS NULL"
		if kind == "instance" {
			pack = content.StackCurrency(def)
		}
		for _, instance := range ids {
			destLocation := "pack"
			destOwner := sender
			rackedAt := int64(0)
			isRedirected := false
			if kind == "instance" {
				var isWarden bool
				wSQL := wardenDefsSQL()
				err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM item_instances WHERE location='fitted' AND owner=? AND item_def IN ("+wSQL+"))", instance).Scan(&isWarden)
				if err != nil {
					return false, err
				}
				if isWarden {
					var senderHasWardenInPack bool
					err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM item_instances t WHERE t.location='pack' AND t.owner=? AND EXISTS(SELECT 1 FROM item_instances f WHERE f.location='fitted' AND f.owner=t.id AND f.item_def IN ("+wSQL+")))", sender).Scan(&senderHasWardenInPack)
					if err != nil {
						return false, err
					}
					if senderHasWardenInPack {
						var homeID string
						err = tx.QueryRowContext(ctx, "SELECT homestead_id FROM homestead_members WHERE habitica_id=?", sender).Scan(&homeID)
						if err != nil && err != sql.ErrNoRows {
							return false, err
						}
						if err == nil && homeID != "" {
							destLocation = "storage"
							destOwner = homeID
							rackedAt = now
							pack = "storage:instance:" + def
							isRedirected = true
						} else {
							destLocation = "personal"
							destOwner = sender
							rackedAt = 0
							pack = "personal:instance:" + def
							isRedirected = true
						}
					}
				}
				result, err = tx.ExecContext(ctx, "UPDATE item_instances SET location=?,owner=?,racked_at=? WHERE id=? AND owner=? AND item_def=? AND location='mail'", destLocation, destOwner, rackedAt, instance, sender, def)
			} else {
				result, err = tx.ExecContext(ctx, q, instance, sender, def)
			}
			if err != nil {
				return false, err
			}
			n, err = result.RowsAffected()
			if err != nil {
				return false, err
			}
			if n != 1 {
				return false, fmt.Errorf("mail instance unavailable")
			}
			if kind == "instance" && !isRedirected {
				// The tool's fittings come back with it: so does their audit.
				if _, err = tx.ExecContext(ctx, "INSERT INTO ledger(habitica_id,currency,delta,earned_delta,reason,ref,created_at) SELECT ?,'fitted:'||item_def,1,0,?,?,? FROM item_instances WHERE location='fitted' AND owner=? ORDER BY item_def,id", sender, map[bool]string{true: "mail-recall", false: "mail-return"}[reason == "recalled"], id, now, instance); err != nil {
					return false, err
				}
			}
		}
	case "thanks":
		// Thanks mail has no items or instances attached.
	default:
		return false, fmt.Errorf("invalid mail asset")
	}
	ledgerReason := "mail-return"
	if reason == "recalled" {
		ledgerReason = "mail-recall"
	}
	if kind != "thanks" {
		for _, delta := range []struct {
			currency string
			amount   int
		}{{pack, qty}, {"mail:" + kind + ":" + def, -qty}} {
			if _, err = tx.ExecContext(ctx, "INSERT INTO ledger(habitica_id,currency,delta,earned_delta,reason,ref,created_at) VALUES(?,?,?,0,?,?,?)", sender, delta.currency, delta.amount, ledgerReason, id, now); err != nil {
				return false, err
			}
		}
	}
	if bumpRevision {
		if _, err = tx.ExecContext(ctx, "UPDATE players SET rev=rev+1 WHERE habitica_id=?", sender); err != nil {
			return false, err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE progress SET rev=(SELECT rev FROM players WHERE habitica_id=?),updated_at=? WHERE habitica_id=?", sender, now, sender); err != nil {
			return false, err
		}
	}
	return true, nil
}

// ReturnDueMailTx handles a bounded batch. Empty participant sweeps all worlds;
// otherwise only mail involving that player is touched. Missing allowlist rows
// and removal tombstones both revoke a recipient's ability to claim.
func ReturnDueMailTx(ctx context.Context, tx *sql.Tx, now int64, participant string) (int, error) {
	filter := ""
	args := []any{now - int64(content.MailRules.ReturnAfterDays)*86400}
	if participant != "" {
		filter = " AND (m.from_id=? OR m.to_id=?)"
		args = append(args, participant, participant)
	}
	returnDue := `(m.sent_at<=? OR NOT EXISTS(SELECT 1 FROM allowlist a WHERE a.habitica_id=m.to_id) OR EXISTS(SELECT 1 FROM access_removals r WHERE r.habitica_id=m.to_id))`
	return returnMailBatch(ctx, tx, now, returnDue+filter, args)
}
func returnMailBatch(ctx context.Context, tx *sql.Tx, now int64, filter string, args []any) (int, error) {
	args = append(args, content.MailRules.MaintenanceBatch)
	rows, err := tx.QueryContext(ctx, `SELECT m.id,CASE WHEN NOT EXISTS(SELECT 1 FROM allowlist a WHERE a.habitica_id=m.to_id) OR EXISTS(SELECT 1 FROM access_removals r WHERE r.habitica_id=m.to_id) THEN 'recipient-removed' ELSE 'expired' END FROM mail m WHERE m.claimed_at IS NULL AND m.returned_at IS NULL AND `+filter+` ORDER BY m.sent_at,m.id LIMIT ?`, args...)
	if err != nil {
		return 0, err
	}
	type pending struct{ id, reason string }
	batch := []pending{}
	for rows.Next() {
		var v pending
		if err = rows.Scan(&v.id, &v.reason); err != nil {
			rows.Close()
			return 0, err
		}
		batch = append(batch, v)
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return 0, err
	}
	for _, v := range batch {
		if _, err = ReturnMail(ctx, tx, v.id, v.reason, now, true); err != nil {
			return 0, err
		}
	}
	return len(batch), nil
}
func (s *Store) ReturnDueMail(ctx context.Context, now int64) (int, error) {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	n, err := ReturnDueMailTx(ctx, tx, now, "")
	if err != nil {
		return 0, err
	}
	return n, tx.Commit()
}

func wardenDefsSQL() string {
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
