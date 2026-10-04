package store

import (
	"context"
	"database/sql"
	"encoding/hex"
	"fmt"
	"time"
)

// ClearFlag changes no balances, marks, pending lots or healing baselines.
func (s *Store) ClearFlag(ctx context.Context, id string) error {
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var flagged sql.NullInt64
	if err = tx.QueryRowContext(ctx, "SELECT flagged_at FROM players WHERE habitica_id=?", id).Scan(&flagged); err == sql.ErrNoRows {
		return fmt.Errorf("player not found")
	} else if err != nil {
		return err
	}
	if flagged.Valid {
		if _, err = tx.ExecContext(ctx, "UPDATE players SET flagged_at=NULL,rev=rev+1 WHERE habitica_id=?", id); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE progress SET rev=(SELECT rev FROM players WHERE habitica_id=?) WHERE habitica_id=?", id, id); err != nil {
			return err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO ledger(habitica_id,currency,delta,earned_delta,reason,ref,created_at) VALUES(?,'embers',0,0,'flag-cleared','cli',?)", id, time.Now().Unix()); err != nil {
			return err
		}
	}
	return tx.Commit()
}
func (s *Store) RevokeInvite(ctx context.Context, hash string) error {
	decoded, err := hex.DecodeString(hash)
	if err != nil || len(decoded) != 32 {
		return fmt.Errorf("invalid invite hash")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var used sql.NullString
	if err = tx.QueryRowContext(ctx, "SELECT used_by FROM invites WHERE code_hash=?", hash).Scan(&used); err == sql.ErrNoRows {
		return fmt.Errorf("invite not found")
	} else if err != nil {
		return err
	}
	if used.Valid {
		return fmt.Errorf("invite already used")
	}
	if _, err = tx.ExecContext(ctx, "UPDATE invites SET revoked_at=COALESCE(revoked_at,?) WHERE code_hash=?", time.Now().Unix(), hash); err != nil {
		return err
	}
	return tx.Commit()
}

type InviteRecord struct {
	ID        string  `json:"id"`
	CreatedBy string  `json:"createdBy"`
	WorldID   *string `json:"worldId"`
	CreatedAt int64   `json:"createdAt"`
	ExpiresAt int64   `json:"expiresAt"`
	UsedBy    *string `json:"usedBy"`
	UsedAt    *int64  `json:"usedAt"`
	RevokedAt *int64  `json:"revokedAt"`
}

func (s *Store) Invites(ctx context.Context, player string) ([]InviteRecord, error) {
	rows, err := s.DB.QueryContext(ctx, "SELECT code_hash,created_by,world_id,created_at,expires_at,used_by,used_at,revoked_at FROM invites WHERE ?='' OR created_by=? ORDER BY created_at,code_hash", player, player)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []InviteRecord{}
	for rows.Next() {
		var v InviteRecord
		if err = rows.Scan(&v.ID, &v.CreatedBy, &v.WorldID, &v.CreatedAt, &v.ExpiresAt, &v.UsedBy, &v.UsedAt, &v.RevokedAt); err != nil {
			return nil, err
		}
		result = append(result, v)
	}
	return result, rows.Err()
}
