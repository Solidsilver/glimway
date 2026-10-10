package api

import (
	"context"
	"database/sql"
	"errors"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/habitica"
	"glimway/server/internal/store"
	"net/http"
	"time"
)

// The gold purse (docs/design/purse-and-wardrobe.md 2): one top-up that
// moves gold off Habitica into the account's purse — one consent, one token,
// one request — and the read that shows it. Gold never goes back to Habitica
// and never leaves the game.

// purseComposition fills PlayerState.purse on every answer (2.5): the gold
// balance from balances.gold, what is left of today's two top-ups, and the
// top-up still working. The purse is the account's, not a screen's: guests
// have one too (it starts empty, section 5), and nothing about it comes from
// a browser report.
type purseComposition struct {
	store.StateComposition
	now func() time.Time
}

func (p purseComposition) PlayerState(ctx context.Context, tx *sql.Tx, s store.Snapshot) (*contract.PlayerState, error) {
	state, err := p.StateComposition.PlayerState(ctx, tx, s)
	if err != nil || s.AccountID == "" {
		return state, err
	}
	now := p.now().Unix()
	purse, err := store.PurseFor(ctx, tx, s.AccountID, now, utcDayStart(now))
	if err != nil {
		return nil, err
	}
	state.Purse = purse
	return state, nil
}

// topUpChecks is 2.3's balance-check schedule: about 2, 5, 10, 20 and 35
// seconds after the score call whose outcome was unknown. Tunable for tests.
func (a *Server) topUpChecks() []time.Duration {
	if len(a.Config.PurseChecks) > 0 {
		return a.Config.PurseChecks
	}
	return []time.Duration{2 * time.Second, 5 * time.Second, 10 * time.Second, 20 * time.Second, 35 * time.Second}
}

// topUpAnswerWait is how long the POST waits for its worker before answering
// the row as working (2.2 step 3: 8 seconds).
func (a *Server) topUpAnswerWait() time.Duration {
	if a.Config.PurseAnswerWait > 0 {
		return a.Config.PurseAnswerWait
	}
	return 8 * time.Second
}

// The worker's hard limit (2.2 step 2) and one call's timeout.
const (
	topUpWorkerLimit = 60 * time.Second
	habiticaCallTime = 10 * time.Second
)

func topUpAlias(id string) string { return "glimway-topup-" + id }

