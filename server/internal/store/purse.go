package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/itemmove"
	"google.golang.org/protobuf/types/known/wrapperspb"
	"strings"
)

// The purse's rows (docs/design/purse-and-wardrobe.md 2): purse_topups is
// the top-up's own idempotency and its state machine in one table, player_gear
// is the wardrobe's owned list (4.3), and the purse log reads the ledger's
// gold rows. Time is worked out, not ticked (crafts.md rule 3): every
// function here takes the caller's now.

// The four working states of a top-up (2.4): a row is working while its
// worker may still be running. The wire's PurseTopUp says "working" for all
// four and names the settled states only.
const (
	topUpWorkingSQL = "('reserved','created','scoring','checking')"
	// How long a working row may be assumed to have a live worker (the
	// worker's own limit is 60 seconds; 2.4).
	TopUpStaleAfter = 90
	// Top-ups a UTC day (2.5).
	TopUpsADay = 2
)

// TopUp is one purse_topups row.
type TopUp struct {
	ID         string
	AccountID  string
	OpKey      string
	Amount     int
	State      string
	GoldBefore sql.NullInt64
	GoldAfter  sql.NullInt64
	Note       string
	Leftover   bool
	CreatedAt  int64
	SettledAt  sql.NullInt64
	SettledBy  sql.NullString
}

// Working is true while the row's worker may still be running.
func (t TopUp) Working() bool {
	return t.State == "reserved" || t.State == "created" || t.State == "scoring" || t.State == "checking"
}

const topUpColumns = "id,account_id,op_key,amount,state,gold_before,gold_after,note,leftover,created_at,settled_at,settled_by"

func scanTopUp(row interface{ Scan(...any) error }) (TopUp, error) {
	var t TopUp
	var leftover int
	err := row.Scan(&t.ID, &t.AccountID, &t.OpKey, &t.Amount, &t.State, &t.GoldBefore, &t.GoldAfter, &t.Note, &leftover, &t.CreatedAt, &t.SettledAt, &t.SettledBy)
	t.Leftover = leftover == 1
	return t, err
}

// ErrTopUpSettled is a settle that lost its race: the row is already final,
// so nothing is credited twice (2.2 step 3: a row settles once).
var ErrTopUpSettled = errors.New("top-up already settled")

// InsertTopUp reserves the row (2.2 step 1). The row is its own idempotency:
// the unique (account_id, op_key) is what a repeated key meets. The reserve
// is a purse change like any other, so the account's version moves with it
// (finding 6): the answer carrying `working` must not be a same-version
// state the client drops as a conflict.
func InsertTopUp(ctx context.Context, tx *sql.Tx, id, account, opKey string, amount, now int64) error {
	if _, err := tx.ExecContext(ctx, "INSERT INTO purse_topups(id,account_id,op_key,amount,state,created_at) VALUES(?,?,?,?,?,?)", id, account, opKey, amount, "reserved", now); err != nil {
		return err
	}
	_, err := BumpAccountVersion(ctx, tx, account)
	return err
}

// TopUpByKey is the row a repeated key returns (2.2 step 1: no new Habitica
// calls). sql.ErrRows: none yet.
func TopUpByKey(ctx context.Context, tx *sql.Tx, account, opKey string) (TopUp, error) {
	return scanTopUp(tx.QueryRowContext(ctx, "SELECT "+topUpColumns+" FROM purse_topups WHERE account_id=? AND op_key=?", account, opKey))
}

// TopUpFor reads one row by id.
func TopUpFor(ctx context.Context, tx *sql.Tx, id string) (TopUp, error) {
	return scanTopUp(tx.QueryRowContext(ctx, "SELECT "+topUpColumns+" FROM purse_topups WHERE id=?", id))
}

