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

// The top-up (docs/design/purse-and-wardrobe.md 2, silas-yard.md 1.5): one
// top-up turns Habitica gold into glims, two gold to a glim — one consent,
// one token, one request — and the Glim log shows it. Glims never go back to
// Habitica.

// purseComposition fills PlayerState.purse on every answer (2.5): what is
// left of today's two top-ups and of its 30 glims, and the top-up still
// working. The purse is the account's, not a screen's: guests
// have one too (it starts empty, section 5), and nothing about it comes from
// a browser report.
type purseComposition struct {
	store.StateComposition
	now func() time.Time
}

func (p purseComposition) PlayerState(ctx context.Context, tx *sql.Tx, s store.Snapshot) (*contract.PlayerState, error) {
	if s.AccountID == "" {
		return p.StateComposition.PlayerState(ctx, tx, s)
	}
	now := p.now().Unix()
	// The lazy settle runs first (2.4, finding 6): it moves the account's
	// version, and the answer must carry the new one — a same-version state
	// with different contents is a conflict the client drops.
	version, err := store.SettleStaleTopUps(ctx, tx, s.AccountID, now)
	if err != nil {
		return nil, err
	}
	if version != 0 {
		// A lazy settle never credits (it lands `unconfirmed` or
		// `not-moved`), so the snapshot's glims stand.
		s.Version = version
	}
	state, err := p.StateComposition.PlayerState(ctx, tx, s)
	if err != nil {
		return nil, err
	}
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
	// row never answers the next top-up `purse-busy`. Its version moves
	// with it, and this answer carries the new one (finding 6).
	version, err := store.SettleStaleTopUps(ctx, tx, s.AccountID, now)
	if err != nil {
		return err
	}
	if version != 0 {
		s.Version = version
	}
	working, err := store.WorkingTopUp(ctx, tx, s.AccountID)
	if err != nil {
		return err
	}
	if working != nil {
		return a.refuseOp(w, r, tx, s, fail(409, "purse-busy"))
	}
	used, glims, err := store.CountedTopUps(ctx, tx, s.AccountID, utcDayStart(now))
	if err != nil {
		return err
	}
	if used >= store.TopUpsADay {
		return a.refuseOp(w, r, tx, s, fail(409, "top-up-limit"))
	}
	// The amount is Habitica gold, two to a glim (silas-yard.md 1.5): a
	// whole, even number of at least 2 (2.2 step 1).
	amount := int(req.Amount)
	if amount < store.GoldPerGlim || amount%store.GoldPerGlim != 0 || amount > 99999999 {
		return a.refuseOp(w, r, tx, s, fail(400, "invalid-quantity"))
	}
	// The day's cap: at most 30 glims from top-ups a UTC day, counting
	// today's moved, unconfirmed and working rows (1.5).
	if glims+amount/store.GoldPerGlim > store.TopUpGlimsADay {
		return a.refuseOp(w, r, tx, s, fail(409, "top-up-cap"))
	}
	subject, err := store.HabiticaSubject(ctx, tx, s.AccountID)
	if err != nil {
		return err
	}
	id, err := store.Random()
	if err != nil {
		return err
	}
	top := store.TopUp{ID: id, AccountID: s.AccountID, OpKey: req.Op.Key, Amount: amount, Glims: amount / store.GoldPerGlim, State: "reserved", CreatedAt: now}
	done := make(chan struct{})
	// The Habitica budget — the sign-in's four limits — is spent before any
	// row is written (2.2 step 1). The worker is started under it and runs
	// on; the wait below is outside the slot (finding 14), so a slow
	// Habitica never holds a sign-in's concurrency slot for the answer.
	err = a.withHabitica(r, subject, func(b habiticaBudget) error {
		if e := store.InsertTopUp(ctx, tx, id, s.AccountID, req.Op.Key, int64(amount), now); e != nil {
			return e
		}
		if e := tx.Commit(); e != nil {
			return e
		}
		// Step 2: the detached worker (2.2).
		a.startWorker(context.WithoutCancel(r.Context()), top, subject, token, b, done)
		return nil
	})
	if err != nil {
		var refused *budgetRefusal
		if errors.As(err, &refused) {
			return a.refuseOp(w, r, tx, s, budgetFailure(w, err))
		}
		return err
	}
	// The POST waits for the worker up to eight seconds (2.2 step 3), and
	// gives up early if the browser is gone: the worker finishes either way.
	select {
	case <-done:
	case <-time.After(a.topUpAnswerWait()):
	case <-r.Context().Done():
	}
	// The answer: the row as it reads now and the new PlayerState. A closed
	// tab loses nothing — the worker goes on and the next purse read shows
	// the outcome.
	return a.answerTopUp(w, r, id)
}