// purseTopUp (POST /api/purse/top-up) is one top-up: 2.2–2.5 in order. It is
// **not** on keyedOp — it keeps its own idempotency in purse_topups — because
// the request carries a Habitica token and the idempotency cache stores and
// serves whole payloads for seven days (review finding 9). The token comes
// off the request first, is used by the worker's calls and then dropped: it
// is never stored, logged, hashed or returned.
func (a *Server) purseTopUp(w http.ResponseWriter, r *http.Request) error {
	var req contract.PurseTopUpRequest
	if err := decodeOp(w, r, &req); err != nil {
		return err
	}
	// 2.2 step 0: the token comes off the request before anything reads it.
	token := req.Token
	req.Token = ""
	if token == "" || len(token) > 512 {
		return fail(400, "invalid-credentials")
	}
	if req.Op == nil || req.Op.Key == "" || len(req.Op.Key) > 128 {
		return fail(400, "key-required")
	}
	// Transaction 1: reserve (2.2 step 1). No Habitica call is made while a
	// transaction is open — the store is one connection and an upstream call
	// would hold every other request out for its duration (review finding 10).
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	ctx, now := r.Context(), a.Config.Now().Unix()
	if err = a.requireLease(ctx, tx, s, req.Op.Lease); err != nil {
		return a.refuseOp(w, r, tx, s, err)
	}
	if s.ProfileSource != "habitica" {
		return a.refuseOp(w, r, tx, s, fail(409, "needs-habitica"))
	}
	prior, err := store.TopUpByKey(ctx, tx, s.AccountID, req.Op.Key)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil {
		// A repeated key returns that top-up as it reads now: no new
		// Habitica calls, and the token is dropped at once (2.2 step 1).
		// The same key with a different amount is a mismatch, as elsewhere.
		if prior.Amount != int(req.Amount) {
			return a.refuseOp(w, r, tx, s, fail(409, "idempotency-mismatch"))
		}
		return a.writeTopUp(w, r, tx, s, prior)
	}
	// A working row older than 90 seconds has no live worker behind it
	// (2.4): settle it here the way the purse read does, so a dead worker's
	// row never answers the next top-up `purse-busy`.
	if err = store.SettleStaleTopUps(ctx, tx, s.AccountID, now); err != nil {
		return err
	}
	working, err := store.WorkingTopUp(ctx, tx, s.AccountID)
	if err != nil {
		return err
	}
	if working != nil {
		return a.refuseOp(w, r, tx, s, fail(409, "purse-busy"))
	}
	used, err := store.CountedTopUps(ctx, tx, s.AccountID, utcDayStart(now))
	if err != nil {
		return err
	}
	if used >= store.TopUpsADay {
		return a.refuseOp(w, r, tx, s, fail(409, "top-up-limit"))
	}
	// Habitica's gold cap, a whole number (2.2 step 1).
	amount := int(req.Amount)
	if amount < 1 || amount > 99999999 {
		return a.refuseOp(w, r, tx, s, fail(400, "invalid-quantity"))
	}
	subject, err := store.HabiticaSubject(ctx, tx, s.AccountID)
	if err != nil {
		return err
	}
	id, err := store.Random()
	if err != nil {
		return err
	}
	top := store.TopUp{ID: id, AccountID: s.AccountID, OpKey: req.Op.Key, Amount: amount, State: "reserved", CreatedAt: now}
	// The Habitica budget — the sign-in's four limits — is spent before any
	// row is written (2.2 step 1), and the worker runs under it.
	err = a.withHabitica(r, subject, func(b habiticaBudget) error {
		if e := store.InsertTopUp(ctx, tx, id, s.AccountID, req.Op.Key, int64(amount), now); e != nil {
			return e
		}
		if e := tx.Commit(); e != nil {
			return e
		}
		// Step 2: the detached worker, and the POST waits for it up to
		// eight seconds (2.2 step 3).
		done := make(chan struct{})
		go a.runTopUp(context.WithoutCancel(r.Context()), top, subject, token, b, done)
		select {
		case <-done:
		case <-time.After(a.topUpAnswerWait()):
		}
		return nil
	})
	if err != nil {
		var refused *budgetRefusal
		if errors.As(err, &refused) {
			return a.refuseOp(w, r, tx, s, budgetFailure(w, err))
		}
		return err
	}
	// The answer: the row as it reads now and the new PlayerState. A closed
	// tab loses nothing — the worker goes on and the next purse read shows
	// the outcome.
	return a.answerTopUp(w, r, id)
}

// answerTopUp writes one top-up's result: the row and the current state, in
// the envelope's purse_top_up case.
func (a *Server) answerTopUp(w http.ResponseWriter, r *http.Request, id string) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	t, err := store.TopUpFor(r.Context(), tx, id)
	if err != nil {
		return err
	}
	return a.writeTopUp(w, r, tx, s, t)
}

func (a *Server) writeTopUp(w http.ResponseWriter, r *http.Request, tx *sql.Tx, s store.Snapshot, t store.TopUp) error {
	state, err := a.Config.State.PlayerState(r.Context(), tx, s)
	if err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	return writeOpResult(w, state, &contract.PurseTopUpResult{TopUp: store.TopUpProto(t)})
}