// WorkingTopUp is the row still in flight, if any (2.4: one per account).
func WorkingTopUp(ctx context.Context, tx *sql.Tx, account string) (*TopUp, error) {
	t, err := scanTopUp(tx.QueryRowContext(ctx, "SELECT "+topUpColumns+" FROM purse_topups WHERE account_id=? AND state IN "+topUpWorkingSQL, account))
	if err == sql.ErrNoRows {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &t, nil
}

// MarkTopUpState moves a working row along its own state machine (2.2 steps
// c and d): reserved → created → scoring → checking. It never touches a
// settled row.
func MarkTopUpState(ctx context.Context, tx *sql.Tx, id, state string) error {
	res, err := tx.ExecContext(ctx, "UPDATE purse_topups SET state=? WHERE id=? AND state IN "+topUpWorkingSQL, state, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrTopUpSettled
	}
	return nil
}

// SettleTopUp lands one top-up (2.2 step 3): the row's final state and
// evidence, and for a move the purse credited — the only write that adds
// gold besides the owner's settle. The row settles once; a settle that lost
// its race credits nothing (ErrTopUpSettled).
func SettleTopUp(ctx context.Context, tx *sql.Tx, t TopUp, out TopUpOutcome, now int64) error {
	res, err := tx.ExecContext(ctx, "UPDATE purse_topups SET state=?,gold_before=?,gold_after=?,note=?,leftover=?,settled_at=?,settled_by=? WHERE id=? AND settled_at IS NULL",
		out.State, nullInt(out.GoldBefore), nullInt(out.GoldAfter), out.Note, boolInt(out.Leftover), now, out.SettledBy, t.ID)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return ErrTopUpSettled
	}
	if out.State == "moved" {
		reason := "habitica-topup"
		if out.SettledBy == "owner" {
			reason = "purse-settle"
		}
		// CreditGold moves the version; every other outcome moves it here
		// (finding 6): `unconfirmed`, `not-moved` and `not-enough` change
		// the purse on the wire just as much.
		if err = CreditGold(ctx, tx, t.AccountID, t.Amount, reason, t.ID, now); err != nil {
			return err
		}
	} else if _, err = BumpAccountVersion(ctx, tx, t.AccountID); err != nil {
		return err
	}
	return nil
}

// TopUpOutcome is where a top-up landed (2.2, 2.3): the settled state, the
// note's code word, Habitica's gold before and after (nil: never read), and
// whether a "Glimway purse" reward may still sit in the player's Rewards.
type TopUpOutcome struct {
	State      string // moved | not-enough | not-moved | unconfirmed
	Note       string
	GoldBefore *int
	GoldAfter  *int
	Leftover   bool
	SettledBy  string // worker | look | owner
}

func nullInt(v *int) any {
	if v == nil {
		return nil
	}
	return *v
}
func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// SettleStaleTopUps is 2.4's lazy settle: a working row older than 90
// seconds has no live worker behind it (the worker's own limit is 60). It
// settles then as `unconfirmed` if it got as far as scoring or checking,
// `not-moved` if it stopped at reserved or created, and is marked leftover
// from `created` on (the reward may exist). It runs when someone looks: the
// purse read, the next top-up's reserve, PlayerState. It answers the
// account's version after the settles (0 when there were none), so a state
// built straight after carries it (finding 6).
func SettleStaleTopUps(ctx context.Context, tx *sql.Tx, account string, now int64) (int64, error) {
	rows, err := tx.QueryContext(ctx, "SELECT "+topUpColumns+" FROM purse_topups WHERE account_id=? AND state IN "+topUpWorkingSQL+" AND created_at<=?", account, now-TopUpStaleAfter)
	if err != nil {
		return 0, err
	}
	var stale []TopUp
	for rows.Next() {
		t, err := scanTopUp(rows)
		if err != nil {
			rows.Close()
			return 0, err
		}
		stale = append(stale, t)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return 0, err
	}
	var version int64
	for _, t := range stale {
		out := TopUpOutcome{State: "not-moved", SettledBy: "look", Leftover: t.State != "reserved"}
		if t.State == "scoring" || t.State == "checking" {
			out.State, out.Note = "unconfirmed", "timeout"
		}
		if err = SettleTopUp(ctx, tx, t, out, now); err != nil && !errors.Is(err, ErrTopUpSettled) {
			return 0, err
		}
	}
	if len(stale) > 0 {
		if version, err = AccountVersion(ctx, tx, account); err != nil {
			return 0, err
		}
	}
	return version, nil
}

