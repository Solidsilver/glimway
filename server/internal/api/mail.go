package api

import (
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/itemmove"
	"glimway/server/internal/store"
	"net/http"
	"slices"
	"strconv"
	"strings"
	"time"
)

type mailView struct {
	ID           string         `json:"id"`
	WorldID      string         `json:"worldId"`
	FromID       string         `json:"fromId"`
	ToID         string         `json:"toId"`
	FromName     string         `json:"fromName"`
	ToName       string         `json:"toName"`
	Asset        *content.Asset `json:"asset"`
	SentAt       int64          `json:"sentAt"`
	ClaimedAt    *int64         `json:"claimedAt"`
	ReturnedAt   *int64         `json:"returnedAt"`
	ReturnReason *string        `json:"returnReason"`
}

type mailPage struct {
	Mail              []mailView `json:"mail"`
	NextCursor        *string    `json:"nextCursor"`
	NextPendingCursor *string    `json:"nextPendingCursor"`
}
type mailCursor struct {
	At int64  `json:"at"`
	ID string `json:"id"`
}

func decodeMailCursor(raw string) (*mailCursor, error) {
	if raw == "" {
		return nil, nil
	}
	if len(raw) > 512 {
		return nil, fail(400, "invalid-mail-cursor")
	}
	b, err := base64.RawURLEncoding.DecodeString(raw)
	var v mailCursor
	if err != nil || json.Unmarshal(b, &v) != nil || v.ID == "" || len(v.ID) > 128 {
		return nil, fail(400, "invalid-mail-cursor")
	}
	return &v, nil
}
func mailSlice(ctx context.Context, tx *sql.Tx, s store.Snapshot, pending bool, cursor *mailCursor, limit int) ([]mailView, *string, error) {
	condition := "(claimed_at IS NOT NULL OR returned_at IS NOT NULL)"
	if pending {
		condition = "claimed_at IS NULL AND returned_at IS NULL"
	}
	cursorWhere := ""
	params := []any{s.WorldID, s.AccountID}
	if cursor != nil {
		cursorWhere = " AND (sent_at,id)<(?,?)"
		params = append(params, cursor.At, cursor.ID)
	}
	params = append(params, limit+1)
	// Separate indexed sender/recipient slices bound sorting work even for a
	// large legacy history. A player cannot mail themselves, so they are disjoint.
	// Thank-you notes reach their recipient in any world (they carry no goods,
	// and a move shouldn't lose them).
	query := `WITH sent AS (SELECT id FROM mail WHERE world_id=? AND from_id=? AND ` + condition + cursorWhere + ` ORDER BY sent_at DESC,id DESC LIMIT ?), received AS (SELECT id FROM mail WHERE (world_id=? OR kind='thanks') AND to_id=? AND ` + condition + cursorWhere + ` ORDER BY sent_at DESC,id DESC LIMIT ?) SELECT m.id,m.world_id,m.from_id,m.to_id,f.display_name,t.display_name,m.kind,m.item_def,m.qty,m.sent_at,m.claimed_at,m.returned_at,m.return_reason FROM mail m JOIN (SELECT id FROM sent UNION ALL SELECT id FROM received) chosen ON chosen.id=m.id JOIN players f ON f.account_id=m.from_id JOIN players t ON t.account_id=m.to_id ORDER BY m.sent_at DESC,m.id DESC LIMIT ?`
	args := append(slices.Clone(params), params...)
	args = append(args, limit+1)
	rows, err := tx.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	out := []mailView{}
	for rows.Next() {
		var v mailView
		v.Asset = &content.Asset{}
		var kind, id string
		var qty int32
		if err = rows.Scan(&v.ID, &v.WorldID, &v.FromID, &v.ToID, &v.FromName, &v.ToName, &kind, &id, &qty, &v.SentAt, &v.ClaimedAt, &v.ReturnedAt, &v.ReturnReason); err != nil {
			return nil, nil, err
		}
		v.Asset.Kind, v.Asset.Id, v.Asset.Qty = kind, id, qty
		v.FromName = capDonor(v.FromName)
		v.ToName = capDonor(v.ToName)
		out = append(out, v)
	}
	if err = rows.Err(); err != nil {
		return nil, nil, err
	}
	var next *string
	if len(out) > limit {
		out = out[:limit]
		last := out[len(out)-1]
		v := base64.RawURLEncoding.EncodeToString([]byte(store.JSON(mailCursor{last.SentAt, last.ID})))
		next = &v
	}
	return out, next, nil
}
func mailList(ctx context.Context, tx *sql.Tx, s store.Snapshot, history, pending *mailCursor) (mailPage, error) {
	out := mailPage{Mail: []mailView{}}
	active, nextPending, err := mailSlice(ctx, tx, s, true, pending, int(content.MailRules.GetMaxOutstandingSent()+content.MailRules.GetMaxOutstandingReceived()))
	if err != nil {
		return out, err
	}
	completed, next, err := mailSlice(ctx, tx, s, false, history, int(content.MailRules.GetHistoryPageSize()))
	if err != nil {
		return out, err
	}
	out.Mail = append(active, completed...)
	out.NextCursor = next
	out.NextPendingCursor = nextPending
	slices.SortFunc(out.Mail, func(a, b mailView) int {
		if a.SentAt > b.SentAt {
			return -1
		}
		if a.SentAt < b.SentAt {
			return 1
		}
		return strings.Compare(b.ID, a.ID)
	})
	return out, nil
}
func (a *Server) mailRead(w http.ResponseWriter, r *http.Request) error {
	cursor, err := decodeMailCursor(r.URL.Query().Get("cursor"))
	if err != nil {
		return err
	}
	pending, err := decodeMailCursor(r.URL.Query().Get("pendingCursor"))
	if err != nil {
		return err
	}
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	list, err := mailList(r.Context(), tx, s, cursor, pending)
	if err != nil {
		return err
	}
	// Carried counts, so a sender without a Workshop knows what they can send.
	inventory, err := packCounts(r.Context(), tx, s.AccountID)
	if err != nil {
		return err
	}
	mail, next, nextPending := mailPageFields(list)
	return a.finishRead(w, r, tx, s, &contract.MailReadResult{Mail: mail, NextCursor: next, NextPendingCursor: nextPending, Inventory: countsProto(inventory)})
}
func (a *Server) mailSend(w http.ResponseWriter, r *http.Request) error {
	var req contract.MailSendRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	asset := assetOf(req.Asset)
	return a.keyedOp(w, r, req.Op, req.Where, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		if req.ToId == s.AccountID {
			return nil, fail(400, "self-mail")
		}
		var world string
		err := tx.QueryRowContext(ctx, "SELECT world_id FROM players WHERE account_id=?", req.ToId).Scan(&world)
		if err == sql.ErrNoRows {
			return nil, fail(404, "recipient-not-found")
		}
		if err != nil {
			return nil, err
		}
		if world != s.WorldID {
			return nil, fail(403, "world-access-denied")
		}
		var eligible bool
		if err = tx.QueryRowContext(ctx, "SELECT EXISTS(SELECT 1 FROM allowlist WHERE habitica_id=(SELECT subject FROM sign_ins WHERE account_id=? AND method='habitica')) AND NOT EXISTS(SELECT 1 FROM access_removals WHERE habitica_id=(SELECT subject FROM sign_ins WHERE account_id=? AND method='habitica'))", req.ToId, req.ToId).Scan(&eligible); err != nil {
			return nil, err
		}
		if !eligible {
			return nil, fail(403, "recipient-unavailable")
		}
		if err = validAsset(asset); err != nil {
			return nil, err
		}
		if d, ok := content.ItemFor(asset.GetId()); ok && asset.GetKind() != "decoration" && !content.ItemGiveable(d) {
			return nil, fail(409, "not-giveable")
		}
		if err = mailSendLimits(ctx, tx, s.AccountID, req.ToId, now, w); err != nil {
			return nil, err
		}
		id, err := store.Random()
		if err != nil {
			return nil, err
		}
		got, err := takeAsset(ctx, tx, s, asset, holder{"mail", s.AccountID, ""}, "mail-send", id, now)
		if err != nil {
			return nil, err
		}
		if _, err = tx.ExecContext(ctx, "INSERT INTO mail(id,world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,sent_at) VALUES(?,?,?,?,?,?,?,?,?,?)", id, s.WorldID, s.AccountID, req.ToId, asset.GetKind(), asset.GetId(), int(asset.GetQty()), store.JSON(got.IDs), store.JSON(got.Makers), now); err != nil {
			return nil, err
		}
		if err = currency(ctx, tx, s.AccountID, itemmove.LocationCurrency("mail", asset.GetKind(), asset.GetId()), int(asset.GetQty()), "mail-send", id, now); err != nil {
			return nil, err
		}
		list, err := mailList(ctx, tx, *s, nil, nil)
		if err != nil {
			return nil, err
		}
		inventory, err := packCounts(ctx, tx, s.AccountID)
		if err != nil {
			return nil, err
		}
		mail, next, nextPending := mailPageFields(list)
		return &contract.MailSendResult{MailId: id, Mail: mail, NextCursor: next, NextPendingCursor: nextPending, Inventory: countsProto(inventory)}, nil
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
	var req contract.MailKeyedRequest
	if err = decodeOp(w, r, &req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		v := &content.Asset{}
		var from, world, to, raw, makers string
		var kind, def string
		var qty int32
		var claimed, returned sql.NullInt64
		var sentAt int64
		err := tx.QueryRowContext(ctx, "SELECT world_id,from_id,to_id,kind,item_def,qty,instance_ids,makers,claimed_at,returned_at,sent_at FROM mail WHERE id=?", id).Scan(&world, &from, &to, &kind, &def, &qty, &raw, &makers, &claimed, &returned, &sentAt)
		v.Kind, v.Id, v.Qty = kind, def, qty
		if err == sql.ErrNoRows {
			return nil, fail(404, "mail-not-found")
		}
		if err != nil {
			return nil, err
		}
		if world != s.WorldID && v.Kind != "thanks" || to != s.AccountID {
			return nil, fail(403, "mail-access-denied")
		}
		if claimed.Valid {
			return nil, fail(409, "already-claimed")
		}
		if returned.Valid {
			return nil, fail(409, "already-returned")
		}
		if sentAt <= now-int64(content.MailRules.GetReturnAfterDays())*86400 {
			return nil, fail(409, "mail-expired")
		}
		// Senders of goods must still belong to the recorded world (a move
		// waits until their parcels are recalled). A thank-you note has no
		// goods, so it can still be read after its sender moved on.
		var senderWorld string
		if err = tx.QueryRowContext(ctx, "SELECT world_id FROM players WHERE account_id=?", from).Scan(&senderWorld); err != nil {
			return nil, err
		}
		if senderWorld != world && v.Kind != "thanks" {
			return nil, fail(403, "world-access-denied")
		}
		got := moved{}
		if err = json.Unmarshal([]byte(raw), &got.IDs); err != nil {
			return nil, err
		}
		if err = json.Unmarshal([]byte(makers), &got.Makers); err != nil {
			return nil, err
		}
		if v.GetKind() == "instance" && len(got.IDs) == 1 {
			v.Instance = got.IDs[0]
		}
		if v.Kind != "thanks" {
			if err = giveAsset(ctx, tx, s, v, got, holder{"mail", from, ""}, "mail-claim", id, now); err != nil {
				return nil, err
			}
			if err = currency(ctx, tx, from, itemmove.LocationCurrency("mail", v.GetKind(), v.GetId()), -int(v.GetQty()), "mail-claim", id, now); err != nil {
				return nil, err
			}
		}
		if _, err = tx.ExecContext(ctx, "UPDATE mail SET claimed_at=? WHERE id=? AND claimed_at IS NULL AND returned_at IS NULL", now, id); err != nil {
			return nil, err
		}
		list, err := mailList(ctx, tx, *s, nil, nil)
		if err != nil {
			return nil, err
		}
		inventory, err := packCounts(ctx, tx, s.AccountID)
		if err != nil {
			return nil, err
		}
		mail, next, nextPending := mailPageFields(list)
		return &contract.MailActionResult{MailId: id, Asset: assetProto(v), Mail: mail, NextCursor: next, NextPendingCursor: nextPending, Inventory: countsProto(inventory)}, nil
	})
}

