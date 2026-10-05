package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/store"
	"net/http"
	"strings"
)

type mailView struct {
	ID        string        `json:"id"`
	WorldID   string        `json:"worldId"`
	FromID    string        `json:"fromId"`
	ToID      string        `json:"toId"`
	FromName  string        `json:"fromName"`
	ToName    string        `json:"toName"`
	Asset     content.Asset `json:"asset"`
	SentAt    int64         `json:"sentAt"`
	ClaimedAt *int64        `json:"claimedAt"`
}

func mailList(ctx context.Context, tx *sql.Tx, s store.Snapshot) ([]mailView, error) {
	rows, err := tx.QueryContext(ctx, `SELECT m.id,m.world_id,m.from_id,m.to_id,f.display_name,t.display_name,m.kind,m.item_def,m.qty,m.sent_at,m.claimed_at FROM mail m JOIN players f ON f.habitica_id=m.from_id JOIN players t ON t.habitica_id=m.to_id WHERE m.world_id=? AND (m.from_id=? OR m.to_id=?) ORDER BY m.sent_at DESC,m.id`, s.WorldID, s.HabiticaID, s.HabiticaID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []mailView{}
	for rows.Next() {
		var v mailView
		if err = rows.Scan(&v.ID, &v.WorldID, &v.FromID, &v.ToID, &v.FromName, &v.ToName, &v.Asset.Kind, &v.Asset.ID, &v.Asset.Qty, &v.SentAt, &v.ClaimedAt); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}
func (a *Server) mailRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	list, err := mailList(r.Context(), tx, s)
	if err != nil {
		return err
	}
	return a.finish(w, r, tx, struct {
		store.Snapshot
		Mail []mailView `json:"mail"`
	}{s, list})
}
func (a *Server) mailSend(w http.ResponseWriter, r *http.Request) error {
	var req struct {
		Mutation
		Key      string          `json:"key"`
		Progress json.RawMessage `json:"progress,omitempty"`
		ToID     string          `json:"toId"`
		Asset    content.Asset   `json:"asset"`
	}
	if err := decode(w, r, &req); err != nil {
		return err
	}
	return a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if req.ToID == s.HabiticaID {
			return nil, fail(400, "self-mail")
		}
		var world string
		err := tx.QueryRowContext(ctx, "SELECT world_id FROM players WHERE habitica_id=?", req.ToID).Scan(&world)
		if err == sql.ErrNoRows {
			return nil, fail(404, "recipient-not-found")
		}
		if err != nil {
			return nil, err
		}
		if world != s.WorldID {
			return nil, fail(403, "world-access-denied")
		}
		id, err := store.Random()
		if err != nil {
			return nil, err
		}
		ids, err := takeAsset(ctx, tx, s, req.Asset, "mail", "mail-send", id, now)
		if err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,sent_at) VALUES(?,?,?,?,?,?,?,?,?)", id, s.WorldID, s.HabiticaID, req.ToID, req.Asset.Kind, req.Asset.ID, req.Asset.Qty, store.JSON(ids), now); err != nil {
			return nil, err
		}
		if err = currency(ctx, tx, s.HabiticaID, "mail:"+req.Asset.Kind+":"+req.Asset.ID, req.Asset.Qty, "mail-send", id, now); err != nil {
			return nil, err
		}
		list, err := mailList(ctx, tx, *s)
		if err != nil {
			return nil, err
		}
		inventory, err := counts(ctx, tx, s.HabiticaID, false)
		if err != nil {
			return nil, err
		}
		return struct {
			MailID    string      `json:"mailId"`
			Mail      []mailView  `json:"mail"`
			Inventory assetCounts `json:"inventory"`
		}{id, list, inventory}, nil
	})
}
func pathActionID(path, prefix, suffix string) (string, error) {
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return "", fail(404, "not-found")
	}
	id := strings.TrimSuffix(strings.TrimPrefix(path, prefix), suffix)
	if id == "" || len(id) > 128 || strings.Contains(id, "/") {
		return "", fail(404, "not-found")
	}
	return id, nil
}
func (a *Server) mailClaim(w http.ResponseWriter, r *http.Request) error {
	id, err := pathActionID(r.URL.Path, "/api/mail/", "/claim")
	if err != nil {
		return err
	}
	var req struct {
		Mutation
		Key      string          `json:"key"`
		Progress json.RawMessage `json:"progress,omitempty"`
	}
	if err = decode(w, r, &req); err != nil {
		return err
	}
	return a.keyedMutation(w, r, req.Mutation, req.Key, req, req.Progress, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		var v content.Asset
		var from, world, to, raw string
		var claimed sql.NullInt64
		err := tx.QueryRowContext(ctx, "SELECT world_id,from_id,to_id,kind,item_def,qty,instance_ids,claimed_at FROM mail WHERE id=?", id).Scan(&world, &from, &to, &v.Kind, &v.ID, &v.Qty, &raw, &claimed)
		if err == sql.ErrNoRows {
			return nil, fail(404, "mail-not-found")
		}
		if err != nil {
			return nil, err
		}
		if world != s.WorldID || to != s.HabiticaID {
			return nil, fail(403, "mail-access-denied")
		}
		if claimed.Valid {
			return nil, fail(409, "already-claimed")
		}
		// Senders must still belong to the recorded world; world moves are not shipped.
		var senderWorld string
		if err = tx.QueryRowContext(ctx, "SELECT world_id FROM players WHERE habitica_id=?", from).Scan(&senderWorld); err != nil {
			return nil, err
		}
		if senderWorld != world {
			return nil, fail(403, "world-access-denied")
		}
		ids := []string{}
		if err = json.Unmarshal([]byte(raw), &ids); err != nil {
			return nil, err
		}
		if err = giveAsset(ctx, tx, s, v, ids, from, "mail", "mail-claim", id, now); err != nil {
			return nil, err
		}
		if err = currency(ctx, tx, from, "mail:"+v.Kind+":"+v.ID, -v.Qty, "mail-claim", id, now); err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, "UPDATE mail SET claimed_at=? WHERE id=? AND claimed_at IS NULL", now, id); err != nil {
			return nil, err
		}
		list, err := mailList(ctx, tx, *s)
		if err != nil {
			return nil, err
		}
		inventory, err := counts(ctx, tx, s.HabiticaID, false)
		if err != nil {
			return nil, err
		}
		return struct {
			MailID    string        `json:"mailId"`
			Asset     content.Asset `json:"asset"`
			Mail      []mailView    `json:"mail"`
			Inventory assetCounts   `json:"inventory"`
		}{id, v, list, inventory}, nil
	})
}