// AccountVersion reads an account's answer version back.
func AccountVersion(ctx context.Context, tx *sql.Tx, account string) (int64, error) {
	var v int64
	err := tx.QueryRowContext(ctx, "SELECT version FROM players WHERE account_id=?", account).Scan(&v)
	return v, err
}

// CountedTopUps is what counts toward today's two (2.5): moved, unconfirmed
// and any working row. Not: not-enough, not-moved, and a refused token — a
// top-up that moved nothing never uses up the day. `since` is the UTC
// midnight the count starts at (the api passes utcDayStart(now), the one
// day helper).
func CountedTopUps(ctx context.Context, tx *sql.Tx, account string, since int64) (int, error) {
	var n int
	err := tx.QueryRowContext(ctx, "SELECT count(*) FROM purse_topups WHERE account_id=? AND created_at>=? AND (state IN ('moved','unconfirmed') OR state IN "+topUpWorkingSQL+")", account, since).Scan(&n)
	return n, err
}

// PurseFor is the purse on every answer (PlayerState.purse): the gold
// balance, what is left of today's two top-ups, and the top-up still
// working. The stale settle runs first (2.4), so a dead worker's row reads
// as settled. dayStart is the UTC midnight of the counting day.
func PurseFor(ctx context.Context, tx *sql.Tx, account string, now, dayStart int64) (*contract.Purse, error) {
	if _, err := SettleStaleTopUps(ctx, tx, account, now); err != nil {
		return nil, err
	}
	gold, err := GoldFor(ctx, tx, account)
	if err != nil {
		return nil, err
	}
	used, err := CountedTopUps(ctx, tx, account, dayStart)
	if err != nil {
		return nil, err
	}
	out := &contract.Purse{Gold: int32(min(gold, 1<<31-1)), TopUpsLeft: int32(max(0, TopUpsADay-used))}
	working, err := WorkingTopUp(ctx, tx, account)
	if err != nil {
		return nil, err
	}
	if working != nil {
		out.Working = TopUpProto(*working)
	}
	return out, nil
}

// TopUpProto is one row on the wire: the four working states read as
// "working", the settled ones by name; Habitica's gold is absent until it
// was read.
func TopUpProto(t TopUp) *contract.PurseTopUp {
	state := t.State
	if t.Working() {
		state = "working"
	}
	out := &contract.PurseTopUp{Id: t.ID, Amount: int32(t.Amount), State: state, StartedAt: float64(t.CreatedAt), Leftover: t.Leftover, Note: t.Note}
	if t.GoldBefore.Valid {
		out.GoldBefore = wrapperspb.Int32(int32(t.GoldBefore.Int64))
	}
	if t.GoldAfter.Valid {
		out.GoldAfter = wrapperspb.Int32(int32(t.GoldAfter.Int64))
	}
	if t.SettledAt.Valid {
		out.SettledAt = wrapperspb.Double(float64(t.SettledAt.Int64))
	}
	return out
}

// PurseTopUps reads the log's top-up half: the last 50, newest first.
func PurseTopUps(ctx context.Context, tx *sql.Tx, account string) ([]*contract.PurseTopUp, error) {
	rows, err := tx.QueryContext(ctx, "SELECT "+topUpColumns+" FROM purse_topups WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 50", account)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []*contract.PurseTopUp{}
	for rows.Next() {
		t, err := scanTopUp(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, TopUpProto(t))
	}
	return out, rows.Err()
}