// startWorker runs one detached top-up worker, tracked so Close can wait
// for it (finding 11).
func (a *Server) startWorker(ctx context.Context, t store.TopUp, subject, token string, b habiticaBudget, done chan struct{}) {
	a.workers.Add(1)
	go func() {
		defer a.workers.Done()
		a.runTopUp(ctx, t, subject, token, b, done)
	}()
}

// Close waits for the detached workers (the purse's top-up workers) within
// ctx (finding 11): a worker that is about to settle a `moved` row must not
// have its database closed under it. Production calls it after
// http.Server.Shutdown, tests in their cleanup.
func (a *Server) Close(ctx context.Context) {
	done := make(chan struct{})
	go func() {
		a.workers.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
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

// runTopUp is the detached half of a top-up (2.2 step 2): the gold read,
// the leftovers, the reward's create, the one score and the delete, and
// 2.3's balance checks when the score's outcome is unknown. It runs on a
// context detached from the browser's — a closed tab must not cut a call in
// half — with a hard 60-second limit. The token lives in this frame only.
//
// The score is sent **at most twice** (the one 429 retry, which Habitica
// refused before running) and **never again after an unknown outcome**: a
// timeout, a network error or a 5xx means we don't know whether the charge
// happened, and rule 4 is that we would rather owe the player than charge
// them twice. What happened is read off Habitica's gold instead (2.3).
func (a *Server) runTopUp(parent context.Context, t store.TopUp, subject, token string, b habiticaBudget, done chan struct{}) {
	// settle() before close(done): the waiter must see the settled row.
	defer close(done)
	// A panic in this goroutine isn't net/http's to catch — it would take
	// the server down. Log the id (never a token) and leave the row for the
	// lazy settle (finding 13).
	defer func() {
		if r := recover(); r != nil {
			a.Config.Logger.Printf("purse: worker panic top-up=%s", t.ID)
		}
	}()
	ctx, cancel := context.WithTimeout(parent, topUpWorkerLimit)
	defer cancel()
	out := store.TopUpOutcome{State: "not-moved", SettledBy: "worker"}
	var owned []string
	createTried, createUnknown := false, false
	defer func() {
		// Step e: the delete after every create, whatever the outcome.
		// Fails: the row is marked leftover, and the next top-up removes
		// the reward first thing (2.2 step a). A create whose outcome is
		// unknown keeps the mark whatever the delete finds (finding 9):
		// the create may still land after the delete went looking.
		if createTried {
			call, stop := context.WithTimeout(ctx, habiticaCallTime)
			err := a.Habitica.DeleteTask(call, subject, token, topUpAlias(t.ID), b.Allow)
			stop()
			out.Leftover = createUnknown || err != nil
		}
		a.settleTopUp(ctx, t, out, owned)
	}()
	// b. Gold and owned gear first (2.2 step b, and finding 7): one read,
	// and `_id` must be the account's Habitica subject. The read proves the
	// token, so a wrong one sends no deletes upstream and no leftover is
	// touched. 401 or 403 settles `not-moved`, notes habitica-auth, and
	// counts a failed proof as a wrong sign-in token does — straight on the
	// limiter, because this can happen after the request's own reservation
	// was released. Less than the amount settles `not-enough` and stops.
	call, stop := context.WithTimeout(ctx, habiticaCallTime)
	g, err := a.Habitica.Gold(call, subject, token, b.Allow)
	stop()
	if err != nil {
		if habiticaCode(err) == "habitica-auth" {
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
	// a. Leftovers (2.2 step a): the rewards earlier top-ups left behind,
	// at most two and oldest first (finding 10), before this one's own
	// create. 200 or 404 clears the mark; anything else leaves it for next
	// time and carries on.
	for _, id := range a.leftoverTopUps(ctx, t.AccountID, t.ID) {
		call, stop := context.WithTimeout(ctx, habiticaCallTime)
		err := a.Habitica.DeleteTask(call, subject, token, topUpAlias(id), b.Allow)
		stop()
		if err == nil {
			a.markLeftover(ctx, id, false)
		}
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
		Notes: "Glimway is turning " + itoa(t.Amount) + " gold into " + glimsPhrase(t.Glims) + ". It removes this reward when it's done.",
		Value: t.Amount,
		Alias: topUpAlias(t.ID),
	}, b.Allow)
	stop()
	if err != nil {
		out.Note = habiticaNote(err)
		createUnknown = isUnknownOutcome(err)
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
	if err != nil && isRateLimited(err) && habiticaSent(err) {
		// The one retry (finding 5: the wait is the Retry-After Habitica
		// actually sent, capped at 5 s as 2.2 says).
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
	case !habiticaSent(err):
		// Our own budget refused the score before it left (finding 4):
		// nothing was charged, so this is not an unknown outcome and never
		// goes to the checks.
		out.State, out.Note = "not-moved", "habitica-rate-limited"
	case isScoreRefusal(err):
		// The read and the create went through with this token moments ago,
		// so a 401 here is Habitica's "Not Enough Gold" whatever language
		// it says it in (finding 17). A 401 is a refused request either way:
		// nothing was charged.
		out.State = "not-enough"
	default:
		// Unknown. Never send the score again (2.3) — and an undecided
		// outcome is `unconfirmed` from here on, whatever the checks find
		// (finding 1): a row nobody must call `not-moved`.
		out.State, out.Note = "unconfirmed", "timeout"
		a.checkAfterUnknown(ctx, t, subject, token, b, goldBefore, &out)
	}
}

// checkAfterUnknown is 2.3: the balance checks after a score whose outcome
// is unknown, at about 2, 5, 10, 20 and 35 seconds after the failed call.
// Gold at or below gold_before − amount is the move, confirmed and credited;
// `not-moved` is decided **only** by the final scheduled check reading gold
// at or above gold_before — that check is the one meant to be after any
// request still running on Habitica's side (finding 2). Anything else — the
// last check failing or never running included — is `unconfirmed`: nothing
// credited, the day used, the owner's to settle from the command line.
func (a *Server) checkAfterUnknown(ctx context.Context, t store.TopUp, subject, token string, b habiticaBudget, goldBefore int, out *store.TopUpOutcome) {
	// The offsets run from the failed call (2.3); measuring from here only
	// skips the few milliseconds of the `checking` mark (finding 18).
	base := time.Now()
	checks := a.topUpChecks()
	// The checks get their own guaranteed time budget (finding 3): a slow
	// run of deletes and calls before them must not cut off the last check,
	// which is the one that decides `not-moved`. Still well under the 90 s
	// at which a look settles the row.
	deadline := base.Add(checks[len(checks)-1] + habiticaCallTime)
	if d, ok := ctx.Deadline(); ok && d.After(deadline) {
		deadline = d
	}
	checkCtx, stopChecks := context.WithDeadline(context.WithoutCancel(ctx), deadline)
	defer stopChecks()
	// A failed `checking` mark is not fatal (finding 1): the checks run
	// anyway, and settling is what makes the row final.
	_ = a.markTopUp(checkCtx, t.ID, "checking")
	lastReading, sawLast := 0, false
	for i, offset := range checks {
		if checkCtx.Err() != nil {
			break
		}
		if wait := offset - time.Since(base); wait > 0 {
			timer := time.NewTimer(wait)
			select {
			case <-checkCtx.Done():
				timer.Stop()
			case <-timer.C:
			}
		}
		if checkCtx.Err() != nil {
			break
		}
		call, stop := context.WithTimeout(checkCtx, habiticaCallTime)
		g, err := a.Habitica.Gold(call, subject, token, b.Allow)
		stop()
		if err != nil {
			continue
		}
		if g.Gold <= goldBefore-t.Amount {
			goldAfter := g.Gold
			out.GoldAfter = &goldAfter
			out.State, out.Note = "moved", "checked"
			return
		}
		lastReading, sawLast = g.Gold, i == len(checks)-1
	}
	if sawLast && lastReading >= goldBefore {
		out.State = "not-moved"
	} else {
		out.State = "unconfirmed"
	}
}

// settleTopUp is 2.2 step 3: the row's final state and evidence, and for a
// move the row's glims credited. The owned gear from the top-up's read lands here
// too (4.3).
func (a *Server) settleTopUp(ctx context.Context, t store.TopUp, out store.TopUpOutcome, owned []string) {
	// The settle is a database write and must land even at the worker's
	// time limit, so it takes its own short context.
	db, stop := context.WithTimeout(context.WithoutCancel(ctx), 15*time.Second)
	defer stop()
	now := a.Config.Now().Unix()
	var look *presenceAvatarMsg
	err := a.withTx(db, func(tx *sql.Tx) error {
		if owned != nil {
			moved, e := store.WritePlayerGear(db, tx, t.AccountID, owned, now)
			if e != nil {
				return e
			}
			if look, e = gearLook(db, tx, t.AccountID, moved); e != nil {
				return e
			}
		}
		return store.SettleTopUp(db, tx, t, out, now)
	})
	if err == nil && look != nil {
		a.avatarChanged(t.AccountID, look)
	}
	if err != nil && !errors.Is(err, store.ErrTopUpSettled) {
		a.Config.Logger.Printf("purse: settle top-up %s state=%s error=%v", t.ID, out.State, err)
	}
	if errors.Is(err, store.ErrTopUpSettled) {
		// A look settled the row first (finding 12): the worker's outcome
		// and its evidence are worth one line.
		a.Config.Logger.Printf("purse: top-up %s settled by a look before the worker's %s outcome landed", t.ID, out.State)
	}
}

// leftoverTopUps is the earlier rows of this account whose reward may still
// sit in the player's Habitica Rewards (2.4) — at most two, oldest first
// (finding 10): the design plans for two, and an unbounded loop of deletes
// would eat the worker's time and the user's per-minute calls before the
// reward this top-up is here for.
func (a *Server) leftoverTopUps(ctx context.Context, account, self string) []string {
	db, stop := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer stop()
	out := []string{}
	err := a.withTx(db, func(tx *sql.Tx) error {
		rows, err := tx.QueryContext(db, "SELECT id FROM purse_topups WHERE account_id=? AND leftover=1 AND id!=? ORDER BY created_at,id LIMIT 2", account, self)
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
	if a.topUpMark != nil {
		if err := a.topUpMark(id, state); err != nil {
			return err
		}
	}
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

// habiticaCode is the upstream error's own code word.
func habiticaCode(err error) string {
	var h *habitica.Error
	if errors.As(err, &h) {
		return h.Code
	}
	return "habitica-unavailable"
}

// habiticaNote is the code word a top-up's note carries (PurseTopUp.note):
// the documented vocabulary — habitica-auth, habitica-unavailable,
// habitica-rate-limited, timeout, checked, settled-by-owner — and nothing
// else (finding 16). Anything the upstream said outside it is mapped on.
// The note never carries a body, a token or anything else from a response.
func habiticaNote(err error) string {
	switch habiticaCode(err) {
	case "habitica-auth":
		return "habitica-auth"
	case "habitica-rate-limited", "login-global-rate-limited":
		return "habitica-rate-limited"
	default:
		return "habitica-unavailable"
	}
}

// habiticaSent says the request reached Habitica — or may have. Our own
// budget refusing a call is the one thing that means "not sent": nothing
// left the server, so nothing was charged (finding 4).
func habiticaSent(err error) bool {
	var h *habitica.Error
	if errors.As(err, &h) {
		return h.Sent
	}
	return true
}

// isUnknownOutcome is a create whose reward may exist on Habitica's side:
// a timeout, a network error or a 5xx (finding 9). Its row keeps the
// leftover mark whatever the delete finds.
func isUnknownOutcome(err error) bool {
	switch habiticaCode(err) {
	case "habitica-unavailable", "habitica-invalid-response":
		return habiticaSent(err)
	}
	return false
}

func isRateLimited(err error) bool { return habiticaCode(err) == "habitica-rate-limited" }

// isNotEnoughGold is the score's own refusal: Habitica's "Not Enough Gold",
// the one 401 that is not a bad token. The habitica package codes it with
// the wire's insufficient-gold (its codes are all wire codes); here it only
// means the row settles `not-enough`.
func isNotEnoughGold(err error) bool { return habiticaCode(err) == "insufficient-gold" }

// isScoreRefusal is a 401 on the score after the same token read the gold
// and created the reward (finding 17): Habitica's "Not Enough Gold" is
// written in the user's language, so the status is what tells it apart from
// a charge. Either way the request was refused, so nothing was charged.
func isScoreRefusal(err error) bool { return habiticaCode(err) == "habitica-auth" }

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

// purseRead (GET /api/purse) is the Glim log (2.1, 2.7, silas-yard.md 1.6):
// the purse, the last 50 top-ups and the last 50 glim lines — every top-up,
// spend, sale, letter and give. It settles stale working rows first (2.4), so a row whose
// worker died reads as what it is.
func (a *Server) purseRead(w http.ResponseWriter, r *http.Request) error {
	tx, s, _, err := a.begin(r)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	now := a.Config.Now().Unix()
	// The lazy settle first (2.4), so this answer carries the version it
	// moved (finding 6); the read below settles nothing new.
	version, err := store.SettleStaleTopUps(r.Context(), tx, s.AccountID, now)
	if err != nil {
		return err
	}
	if version != 0 {
		s.Version = version
	}
	read, err := store.PurseRead(r.Context(), tx, s.AccountID, now, utcDayStart(now))
	if err != nil {
		return err
	}
	return a.finishRead(w, r, tx, s, read)
}