func mailSendLimits(ctx context.Context, tx *sql.Tx, sender, recipient string, now int64, w http.ResponseWriter) error {
	for _, check := range []struct {
		column, id, code string
		limit            int
	}{{"from_id", sender, "mail-sender-limit", int(content.MailRules.GetMaxOutstandingSent())}, {"to_id", recipient, "mail-recipient-limit", int(content.MailRules.GetMaxOutstandingReceived())}} {
		var n int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM mail WHERE "+check.column+"=? AND kind != 'thanks' AND claimed_at IS NULL AND returned_at IS NULL", check.id).Scan(&n); err != nil {
			return err
		}
		if n >= check.limit {
			return fail(409, check.code)
		}
	}
	var n int
	var first sql.NullInt64
	window := int64(content.MailRules.GetSendWindowSeconds())
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*),MIN(sent_at) FROM mail WHERE from_id=? AND sent_at>?", sender, now-window).Scan(&n, &first); err != nil {
		return err
	}
	if n >= int(content.MailRules.GetMaxSendsPerWindow()) {
		w.Header().Set("Retry-After", strconv.FormatInt(max(1, first.Int64+window-now), 10))
		return fail(429, "mail-rate-limited")
	}
	return nil
}

func (a *Server) mailRecall(w http.ResponseWriter, r *http.Request) error {
	id, err := pathActionID(r.URL.Path, "/api/mail/", "/recall")
	if err != nil {
		return err
	}
	var req contract.MailKeyedRequest
	if err = decodeOp(w, r, &req); err != nil {
		return err
	}
	return a.keyedOp(w, r, req.Op, req.Where, &req, func(ctx context.Context, tx *sql.Tx, s *store.Snapshot, now int64) (any, error) {
		var from, world string
		asset := &content.Asset{}
		var kind, def string
		var qty int32
		var claimed, returned sql.NullInt64
		err := tx.QueryRowContext(ctx, "SELECT world_id,from_id,kind,item_def,qty,claimed_at,returned_at FROM mail WHERE id=?", id).Scan(&world, &from, &kind, &def, &qty, &claimed, &returned)
		asset.Kind, asset.Id, asset.Qty = kind, def, qty
		if err == sql.ErrNoRows {
			return nil, fail(404, "mail-not-found")
		}
		if err != nil {
			return nil, err
		}
		if world != s.WorldID || from != s.AccountID {
			return nil, fail(403, "mail-access-denied")
		}
		if asset.GetKind() == "thanks" {
			return nil, fail(400, "cannot-recall-thanks")
		}
		if claimed.Valid {
			return nil, fail(409, "already-claimed")
		}
		if returned.Valid {
			return nil, fail(409, "already-returned")
		}
		if _, err = store.ReturnMail(ctx, tx, id, "recalled", now, false); err != nil {
			return nil, err
		}
		if err = refreshItems(ctx, tx, s); err != nil {
			return nil, err
		}
		list, err := mailList(ctx, tx, *s, nil, nil)
		if err != nil {
			return nil, err
		}
		inventory, err := packCounts(ctx, tx, s.AccountID)
		if err != nil {
			return nil, err
		}
		mail, next, nextPending := mailPageFields(list)
		return &contract.MailRecallResult{MailId: id, Asset: assetProto(asset), Mail: mail, NextCursor: next, NextPendingCursor: nextPending, Inventory: countsProto(inventory)}, nil
	})
}

// Called by the executable on startup and every shared interval. Each sweep is
// a bounded immediate transaction; request paths also settle their own mail.
func (a *Server) RunMailMaintenance(ctx context.Context) {
	ticker := time.NewTicker(time.Duration(content.MailRules.GetMaintenanceIntervalSeconds()) * time.Second)
	defer ticker.Stop()
	for {
		sweep, cancel := context.WithTimeout(ctx, 10*time.Second)
		var err error
		for {
			var n int
			n, err = a.Store.ReturnDueMail(sweep, a.Config.Now().Unix())
			if err != nil || n < int(content.MailRules.GetMaintenanceBatch()) {
				break
			}
		}
		cancel()
		if err != nil && ctx.Err() == nil {
			a.Config.Logger.Printf("mail maintenance error_class=internal")
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