// refuseOp answers an operation's refusal with the current PlayerState, as
// the keyed pipeline does: the client recovers from the state it carries.
func (a *Server) refuseOp(w http.ResponseWriter, r *http.Request, tx *sql.Tx, s store.Snapshot, err error) error {
	var f *failure
	if !errors.As(err, &f) {
		return err
	}
	state, e := a.Config.State.PlayerState(r.Context(), tx, s)
	if e != nil {
		return e
	}
	if e = tx.Commit(); e != nil {
		return e
	}
	writeRefusal(w, f.status, f.code, state)
	return nil
}

// withTx runs fn in its own short transaction. The worker's writes between
// its upstream calls all go through here: no transaction ever spans a call.
func (a *Server) withTx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := a.Store.DB.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if err = fn(tx); err != nil {
		return err
	}
	return tx.Commit()
}

// runTopUp is the detached half of a top-up (2.2 step 2): the leftovers, the
// gold read, the reward's create, the one score and the delete, and 2.3's
// balance checks when the score's outcome is unknown. It runs on a context
// detached from the browser's — a closed tab must not cut a call in half —
// with a hard 60-second limit. The token lives in this frame only.
//
// The score is sent **at most twice** (the one 429 retry, which Habitica
// refused before running) and **never again after an unknown outcome**: a
// timeout, a network error or a 5xx means we don't know whether the charge
// happened, and rule 4 is that we would rather owe the player than charge
// them twice. What happened is read off Habitica's gold instead (2.3).
func (a *Server) runTopUp(parent context.Context, t store.TopUp, subject, token string, b habiticaBudget, done chan struct{}) {
	// settle() before close(done): the waiter must see the settled row.
	defer close(done)
	ctx, cancel := context.WithTimeout(parent, topUpWorkerLimit)
	defer cancel()
	out := store.TopUpOutcome{State: "not-moved", SettledBy: "worker"}
	var owned []string
	createTried := false
	defer func() {
		// Step e: the delete after every create, whatever the outcome.
		// Fails: the row is marked leftover, and the next top-up removes
		// the reward first thing (2.2 step a).
		if createTried {
			call, stop := context.WithTimeout(ctx, habiticaCallTime)
			err := a.Habitica.DeleteTask(call, subject, token, topUpAlias(t.ID), b.Allow)
			stop()
			out.Leftover = err != nil
		}
		a.settleTopUp(ctx, t, out, owned)
	}()
	// a. Leftovers first (2.2 step a): the rewards earlier top-ups left
	// behind. 200 or 404 clears the mark; anything else leaves it for next
	// time and carries on.
	for _, id := range a.leftoverTopUps(ctx, t.AccountID, t.ID) {
		call, stop := context.WithTimeout(ctx, habiticaCallTime)
		err := a.Habitica.DeleteTask(call, subject, token, topUpAlias(id), b.Allow)
		stop()
		if err == nil {
			a.markLeftover(ctx, id, false)
		}
	}
	// b. Gold and owned gear (2.2 step b): one read, and `_id` must be the
	// account's Habitica subject. 401 or 403 settles `not-moved`, notes
	// habitica-auth, and counts a failed proof as a wrong sign-in token
	// does. Less than the amount settles `not-enough` and stops.
	call, stop := context.WithTimeout(ctx, habiticaCallTime)
	g, err := a.Habitica.Gold(call, subject, token, b.Allow)
	stop()
	if err != nil {
		if code := habiticaNote(err); code == "habitica-auth" {
			b.FailedProof()
		}
		out.Note = habiticaNote(err)
		return
	}
	if g.ID != subject {
		b.FailedProof()
		out.Note = "habitica-auth"
		return
	}
	goldBefore := g.Gold
	out.GoldBefore = &goldBefore
	owned = g.Owned
	if g.Gold < t.Amount {
		out.State = "not-enough"
		return
	}
	// c. Create (2.2 step c): the row is marked created first, then the
	// "Glimway purse" reward is added to the player's Habitica Rewards.
	// Anything but 201 — a timeout included — settles `not-moved` (nothing
	// was scored, so nothing was charged) and goes to the delete.
	createTried = true
	if err = a.markTopUp(ctx, t.ID, "created"); err != nil {
		return
	}
	call, stop = context.WithTimeout(ctx, habiticaCallTime)
	err = a.Habitica.CreateReward(call, subject, token, habitica.Reward{
		Type:  "reward",
		Text:  "Glimway purse: " + itoa(t.Amount) + " gold",
		Notes: "Glimway is moving gold into your purse. It removes this reward when it's done.",
		Value: t.Amount,
		Alias: topUpAlias(t.ID),
	}, b.Allow)
	stop()
	if err != nil {
		out.Note = habiticaNote(err)
		return
	}
	// d. Score (2.2 step d): marked scoring, then the one score — down,
	// never up. 200 is the charge; "Not Enough Gold" is `not-enough`; one
	// 429 is Habitica refusing before running it, and is sent once more
	// after its Retry-After (at most 5 s); anything else is unknown.
	if err = a.markTopUp(ctx, t.ID, "scoring"); err != nil {
		return
	}
	call, stop = context.WithTimeout(ctx, habiticaCallTime)
	after, err := a.Habitica.ScoreDown(call, subject, token, topUpAlias(t.ID), b.Allow)
	stop()
	if err != nil && isRateLimited(err) {
		wait := min(habiticaRetryAfter(err), 5*time.Second)
		select {
		case <-ctx.Done():
		case <-time.After(wait):
		}
		call, stop = context.WithTimeout(ctx, habiticaCallTime)
		after, err = a.Habitica.ScoreDown(call, subject, token, topUpAlias(t.ID), b.Allow)
		stop()
	}
	switch {
	case err == nil:
		goldAfter := after
		out.GoldAfter = &goldAfter
		out.State = "moved"
	case isNotEnoughGold(err):
		out.State = "not-enough"
	default:
		// Unknown. Never send the score again (2.3).
		out.Note = "timeout"
		a.checkAfterUnknown(ctx, t, subject, token, b, goldBefore, &out)
	}
}