// PurseRead builds GET /api/purse (2.7): the purse, the last 50 top-ups and
// the last 50 gold lines, every kind of them — a buy at a seller, a shelf
// trade, a letter waiting or collected or come back, a gift by hand.
func PurseRead(ctx context.Context, tx *sql.Tx, account string, now, dayStart int64) (*contract.PurseRead, error) {
	purse, err := PurseFor(ctx, tx, account, now, dayStart)
	if err != nil {
		return nil, err
	}
	topUps, err := PurseTopUps(ctx, tx, account)
	if err != nil {
		return nil, err
	}
	lines, err := PurseLines(ctx, tx, account)
	if err != nil {
		return nil, err
	}
	return &contract.PurseRead{Purse: purse, TopUps: topUps, Lines: lines}, nil
}

// PurseLines maps the account's gold ledger rows onto the log (2.1): the
// last 50, newest first. Gold only ever moves with one of these rows (3.5),
// so the ledger is the log — Habitica keeps no record of a top-up and this
// is the only one.
//
// The reason is the ledger's own word (PurseLine.reason's vocabulary). The
// row's ref carries what names the line, in the shapes lane C writes (see
// .agent/EARLY.md): a mail id for letters, the other account and the item
// for a shelf trade (either order), the other account for a give, and the
// seller's id and good for a market buy (market.go's ref).
func PurseLines(ctx context.Context, tx *sql.Tx, account string) ([]*contract.PurseLine, error) {
	rows, err := tx.QueryContext(ctx, "SELECT created_at,delta,reason,ref FROM ledger WHERE account_id=? AND currency='"+itemmove.Gold()+"' ORDER BY created_at DESC,id DESC LIMIT 50", account)
	if err != nil {
		return nil, err
	}
	type goldRow struct {
		at          int64
		delta       int
		reason, ref string
	}
	var held []goldRow
	for rows.Next() {
		var r goldRow
		if err = rows.Scan(&r.at, &r.delta, &r.reason, &r.ref); err != nil {
			rows.Close()
			return nil, err
		}
		held = append(held, r)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		return nil, err
	}
	out := []*contract.PurseLine{}
	for _, r := range held {
		line := &contract.PurseLine{At: float64(r.at), Delta: int32(r.delta), Reason: r.reason}
		switch r.reason {
		case "mail-send", "mail-claim", "mail-return", "mail-recall":
			if err = mailLine(ctx, tx, account, r.ref, line); err != nil {
				return nil, err
			}
		case "market-buy":
			marketLine(r.ref, line)
		case "shelf-buy", "shelf-sale":
			if err = shelfLine(ctx, tx, r.ref, line); err != nil {
				return nil, err
			}
		case "give", "gift":
			name, err := displayName(ctx, tx, r.ref)
			if err != nil {
				return nil, err
			}
			line.OtherName = name
		}
		out = append(out, line)
	}
	return out, nil
}

// mailLine names the letter and its other end, and says where the letter is
// now: waiting | collected | came-back (PurseLine.mail_state). The gold sits
// in the letter between send and claim or return (3.3), so the state is the
// mail row's, not the ledger's.
func mailLine(ctx context.Context, tx *sql.Tx, account, mailID string, line *contract.PurseLine) error {
	var from, to, kind, def string
	var qty int
	var claimed, returned sql.NullInt64
	err := tx.QueryRowContext(ctx, "SELECT from_id,to_id,kind,item_def,qty,claimed_at,returned_at FROM mail WHERE id=?", mailID).Scan(&from, &to, &kind, &def, &qty, &claimed, &returned)
	if err == sql.ErrNoRows {
		// The letter is gone from the table (long past its history); the
		// line still stands on its own.
		line.MailId = mailID
		line.MailState = "came-back"
		return nil
	}
	if err != nil {
		return err
	}
	other := to
	if account != from {
		other = from
	}
	name, err := displayName(ctx, tx, other)
	if err != nil {
		return err
	}
	line.MailId, line.OtherName, line.ItemDef, line.Qty = mailID, name, "gold", int32(qty)
	switch {
	case claimed.Valid:
		line.MailState = "collected"
	case returned.Valid:
		line.MailState = "came-back"
	default:
		line.MailState = "waiting"
	}
	return nil
}

