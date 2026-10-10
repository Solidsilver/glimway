package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"glimway/content"
	"glimway/server/internal/itemmove"
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
	if kind == "thanks" {
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
	pack := itemmove.Currency(kind, def)
	switch kind {
	case "glims":
		// A glim letter's glims waited in the letter (3.3): they come back to
		// the sender below, both sides in one transaction (3.5).
		if def != "glims" || qty <= 0 {
			return false, fmt.Errorf("invalid mail glims")
		}
	case "material", "item":
		var split []itemmove.MakerQty
		if err = json.Unmarshal([]byte(makers), &split); err != nil {
			return false, err
		}
		total := 0
		for _, m := range split {
			total += m.Qty
			if err = itemmove.RestoreShare(ctx, tx, "pack", sender, def, m); err != nil {
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
				wSQL := itemmove.WardenDefsSQL()
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
					// A second warden-set tool can't be carried. It goes to the
					// sender's personal chest, which travels with them (a shared
					// chest stays with the homestead when they leave or move).
					if senderHasWardenInPack {
						destLocation = "personal"
						destOwner = sender
						rackedAt = 0
						pack = itemmove.LocationCurrency("personal", "instance", def)
						isRedirected = true
					}
				}
				err = itemmove.MoveInstance(ctx, tx, instance, def, "mail", sender, destLocation, destOwner, rackedAt)
			} else {
				err = itemmove.ReturnDecoration(ctx, tx, instance, sender, def)
			}
			if errors.Is(err, itemmove.ErrUnavailable) {
				return false, fmt.Errorf("mail instance unavailable")
			}
			if err != nil {
				return false, err
			}
			if kind == "instance" && !isRedirected {
				// The tool's fittings come back with it: so does their audit.
				if err = itemmove.FittedLedger(ctx, tx, sender, instance, 1, map[bool]string{true: "mail-recall", false: "mail-return"}[reason == "recalled"], id, now); err != nil {
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
	switch {
	case kind == "glims":
		// Recall, expiry, a world move and access removal all come through
		// here, so an uncollected glim letter can never strand glims: the
		// sender is credited and the mail:glims:glims escrow closes (3.3).
		// A recall is the sender's own operation: the api mirrors this
		// column credit into its snapshot (mirrorOwnCredit).
		if err = CreditGold(ctx, tx, sender, qty, ledgerReason, id, now); err != nil {
			return false, err
		}
		if err = itemmove.RecordCurrency(ctx, tx, sender, itemmove.LocationCurrency("mail", "glims", "glims"), -qty, ledgerReason, id, now); err != nil {
			return false, err
		}
	case kind != "thanks":
		for _, delta := range []struct {
			currency string
			amount   int
		}{{pack, qty}, {itemmove.LocationCurrency("mail", kind, def), -qty}} {
			if err = itemmove.RecordCurrency(ctx, tx, sender, delta.currency, delta.amount, ledgerReason, id, now); err != nil {
				return false, err
			}
		}
	}
	if bumpRevision {
		if err = BumpVersion(ctx, tx, &Snapshot{AccountID: sender}); err != nil {
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
	args := []any{now - int64(content.MailRules.GetReturnAfterDays())*86400}
	if participant != "" {
		filter = " AND (m.from_id=? OR m.to_id=?)"
		args = append(args, participant, participant)
	}
	returnDue := `m.kind!='thanks' AND (m.sent_at<=? OR NOT EXISTS(SELECT 1 FROM allowlist a WHERE a.habitica_id=(SELECT subject FROM sign_ins WHERE account_id=m.to_id AND method='habitica')) OR EXISTS(SELECT 1 FROM access_removals r WHERE r.habitica_id=(SELECT subject FROM sign_ins WHERE account_id=m.to_id AND method='habitica')))`
	return returnMailBatch(ctx, tx, now, returnDue+filter, args)
}
func returnMailBatch(ctx context.Context, tx *sql.Tx, now int64, filter string, args []any) (int, error) {
	args = append(args, int(content.MailRules.GetMaintenanceBatch()))
	rows, err := tx.QueryContext(ctx, `SELECT m.id,CASE WHEN NOT EXISTS(SELECT 1 FROM allowlist a WHERE a.habitica_id=(SELECT subject FROM sign_ins WHERE account_id=m.to_id AND method='habitica')) OR EXISTS(SELECT 1 FROM access_removals r WHERE r.habitica_id=(SELECT subject FROM sign_ins WHERE account_id=m.to_id AND method='habitica')) THEN 'recipient-removed' ELSE 'expired' END FROM mail m WHERE m.claimed_at IS NULL AND m.returned_at IS NULL AND `+filter+` ORDER BY m.sent_at,m.id LIMIT ?`, args...)
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