// checkAfterUnknown is 2.3: the balance checks after a score whose outcome
// is unknown, at about 2, 5, 10, 20 and 35 seconds after the failed call.
// Gold at or below gold_before − amount is the move, confirmed and credited;
// gold at or above gold_before by the last check is `not-moved` (nothing
// credited, and the day is not used up); anything else, or every check
// failing, is `unconfirmed` (nothing credited, the day used, the owner's to
// settle from the command line).
func (a *Server) checkAfterUnknown(ctx context.Context, t store.TopUp, subject, token string, b habiticaBudget, goldBefore int, out *store.TopUpOutcome) {
	if err := a.markTopUp(ctx, t.ID, "checking"); err != nil {
		return
	}
	base := time.Now()
	last, saw := 0, false
	for _, offset := range a.topUpChecks() {
		if ctx.Err() != nil {
			break
		}
		if wait := offset - time.Since(base); wait > 0 {
			timer := time.NewTimer(wait)
			select {
			case <-ctx.Done():
				timer.Stop()
			case <-timer.C:
			}
		}
		if ctx.Err() != nil {
			break
		}
		call, stop := context.WithTimeout(ctx, habiticaCallTime)
		g, err := a.Habitica.Gold(call, subject, token, b.Allow)
		stop()
		if err != nil {
			continue
		}
		last, saw = g.Gold, true
		if g.Gold <= goldBefore-t.Amount {
			goldAfter := g.Gold
			out.GoldAfter = &goldAfter
			out.State, out.Note = "moved", "checked"
			return
		}
	}
	switch {
	case saw && last >= goldBefore:
		out.State = "not-moved"
	default:
		out.State = "unconfirmed"
	}
}