// marketLine names the good and the seller on a buy ("Bought timber ×4
// from Silas"): the ref market.go writes is "<seller>:<good item>", and the
// numbers come from content.
func marketLine(ref string, line *contract.PurseLine) {
	sellerID, item, _ := strings.Cut(ref, ":")
	line.ItemDef = item
	if seller, ok := content.SellerFor(sellerID); ok {
		line.Seller = seller.GetNpc()
		for _, g := range seller.GetGoods() {
			if g.GetItem() == item {
				line.Qty = int32(g.GetQty())
			}
		}
	}
}

// shelfLine names the other trader and the good (3.2: "each with the other
// account and the item in its ref so both logs can name them"). The ref is
// "<account>:<item>"; the parse tolerates either order, because the ledger
// row is the record of both logs.
func shelfLine(ctx context.Context, tx *sql.Tx, ref string, line *contract.PurseLine) error {
	first, second, _ := strings.Cut(ref, ":")
	if second == "" {
		line.ItemDef = first
		return nil
	}
	var found string
	err := tx.QueryRowContext(ctx, "SELECT account_id FROM players WHERE account_id=? OR account_id=? LIMIT 1", first, second).Scan(&found)
	if err != nil && err != sql.ErrNoRows {
		return err
	}
	switch found {
	case first:
		line.ItemDef = second
		name, err := displayName(ctx, tx, first)
		if err != nil {
			return err
		}
		line.OtherName = name
	case second:
		line.ItemDef = first
		name, err := displayName(ctx, tx, second)
		if err != nil {
			return err
		}
		line.OtherName = name
	default:
		line.ItemDef = second
	}
	return nil
}

func displayName(ctx context.Context, tx *sql.Tx, account string) (string, error) {
	if account == "" {
		return "", nil
	}
	var name string
	err := tx.QueryRowContext(ctx, "SELECT display_name FROM players WHERE account_id=?", account).Scan(&name)
	if err == sql.ErrNoRows {
		return "", nil
	}
	return name, err
}

// ------------------------------------------------- the owner's command line

// PurseTopUpRow is one line of `purse list` (2.6): id, account, amount,
// state, Habitica's gold before and after, and when.
type PurseTopUpRow struct {
	ID         string `json:"id"`
	Account    string `json:"account"`
	Subject    string `json:"subject,omitempty"`
	Amount     int    `json:"amount"`
	State      string `json:"state"`
	GoldBefore *int   `json:"goldBefore,omitempty"`
	GoldAfter  *int   `json:"goldAfter,omitempty"`
	Note       string `json:"note,omitempty"`
	Leftover   bool   `json:"leftover"`
	StartedAt  int64  `json:"startedAt"`
	SettledAt  *int64 `json:"settledAt,omitempty"`
	SettledBy  string `json:"settledBy,omitempty"`
}

// PurseTopUpList reads the owner's list: every top-up, or only the
// unconfirmed ones (2.6, `purse list [--unconfirmed]`).
func (s *Store) PurseTopUpList(ctx context.Context, unconfirmedOnly bool) ([]PurseTopUpRow, error) {
	sqlText := "SELECT " + topUpColumns + ",COALESCE((SELECT subject FROM sign_ins WHERE account_id=purse_topups.account_id AND method='habitica'),'') FROM purse_topups"
	if unconfirmedOnly {
		sqlText += " WHERE state='unconfirmed'"
	}
	sqlText += " ORDER BY created_at DESC,id DESC"
	rows, err := s.DB.QueryContext(ctx, sqlText)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []PurseTopUpRow{}
	for rows.Next() {
		var t TopUp
		var leftover int
		var subject string
		if err = rows.Scan(&t.ID, &t.AccountID, &t.OpKey, &t.Amount, &t.State, &t.GoldBefore, &t.GoldAfter, &t.Note, &leftover, &t.CreatedAt, &t.SettledAt, &t.SettledBy, &subject); err != nil {
			return nil, err
		}
		t.Leftover = leftover == 1
		row := PurseTopUpRow{ID: t.ID, Account: t.AccountID, Subject: subject, Amount: t.Amount, State: t.State, Note: t.Note, Leftover: t.Leftover, StartedAt: t.CreatedAt}
		if t.GoldBefore.Valid {
			v := int(t.GoldBefore.Int64)
			row.GoldBefore = &v
		}
		if t.GoldAfter.Valid {
			v := int(t.GoldAfter.Int64)
			row.GoldAfter = &v
		}
		if t.SettledAt.Valid {
			v := t.SettledAt.Int64
			row.SettledAt = &v
			row.SettledBy = t.SettledBy.String
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

// SettleTopUpByOwner is `purse settle <id> moved|not-moved` (2.6): only an
// `unconfirmed` row, one the checks could not decide — which is settled
// already, so this settles it a second time, with the answer the owner got
// from the player. `moved` credits the purse with the ledger reason
// purse-settle; both mark the row settled by the owner. The stored
// gold_before is the evidence.
func (s *Store) SettleTopUpByOwner(ctx context.Context, id, outcome string, now int64) error {
	if outcome != "moved" && outcome != "not-moved" {
		return fmt.Errorf("outcome must be moved or not-moved")
	}
	tx, err := s.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	t, err := TopUpFor(ctx, tx, id)
	if err == sql.ErrNoRows {
		return fmt.Errorf("no top-up %s", id)
	}
	if err != nil {
		return err
	}
	if t.State != "unconfirmed" {
		return fmt.Errorf("top-up %s is %s, not unconfirmed", id, t.State)
	}
	// The row is settled already — the checks gave up on it — so the
	// worker's note and its settle time stay as they are (finding 18): they
	// are the evidence of why the owner is here. A row with no note is
	// marked with the vocabulary's settled-by-owner.
	note := t.Note
	if note == "" {
		note = "settled-by-owner"
	}
	settledAt := int64(now)
	if t.SettledAt.Valid {
		settledAt = t.SettledAt.Int64
	}
	res, err := tx.ExecContext(ctx, "UPDATE purse_topups SET state=?,settled_at=?,settled_by='owner',note=? WHERE id=? AND state='unconfirmed'", outcome, settledAt, note, id)
	if err != nil {
		return err
	}
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n != 1 {
		return fmt.Errorf("top-up %s was settled elsewhere", id)
	}
	if outcome == "moved" {
		// CreditGold moves the version (finding 6); `not-moved` moves it
		// here, because the purse changed on the wire all the same.
		if err = CreditGold(ctx, tx, t.AccountID, t.Amount, "purse-settle", id, now); err != nil {
			return err
		}
	} else if _, err = BumpAccountVersion(ctx, tx, t.AccountID); err != nil {
		return err
	}
	return tx.Commit()
}

// --------------------------------------------------------------- owned gear

// WritePlayerGear is one of the three server reads landing in player_gear
// (4.3): sign-in, a top-up, and the wardrobe's gear check. The list is the
// sorted keys the catalog knows and the player owns; the browser never
// writes it, and it is never part of PlayerState.
func WritePlayerGear(ctx context.Context, tx *sql.Tx, account string, owned []string, now int64) error {
	list := JSON(append([]string{}, owned...))
	_, err := tx.ExecContext(ctx, "INSERT INTO player_gear(account_id,owned_json,checked_at) VALUES(?,?,?) ON CONFLICT(account_id) DO UPDATE SET owned_json=excluded.owned_json,checked_at=excluded.checked_at", account, list, now)
	return err
}

// PlayerGear reads the owned list back, and when the server last read it
// (0 before the first check).
func PlayerGear(ctx context.Context, tx *sql.Tx, account string) ([]string, int64, error) {
	var raw string
	var checked int64
	err := tx.QueryRowContext(ctx, "SELECT owned_json,checked_at FROM player_gear WHERE account_id=?", account).Scan(&raw, &checked)
	if err == sql.ErrNoRows {
		return nil, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	out := []string{}
	if err = json.Unmarshal([]byte(raw), &out); err != nil {
		return nil, 0, err
	}
	return out, checked, nil
}