// settleTopUp is 2.2 step 3: the row's final state and evidence, and for a
// move the purse credited. The owned gear from the top-up's read lands here
// too (4.3).
func (a *Server) settleTopUp(ctx context.Context, t store.TopUp, out store.TopUpOutcome, owned []string) {
	// The settle is a database write and must land even at the worker's
	// time limit, so it takes its own short context.
	db, stop := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer stop()
	now := a.Config.Now().Unix()
	err := a.withTx(db, func(tx *sql.Tx) error {
		if owned != nil {
			if e := store.WritePlayerGear(db, tx, t.AccountID, owned, now); e != nil {
				return e
			}
		}
		return store.SettleTopUp(db, tx, t, out, now)
	})
	if err != nil && !errors.Is(err, store.ErrTopUpSettled) {
		a.Config.Logger.Printf("purse: settle top-up %s state=%s error=%v", t.ID, out.State, err)
	}
}

// leftoverTopUps is the earlier rows of this account whose reward may still
// sit in the player's Habitica Rewards (2.4).
func (a *Server) leftoverTopUps(ctx context.Context, account, self string) []string {
	db, stop := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer stop()
	out := []string{}
	err := a.withTx(db, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(db, "SELECT id FROM purse_topups WHERE account_id=? AND leftover=1 AND id!=?", account, self)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var id string
			if err = rows.Scan(&id); err != nil {
				return err
			}
			out = append(out, id)
		}
		return rows.Err()
	})
	if err != nil {
		a.Config.Logger.Printf("purse: leftovers for %s: %v", account, err)
	}
	return out
}

func (a *Server) markLeftover(ctx context.Context, id string, leftover bool) {
	a.withTx(ctx, func(tx *sql.Tx) error {
		_, err := tx.ExecContext(ctx, "UPDATE purse_topups SET leftover=? WHERE id=?", boolInt(leftover), id)
		return err
	})
}

// markTopUp moves a working row along its state machine (2.2 steps c and d)
// in its own small transaction.
func (a *Server) markTopUp(ctx context.Context, id, state string) error {
	db, stop := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer stop()
	return a.withTx(db, func(tx *sql.Tx) error {
		return store.MarkTopUpState(db, tx, id, state)
	})
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	out := ""
	for n > 0 {
		out = string(rune('0'+n%10)) + out
		n /= 10
	}
	return out
}

// habiticaNote is the code word a top-up's note carries (PurseTopUp.note):
// the upstream error's own code. The note never carries a body, a token or
// anything else from a response.
func habiticaNote(err error) string {
	var h *habitica.Error
	if errors.As(err, &h) {
		return h.Code
	}
	return "habitica-unavailable"
}

func isRateLimited(err error) bool { return habiticaNote(err) == "habitica-rate-limited" }

// isNotEnoughGold is the score's own refusal: Habitica's "Not Enough Gold",
// the one 401 that is not a bad token. The habitica package codes it with
// the wire's insufficient-gold (its codes are all wire codes); here it only
// means the row settles `not-enough`.
func isNotEnoughGold(err error) bool { return habiticaNote(err) == "insufficient-gold" }

func habiticaRetryAfter(err error) time.Duration {
	var h *habitica.Error
	if errors.As(err, &h) && h.RetryAfter > 0 {
		return h.RetryAfter
	}
	return time.Second
}

// habiticaFailure maps an upstream error onto the refusal it is on the wire
// (habitica-auth, habitica-unavailable, habitica-rate-limited,
// habitica-invalid-response): a status and a code word, never a body.
func habiticaFailure(err error) error {
	var h *habitica.Error
	if errors.As(err, &h) {
		return fail(h.Status, h.Code)
	}
	return fail(502, "habitica-unavailable")
}

// purseRead (GET /api/purse) is the log (2.1, 2.7): the purse, the last 50
// top-ups and the last 50 gold lines — every kind of them, letters and
// gives included. It settles stale working rows first (2.4), so a row whose
// worker died reads as what it is.
func (a *Server) purseRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := a.Config.Now().Unix()
	read, err := store.PurseRead(r.Context(), tx, s.AccountID, now, utcDayStart(now))
	if err != nil {
		return err
	}
	return a.finishRead(w, r, tx, s, read)
}
