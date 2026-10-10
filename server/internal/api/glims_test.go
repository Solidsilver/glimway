package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	"glimway/server/internal/store"
)

// Glims between players (docs/design/purse-and-wardrobe.md 3, silas-yard.md
// 1.4 rule 3): a price on a shelf, a letter, or hand to hand. These tests
// start each account at no glims (noGlims) and fund it the way a settled
// top-up does (topUpGlims), or from XP (x.fund's earned share); a seller
// takes glims out of play. Every transfer writes both sides of the ledger in
// one transaction (3.5), and glimsConserved checks that after each kind,
// with the XP-earned share (1.4 rule 4, 1.6).

// noGlims empties accounts' glims, rows and all (the welcome's included),
// so each test counts from zero and the rows still sum to the balance.
func (x *rig) noGlims(ids ...string) {
	x.t.Helper()
	for _, id := range ids {
		if _, err := x.db.DB.Exec("UPDATE balances SET glims=0,xp_glims=0 WHERE account_id=?", id); err != nil {
			x.t.Fatal(err)
		}
		if _, err := x.db.DB.Exec("DELETE FROM ledger WHERE account_id=? AND currency='glims'", id); err != nil {
			x.t.Fatal(err)
		}
	}
}

// topUpGlims credits glims the way a settled top-up does: a `moved`
// purse_topups row of 2n gold and n glims, and its `habitica-topup` credit
// (store.SettleTopUp). The row is dated two days back so it uses up nothing
// of today's two top-ups or 30 glims.
func (x *rig) topUpGlims(id string, n int) {
	x.t.Helper()
	ctx := context.Background()
	tx, err := x.db.DB.Begin()
	if err != nil {
		x.t.Fatal(err)
	}
	defer tx.Rollback()
	x.fundings++
	row, at := fmt.Sprintf("test-topup-%d", x.fundings), x.now.Load()-2*86400
	if err = store.InsertTopUp(ctx, tx, row, id, row, int64(n*store.GoldPerGlim), at); err != nil {
		x.t.Fatal(err)
	}
	t, err := store.TopUpFor(ctx, tx, row)
	if err != nil {
		x.t.Fatal(err)
	}
	if err = store.SettleTopUp(ctx, tx, t, store.TopUpOutcome{State: "moved", SettledBy: "worker"}, at); err != nil {
		x.t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		x.t.Fatal(err)
	}
}

// glims is what one account holds.
func (x *rig) glims(id string) int {
	x.t.Helper()
	return count(x.t, x.db, "SELECT glims FROM balances WHERE account_id=?", id)
}

// glimsConserved is design 3.5 with the XP-earned share (silas-yard.md 1.4,
// 1.6), checked whole-database:
//
//   - per account: the glims rows sum to the balance, and their earned share
//     to xp_glims, which never passes the balance;
//   - the letter escrow (mail:glims:glims) holds exactly the letters still in
//     flight, per sender;
//   - by reason: a shelf's buys and sales cancel, gives and gifts cancel, and
//     the letters' rows cancel with their escrow, so nothing is made or lost
//     between players;
//   - the earned share never moves between players: no row that brings
//     glims from another player is XP-earned (a debit may spend the giver's
//     earned glims; they arrive as ordinary glims);
//   - a seller only ever takes glims out.
func (x *rig) glimsConserved() {
	x.t.Helper()
	balances := queryCounts(x.t, x.db, "SELECT account_id,glims FROM balances")
	earnedBalances := queryCounts(x.t, x.db, "SELECT account_id,xp_glims FROM balances")
	rowsBy := queryCounts(x.t, x.db, "SELECT account_id,COALESCE(SUM(delta),0) FROM ledger WHERE currency='glims' GROUP BY account_id")
	earnedBy := queryCounts(x.t, x.db, "SELECT account_id,COALESCE(SUM(earned_delta),0) FROM ledger WHERE currency='glims' GROUP BY account_id")
	for id, n := range balances {
		if rowsBy[id] != n {
			x.t.Fatalf("%s: glims rows sum to %d, the balance is %d", id, rowsBy[id], n)
		}
		if earnedBy[id] != earnedBalances[id] || earnedBalances[id] < 0 || earnedBalances[id] > n {
			x.t.Fatalf("%s: earned rows sum to %d, xp_glims is %d of %d", id, earnedBy[id], earnedBalances[id], n)
		}
	}
	// The escrow holds exactly the letters in flight — and per sender, so
	// closing it on the wrong account fails here even when the global totals
	// balance (3.3: the sender's lines sum to the same total throughout).
	escrowBy := queryCounts(x.t, x.db, "SELECT account_id,COALESCE(SUM(delta),0) FROM ledger WHERE currency='mail:glims:glims' GROUP BY account_id")
	waitingBy := queryCounts(x.t, x.db, "SELECT from_id,COALESCE(SUM(qty),0) FROM mail WHERE kind='glims' AND claimed_at IS NULL AND returned_at IS NULL GROUP BY from_id")
	escrow := 0
	for id, n := range escrowBy {
		escrow += n
		if waitingBy[id] != n {
			x.t.Fatalf("%s: escrow rows sum to %d, their waiting letters hold %d", id, n, waitingBy[id])
		}
	}
	for id, n := range waitingBy {
		if escrowBy[id] != n {
			x.t.Fatalf("%s: waiting letters hold %d, escrow rows sum to %d", id, n, escrowBy[id])
		}
	}
	for kind, reasons := range map[string]string{
		"shelf":   "'shelf-buy','shelf-sale'",
		"give":    "'give','gift'",
		"letters": "'mail-send','mail-claim','mail-return','mail-recall'",
	} {
		if made := count(x.t, x.db, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE currency IN ('glims','mail:glims:glims') AND reason IN ("+reasons+")"); made != 0 {
			x.t.Fatalf("%s between players made %d glims", kind, made)
		}
	}
	if earned := count(x.t, x.db, "SELECT count(*) FROM ledger WHERE currency='glims' AND delta>0 AND earned_delta!=0 AND reason IN ('shelf-sale','gift','mail-claim','mail-return','mail-recall','habitica-topup','purse-settle')"); earned != 0 {
		x.t.Fatalf("%d rows passed XP-earned glims between players", earned)
	}
	if count(x.t, x.db, "SELECT count(*) FROM ledger WHERE currency='glims' AND reason='market-buy' AND delta>=0") != 0 {
		x.t.Fatal("a market-buy row added glims")
	}
	x.topUpsReconciled()
	x.glimPairsConserved()
}

// topUpsReconciled ties the ledger to purse_topups (review B finding 1): the
// only glims Habitica brings are a `moved` row's own, credited once. Per
// row, its habitica-topup/purse-settle credits sum to its glims when it is
// moved and to nothing otherwise; per account, every such credit names a
// row of that account. A doubled or dropped settle fails here.
func (x *rig) topUpsReconciled() {
	x.t.Helper()
	rows, err := x.db.DB.Query(`SELECT t.id,t.account_id,t.state,t.glims,
		COALESCE((SELECT SUM(l.delta) FROM ledger l WHERE l.currency='glims' AND l.reason IN ('habitica-topup','purse-settle') AND l.ref=t.id AND l.account_id=t.account_id),0)
		FROM purse_topups t`)
	if err != nil {
		x.t.Fatal(err)
	}
	defer rows.Close()
	for rows.Next() {
		var id, account, state string
		var glims, credited int
		if err = rows.Scan(&id, &account, &state, &glims, &credited); err != nil {
			x.t.Fatal(err)
		}
		want := 0
		if state == "moved" {
			want = glims
		}
		if credited != want {
			x.t.Fatalf("top-up %s (%s, %d glims) credited %d", id, state, glims, credited)
		}
	}
	if err = rows.Err(); err != nil {
		x.t.Fatal(err)
	}
	if stray := count(x.t, x.db, "SELECT count(*) FROM ledger l WHERE l.currency='glims' AND l.reason IN ('habitica-topup','purse-settle') AND NOT EXISTS(SELECT 1 FROM purse_topups t WHERE t.id=l.ref AND t.account_id=l.account_id)"); stray != 0 {
		x.t.Fatalf("%d top-up credits name no top-up of their account", stray)
	}
}

// glimPairsConserved is conservation per transfer, not per reason (review B
// finding 1): every shelf trade, give and glim letter is a pair of rows that
// name each other and net to zero, so a credit landing on the wrong account
// fails here even when every reason still sums to zero.
//
//   - shelf: the buyer's shelf-buy names `<stocker>:<item>`, the stocker's
//     shelf-sale names `<buyer>:<item>`, at the same moment, for the same price;
//   - give: the giver's give names the recipient, the recipient's gift names
//     the giver;
//   - a letter: its rows (glims and the sender's mail:glims:glims escrow) net
//     to zero; the send and the escrow are the sender's, a claim's glims go
//     to the recipient, and a return's or recall's back to the sender.
func (x *rig) glimPairsConserved() {
	x.t.Helper()
	type side struct{ out, in, n int }
	pairs := map[string]*side{}
	rows, err := x.db.DB.Query("SELECT account_id,delta,reason,ref,created_at FROM ledger WHERE currency='glims' AND reason IN ('shelf-buy','shelf-sale','give','gift')")
	if err != nil {
		x.t.Fatal(err)
	}
	for rows.Next() {
		var account, reason, ref string
		var delta int
		var at int64
		if err = rows.Scan(&account, &delta, &reason, &ref, &at); err != nil {
			rows.Close()
			x.t.Fatal(err)
		}
		other, item, _ := strings.Cut(ref, ":")
		payer, payee := account, other
		if reason == "shelf-sale" || reason == "gift" {
			payer, payee = other, account
		}
		kind := map[string]string{"shelf-buy": "shelf", "shelf-sale": "shelf", "give": "give", "gift": "give"}[reason]
		key := fmt.Sprintf("%s %s>%s %s @%d", kind, payer, payee, item, at)
		p := pairs[key]
		if p == nil {
			p = &side{}
			pairs[key] = p
		}
		if delta < 0 {
			p.out++
		} else {
			p.in++
		}
		p.n += delta
	}
	rows.Close()
	for key, p := range pairs {
		if p.out != p.in || p.n != 0 {
			x.t.Fatalf("%s: %d out, %d in, net %d", key, p.out, p.in, p.n)
		}
	}
	letters, err := x.db.DB.Query(`SELECT l.ref,l.account_id,l.currency,l.reason,l.delta,m.from_id,m.to_id FROM ledger l JOIN mail m ON m.id=l.ref
		WHERE m.kind='glims' AND l.currency IN ('glims','mail:glims:glims') AND l.reason IN ('mail-send','mail-claim','mail-return','mail-recall')`)
	if err != nil {
		x.t.Fatal(err)
	}
	defer letters.Close()
	net := map[string]int{}
	for letters.Next() {
		var id, account, currency, reason, from, to string
		var delta int
		if err = letters.Scan(&id, &account, &currency, &reason, &delta, &from, &to); err != nil {
			x.t.Fatal(err)
		}
		net[id] += delta
		owner := from
		if currency == "glims" && reason == "mail-claim" {
			owner = to
		}
		if account != owner {
			x.t.Fatalf("letter %s: a %s %s row is on %s, not %s", id, reason, currency, account, owner)
		}
	}
	if err = letters.Err(); err != nil {
		x.t.Fatal(err)
	}
	for id, n := range net {
		if n != 0 {
			x.t.Fatalf("letter %s: its rows net %d", id, n)
		}
	}
}

// queryCounts reads a (string, int) query into a map.
func queryCounts(t *testing.T, db *store.Store, query string) map[string]int {
	t.Helper()
	rows, err := db.DB.Query(query)
	if err != nil {
		t.Fatal(query, err)
	}
	defer rows.Close()
	out := map[string]int{}
	for rows.Next() {
		var k string
		var v int
		if err = rows.Scan(&k, &v); err != nil {
			t.Fatal(query, err)
		}
		out[k] = v
	}
	if err = rows.Err(); err != nil {
		t.Fatal(query, err)
	}
	return out
}

// shelfSetup: alice's gate 0 with its shelf placed, ready to stock.
func (x *rig) shelfSetup(c *http.Cookie, s *response) {
	x.t.Helper()
	x.claimGate(c, s, 0)
	if _, err := x.db.DB.Exec("UPDATE homesteads SET tier=1 WHERE gate=0"); err != nil {
		x.t.Fatal(err)
	}
	shelfItem := x.decoration(x.account("alice"), "gate-shelf")
	x.homeOpRefreshing(c, s, "place", map[string]any{"itemId": shelfItem, "scene": "gate"}, 200)
}

// stockShelf stocks one giveable item on a slot, with an optional glims price.
func (x *rig) stockShelf(c *http.Cookie, s *response, slot int, def string, price int) {
	x.t.Helper()
	x.stack(x.account("alice"), def, x.account("alice"), 1)
	fields := map[string]any{"op": "stock", "gate": 0, "slot": slot, "asset": map[string]any{"kind": "item", "id": def, "qty": 1}}
	if price > 0 {
		fields["price"] = price
	}
	x.shelfOp(c, s, fields, 200)
}

// TestGlimsConservationAcrossEveryTransfer walks every kind of transfer in
// design 3.5's table and checks conservation after each: nothing is made or
// lost between players, and a seller is the only thing that takes glims out.
func TestGlimsConservationAcrossEveryTransfer(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	alice, bob := x.account("alice"), x.account("bob")
	x.noGlims(alice, bob)
	x.topUpGlims(alice, 100)
	x.topUpGlims(bob, 20)
	x.glimsConserved()

	// A shelf buy: the buyer's glims pay whoever stocked the slot (3.2).
	x.shelfSetup(ac, &a)
	x.stockShelf(ac, &a, 0, "comfrey-salve", 12)
	x.shelfOp(bc, &b, map[string]any{"op": "buy", "gate": 0, "slot": 0}, 200)
	if x.glims(alice) != 112 || x.glims(bob) != 8 {
		t.Fatal("shelf buy", x.glims(alice), x.glims(bob))
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND currency='glims' AND reason='shelf-buy' AND ref=?", bob, alice+":comfrey-salve") != 1 ||
		count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND currency='glims' AND reason='shelf-sale' AND ref=?", alice, bob+":comfrey-salve") != 1 {
		t.Fatal("the shelf rows do not name the other player and the item")
	}
	x.glimsConserved()

	// A glim letter: out of the balance into the letter, then to the recipient
	// (3.3) — the sender's lines sum to the same total throughout.
	sent := x.p5("POST", "/api/mail", body(a, "send-claim", map[string]any{"toId": bob, "glims": 20}), ac, 200)
	if x.glims(alice) != 92 || count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND currency='mail:glims:glims' AND reason='mail-send' AND ref=?", alice, sent.Result.MailID) != 1 {
		t.Fatal("the glims did not wait in the letter", x.glims(alice))
	}
	x.glimsConserved()
	x.p5("POST", "/api/mail/"+sent.Result.MailID+"/claim", body(b, "claim", nil), bc, 200)
	if x.glims(bob) != 28 || x.glims(alice) != 92 {
		t.Fatal("the letter was collected", x.glims(alice), x.glims(bob))
	}
	x.glimsConserved()

	// A letter that comes back: the glims is whole again on the sender's side.
	back := x.p5("POST", "/api/mail", body(a, "send-back", map[string]any{"toId": bob, "glims": 30}), ac, 200)
	x.p5("POST", "/api/mail/"+back.Result.MailID+"/recall", body(a, "recall", nil), ac, 200)
	if x.glims(alice) != 92 {
		t.Fatal("a recalled letter", x.glims(alice))
	}
	x.glimsConserved()

	// Glims by hand (3.4): both balances in one transaction.
	x.stand(alice, a.WorldID, "commons", 300, 300)
	x.stand(bob, a.WorldID, "commons", 330, 310)
	x.refresh(bc, &b)
	x.opRefreshing(ac, &a, "give", map[string]any{"toId": bob, "glims": 15}, 200)
	if x.glims(alice) != 77 || x.glims(bob) != 43 {
		t.Fatal("the give", x.glims(alice), x.glims(bob))
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND currency='glims' AND reason='give' AND ref=?", alice, bob) != 1 ||
		count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND currency='glims' AND reason='gift' AND ref=?", bob, alice) != 1 {
		t.Fatal("the give's rows do not name each other")
	}
	x.glimsConserved()

	// A seller is the one sink: the glims leaves play and nothing is credited.
	x.opRefreshing(ac, &a, "buy", map[string]any{"seller": "silas-yard", "good": "timber", "progress": bySeller(a, "silas-yard", x.now.Load())}, 200)
	if x.glims(alice) != 74 {
		t.Fatal("timber from Silas", x.glims(alice))
	}
	x.glimsConserved()
	if total := count(t, x.db, "SELECT COALESCE(SUM(glims),0) FROM balances"); total != 120-3 {
		t.Fatal("glims in play", total)
	}
}

// TestGlimLettersReturnFourWays: recall, expiry, a world move and access
// removal all give a glim letter back (3.3) — one path, store.ReturnMail's
// glims case — and the sender's glims are whole again each time.
func TestGlimLettersReturnFourWays(t *testing.T) {
	returned := func(t *testing.T, x *rig, account, id string) {
		t.Helper()
		if count(t, x.db, "SELECT count(*) FROM mail WHERE id=? AND returned_at IS NOT NULL", id) != 1 {
			t.Fatal("the letter was not returned")
		}
		if count(t, x.db, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE account_id=? AND currency='mail:glims:glims'", account) != 0 {
			t.Fatal("the escrow was not closed")
		}
		x.glimsConserved()
	}

	t.Run("recall", func(t *testing.T) {
		x := newRig(t)
		ac, a := x.ready("alice")
		_, b := x.member("bob", a.WorldID)
		alice := x.account("alice")
		x.noGlims(alice)
		x.topUpGlims(alice, 40)
		sent := x.p5("POST", "/api/mail", body(a, "send", map[string]any{"toId": x.account("bob"), "glims": 25}), ac, 200)
		if x.glims(alice) != 15 {
			t.Fatal("sent", x.glims(alice))
		}
		x.p5("POST", "/api/mail/"+sent.Result.MailID+"/recall", body(a, "recall", nil), ac, 200)
		if x.glims(alice) != 40 {
			t.Fatal("recalled", x.glims(alice))
		}
		_ = b
		returned(t, x, alice, sent.Result.MailID)
	})

	t.Run("expiry", func(t *testing.T) {
		x := newRig(t)
		ac, a := x.ready("alice")
		_, b := x.member("bob", a.WorldID)
		alice := x.account("alice")
		x.noGlims(alice)
		x.topUpGlims(alice, 40)
		sent := x.p5("POST", "/api/mail", body(a, "send", map[string]any{"toId": x.account("bob"), "glims": 25}), ac, 200)
		if _, err := x.db.DB.Exec("UPDATE mail SET sent_at=? WHERE id=?", x.now.Load()-30*86400, sent.Result.MailID); err != nil {
			t.Fatal(err)
		}
		x.p5("GET", "/api/mail", nil, ac, 200) // the request sweeps what is due
		if x.glims(alice) != 40 || count(t, x.db, "SELECT count(*) FROM mail WHERE id=? AND return_reason='expired'", sent.Result.MailID) != 1 {
			t.Fatal("expired", x.glims(alice))
		}
		_ = b
		returned(t, x, alice, sent.Result.MailID)
	})

	t.Run("access-removal", func(t *testing.T) {
		x := newRig(t)
		ac, a := x.ready("alice")
		_, b := x.member("bob", a.WorldID)
		alice := x.account("alice")
		x.noGlims(alice)
		x.topUpGlims(alice, 40)
		sent := x.p5("POST", "/api/mail", body(a, "send", map[string]any{"toId": x.account("bob"), "glims": 25}), ac, 200)
		if err := x.db.Allow(context.Background(), "bob", false, x.now.Load()); err != nil {
			t.Fatal(err)
		}
		if x.glims(alice) != 40 {
			t.Fatal("access removed", x.glims(alice))
		}
		_ = b
		returned(t, x, alice, sent.Result.MailID)
	})

	t.Run("world-move", func(t *testing.T) {
		x := newRig(t)
		x.hero("olive", "Olive", "p1")
		oc, o := x.ready("olive")
		pw := o.WorldID
		olive := x.account("olive")
		x.noGlims(olive)
		x.topUpGlims(olive, 40)
		// Hal has a world of his own and moves into the party's world to
		// receive the letter; his move back is a world move (relocate).
		x.hero("hal", "Hal", "")
		_, h := x.ready("hal")
		home := h.WorldID
		x.hero("hal", "Hal", "p1")
		hc, h := x.again("hal")
		h.Snapshot = x.worldReq("POST", "/api/world/move", moveBody(h, "in", pw, "village"), hc, 200).Snapshot
		sent := x.p5("POST", "/api/mail", body(o, "send", map[string]any{"toId": x.account("hal"), "glims": 25}), oc, 200)
		if x.glims(olive) != 15 {
			t.Fatal("sent", x.glims(olive))
		}
		x.now.Add(MoveCooldown)
		x.worldReq("POST", "/api/world/move", moveBody(h, "out", home, "village"), hc, 200)
		if x.glims(olive) != 40 || x.worldOf("hal") != home {
			t.Fatal("moved away", x.glims(olive))
		}
		returned(t, x, olive, sent.Result.MailID)
	})
}

// TestGlimsGiveMovesBothBalancesAndRefusesWhenApart: the same give checks as for
// items (3.4) — same world, allowed in, together — with both balances in one
// transaction, the recipient's version moved, and the presence notice.
func TestGlimsGiveMovesBothBalancesAndRefusesWhenApart(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	oc, o := x.ready("outsider")
	_, _ = oc, o
	alice, bob := x.account("alice"), x.account("bob")
	x.noGlims(alice, bob)
	x.topUpGlims(alice, 50)

	// Not together: nothing moves.
	if x.opRefreshing(ac, &a, "give", map[string]any{"toId": bob, "glims": 15}, 409).Error.Code != "not-together" {
		t.Fatal("gave across the map")
	}
	if x.glims(alice) != 50 || x.glims(bob) != 0 {
		t.Fatal("a refused give moved glims", x.glims(alice), x.glims(bob))
	}
	x.glimsConserved()

	// Together: both balances move in one transaction and the recipient hears
	// it (PresenceGift, kind "glims").
	x.stand(alice, a.WorldID, "commons", 300, 300)
	x.stand(bob, a.WorldID, "commons", 330, 310)
	x.refresh(bc, &b)
	bobRev := b.Version
	gift := x.opRefreshing(ac, &a, "give", map[string]any{"toId": bob, "glims": 15}, 200)
	if gift.Result.GlimsGiven != 15 || gift.Result.Given == nil || gift.Result.Given.Kind != "glims" || gift.Result.Given.Qty != 15 {
		t.Fatal("the give's answer", gift.Result)
	}
	if x.glims(alice) != 35 || x.glims(bob) != 15 {
		t.Fatal("the give", x.glims(alice), x.glims(bob))
	}
	x.refresh(bc, &b)
	if b.Version <= bobRev {
		t.Fatal("the recipient's version did not move")
	}
	h := x.api.presence
	h.mu.Lock()
	friend := h.peers[bob]
	h.mu.Unlock()
	select {
	case raw := <-friend.queue:
		m, err := decodePresence(raw)
		if err != nil || m.GetGift() == nil || m.GetGift().GetKind() != "glims" || m.GetGift().GetItemDef() != "glims" || m.GetGift().GetQty() != 15 {
			t.Fatal("the notice", m, err)
		}
	default:
		t.Fatal("the recipient heard nothing")
	}
	x.glimsConserved()

	// Self-gifts, other worlds, short balances and mixed shapes are refused.
	x.opRefreshing(ac, &a, "give", map[string]any{"toId": alice, "glims": 1}, 400)
	x.opRefreshing(ac, &a, "give", map[string]any{"toId": x.account("outsider"), "glims": 1}, 403)
	if x.opRefreshing(ac, &a, "give", map[string]any{"toId": bob, "glims": 100}, 409).Error.Code != "insufficient-glims" {
		t.Fatal("gave glims that isn't there")
	}
	if x.opRefreshing(ac, &a, "give", map[string]any{"toId": bob, "glims": 5, "asset": map[string]any{"kind": "item", "id": "lamp-wick", "qty": 1}}, 400).Error.Code != "invalid-request" {
		t.Fatal("a give of both")
	}
	if x.opRefreshing(ac, &a, "give", map[string]any{"toId": bob}, 400).Error.Code != "invalid-request" {
		t.Fatal("a give of neither")
	}
	x.glimsConserved()
}

// TestShelfPricesBuyAndOwnStock (3.2): a price on a slot is paid to whoever
// stocked it, a bought slot is not a gift (no free take used), your own
// stock is refused, and a free slot keeps the take.
func TestShelfPricesBuyAndOwnStock(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	alice, bob := x.account("alice"), x.account("bob")
	x.noGlims(alice, bob)
	x.topUpGlims(alice, 100)
	x.topUpGlims(bob, 30)
	x.shelfSetup(ac, &a)

	// Prices are 0 to 9,999.
	if x.shelfOp(ac, &a, map[string]any{"op": "stock", "gate": 0, "slot": 0, "price": 10000, "asset": map[string]any{"kind": "item", "id": "comfrey-salve", "qty": 1}}, 400).Error.Code != "invalid-quantity" {
		t.Fatal("a price out of range")
	}
	x.stockShelf(ac, &a, 0, "comfrey-salve", 12)
	if slot := x.getShelf(bc, 0, 200).Shelf.Slots[0]; slot.Price != 12 || slot.ItemDef != "comfrey-salve" {
		t.Fatal("the slot does not show its price", slot)
	}

	// A free Take never costs anything: a priced slot is bought, not taken.
	if x.shelfOp(bc, &b, map[string]any{"op": "take", "gate": 0, "slot": 0}, 409).Error.Code != "invalid-operation" {
		t.Fatal("took a priced slot")
	}
	// And you can't buy your own stock.
	if x.shelfOp(ac, &a, map[string]any{"op": "buy", "gate": 0, "slot": 0}, 409).Error.Code != "own-stock" {
		t.Fatal("bought one's own stock")
	}
	// An unpriced slot is a gift: it keeps the take and is not for sale.
	x.stockShelf(ac, &a, 1, "comfrey-salve", 0)
	if x.shelfOp(bc, &b, map[string]any{"op": "buy", "gate": 0, "slot": 1}, 409).Error.Code != "invalid-operation" {
		t.Fatal("bought a free gift")
	}

	// A traveller buys the priced one: the buyer's glims pay the stocker, both rows
	// in one transaction.
	bought := x.shelfOp(bc, &b, map[string]any{"op": "buy", "gate": 0, "slot": 0}, 200)
	if bought.Result.Taken == nil || bought.Result.Taken.Id != "comfrey-salve" || bought.Result.Line == "" {
		t.Fatal("bought", bought.Result)
	}
	if x.glims(alice) != 112 || x.glims(bob) != 18 {
		t.Fatal("the sale", x.glims(alice), x.glims(bob))
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND reason='shelf-buy' AND ref=?", bob, alice+":comfrey-salve") != 1 ||
		count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND reason='shelf-sale' AND ref=?", alice, bob+":comfrey-salve") != 1 {
		t.Fatal("the sale's rows")
	}
	x.glimsConserved()

	// A bought slot is not a gift: bob's one free take is still his.
	x.shelfOp(bc, &b, map[string]any{"op": "take", "gate": 0, "slot": 1}, 200)
	x.glimsConserved()
}

// TestSilasYardBundlesBuyWithGlims (silas-yard.md 1.6): every good has one
// price, in glims; Silas's bundles are capped at three a day; `pay` is no
// longer part of a buy; and short of glims is insufficient-glims.
func TestSilasYardBundlesBuyWithGlims(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.noGlims(s.AccountID)
	x.topUpGlims(s.AccountID, 10)
	buy := func(seller, good string, status int) itemsResponse {
		return x.opRefreshing(c, &s, "buy", map[string]any{"seller": seller, "good": good, "progress": bySeller(s, seller, x.now.Load())}, status)
	}
	// Hazel's tallow: its one price, 1 glim.
	r := buy("hazels-kitchen", "tallow", 200)
	if r.Result.Bought == nil || r.Result.Bought.Glims != 1 {
		t.Fatal("tallow", r.Result.Bought)
	}
	if x.glims(s.AccountID) != 9 {
		t.Fatal("tallow's price", x.glims(s.AccountID))
	}
	x.glimsConserved()

	// Silas's bundles: timber ×4 for 3 glims, three a day.
	if r = buy("silas-yard", "timber", 200); stackQty(r.Result.Items, "timber") != 4 || r.Result.Bought == nil || r.Result.Bought.Glims != 3 {
		t.Fatal("timber", r.Result)
	}
	if x.glims(s.AccountID) != 6 {
		t.Fatal("the balance", x.glims(s.AccountID))
	}
	x.glimsConserved()
	buy("silas-yard", "timber", 200)
	buy("silas-yard", "timber", 200)
	if buy("silas-yard", "timber", 409).Error.Code != "sold-out" {
		t.Fatal("the day's cap")
	}
	// pay left the request (reserved 20): a buy that names it is refused.
	if status, _, code, _ := x.request("POST", "/api/items/buy", map[string]any{"op": map[string]any{"key": "pay-gold", "basis": s.Version}, "where": map[string]any{"area": s.State.Area, "x": s.State.Position.X, "y": s.State.Position.Y}, "seller": "silas-yard", "good": "stone", "pay": "gold"}, c); status != 400 || code != "invalid-json" {
		t.Fatal("a buy that names pay", status, code)
	}
	if buy("silas-yard", "stone", 409).Error.Code != "insufficient-glims" {
		t.Fatal("spent glims that aren't there")
	}
	x.glimsConserved()
}

// A glim letter carries glims and nothing else (question 11): both, or
// neither, is invalid-request; an amount is at least 1; and a balance that
// can't cover it is insufficient-glims (3.3).
func TestGlimLettersRefuseBadShapes(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	_, b := x.member("bob", a.WorldID)
	alice := x.account("alice")
	to := x.account("bob")
	x.noGlims(alice)
	x.topUpGlims(alice, 10)
	if x.p5("POST", "/api/mail", body(a, "both", map[string]any{"toId": to, "glims": 5, "asset": map[string]any{"kind": "item", "id": "lamp-wick", "qty": 1}}), ac, 400).Error.Code != "invalid-request" {
		t.Fatal("a letter of both")
	}
	if x.p5("POST", "/api/mail", body(a, "neither", map[string]any{"toId": to}), ac, 400).Error.Code != "invalid-request" {
		t.Fatal("a letter of neither")
	}
	if x.p5("POST", "/api/mail", body(a, "negative", map[string]any{"toId": to, "glims": -5}), ac, 400).Error.Code != "invalid-quantity" {
		t.Fatal("a letter of negative glims")
	}
	if x.p5("POST", "/api/mail", body(a, "short", map[string]any{"toId": to, "glims": 11}), ac, 409).Error.Code != "insufficient-glims" {
		t.Fatal("a letter of glims that isn't there")
	}
	if x.glims(alice) != 10 {
		t.Fatal("a refused letter moved glims", x.glims(alice))
	}
	_ = b
	x.glimsConserved()
}

// TestForgedProfileLeavesThePurseAndGearUntouched (4.3): /api/profile maps a
// browser's user object, and nothing in it may feed the purse or the owned
// gear list — only the server's own reads of Habitica fill those. A report
// carrying `gp` and `items.gear.owned` has nowhere to put them: the server's
// proto has no such fields, and the strict decoder refuses the whole report,
// which is stronger than the design's "ignored". Gear claims in the fields a
// report does have (equipped, costume) are accepted — the avatar has always
// drawn them — and still own nothing.
func TestForgedProfileLeavesThePurseAndGearUntouched(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	alice := x.account("alice")
	x.noGlims(alice)
	x.topUpGlims(alice, 50)
	x.ownGear(alice, "head_warrior_1")

	report := func(mutate func(map[string]any)) map[string]any {
		t.Helper()
		b := x.profileBody(s, profile("alice", 4, 90, 20), s.State)
		var raw map[string]any
		if err := json.Unmarshal(b["raw"].(json.RawMessage), &raw); err != nil {
			t.Fatal(err)
		}
		mutate(raw)
		forged, err := json.Marshal(raw)
		if err != nil {
			t.Fatal(err)
		}
		b["raw"] = json.RawMessage(forged)
		return b
	}

	forged := report(func(raw map[string]any) {
		raw["stats"].(map[string]any)["gp"] = 999999
		raw["items"].(map[string]any)["gear"].(map[string]any)["owned"] = map[string]any{"head_armoire_admiralsBicorne": true}
	})
	if status, _, code, _ := x.request("POST", "/api/profile", forged, c); status != 400 || code != "invalid-json" {
		t.Fatal("a forged report was taken", status, code)
	}
	claims := report(func(raw map[string]any) {
		gear := raw["items"].(map[string]any)["gear"].(map[string]any)
		gear["equipped"] = map[string]any{"head": "head_armoire_admiralsBicorne"}
		gear["costume"] = map[string]any{"weapon": "weapon_armoire_arcaneScroll"}
	})
	x.expect("POST", "/api/profile", claims, c, 200)

	// The report may credit glims from XP (its sync row); nothing else, and
	// the top-up's 50 stand alone.
	var reasons []string
	rows, err := x.db.DB.Query("SELECT DISTINCT reason FROM ledger WHERE account_id=? AND currency='glims'", alice)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var r string
		if err = rows.Scan(&r); err != nil {
			t.Fatal(err)
		}
		reasons = append(reasons, r)
	}
	rows.Close()
	for _, r := range reasons {
		if r != "habitica-topup" && r != "sync" && r != "welcome" {
			t.Fatal("a forged report fed glims:", reasons)
		}
	}
	if x.glimsBalance(alice) != 50 {
		t.Fatal("a forged report fed the purse", x.glimsBalance(alice))
	}
	if count(t, x.db, "SELECT count(*) FROM player_gear WHERE account_id=?", alice) != 1 ||
		count(t, x.db, "SELECT count(*) FROM player_gear WHERE account_id=? AND owned_json=?", alice, store.JSON([]string{"head_warrior_1"})) != 1 {
		t.Fatal("a forged report changed the owned list")
	}
	// And the forged piece is not the player's to wear.
	if _, code := x.chooseWardrobe(c, s, "forged", map[string]string{"head": "head_armoire_admiralsBicorne"}, 409); code != "gear-not-owned" {
		t.Fatal("a forged report owned gear", code)
	}
	x.glimsConserved()
}

// TestGlimsEarnedShareNeverMovesBetweenPlayers (silas-yard.md 1.4 rule 4):
// glims from XP are the only earned ones. A player whose glims are all
// XP-earned can give them, send them and be paid in them, but they arrive
// as ordinary glims — so the friend at 0 HP still can't rest on them.
func TestGlimsEarnedShareNeverMovesBetweenPlayers(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	alice, bob := x.account("alice"), x.account("bob")
	x.noGlims(alice, bob)
	x.fund(alice, 40, 40)
	x.glimsConserved()
	earned := func(id string) int {
		return count(t, x.db, "SELECT xp_glims FROM balances WHERE account_id=?", id)
	}

	// By hand: alice has nothing but earned glims, so the give spends them;
	// bob gets ordinary ones.
	x.stand(alice, a.WorldID, "commons", 300, 300)
	x.stand(bob, a.WorldID, "commons", 330, 310)
	x.refresh(bc, &b)
	x.opRefreshing(ac, &a, "give", map[string]any{"toId": bob, "glims": 15}, 200)
	if x.glims(alice) != 25 || earned(alice) != 25 || x.glims(bob) != 15 || earned(bob) != 0 {
		t.Fatal("the give", x.glims(alice), earned(alice), x.glims(bob), earned(bob))
	}
	x.glimsConserved()

	// By letter, collected.
	sent := x.p5("POST", "/api/mail", body(a, "earned-letter", map[string]any{"toId": bob, "glims": 10}), ac, 200)
	x.p5("POST", "/api/mail/"+sent.Result.MailID+"/claim", body(b, "claim", nil), bc, 200)
	if x.glims(alice) != 15 || earned(alice) != 15 || x.glims(bob) != 25 || earned(bob) != 0 {
		t.Fatal("the letter", x.glims(alice), earned(alice), x.glims(bob), earned(bob))
	}
	x.glimsConserved()

	// A letter that comes back: the glims come home ordinary too — the
	// earned share they left as stays spent.
	back := x.p5("POST", "/api/mail", body(a, "earned-back", map[string]any{"toId": bob, "glims": 5}), ac, 200)
	x.p5("POST", "/api/mail/"+back.Result.MailID+"/recall", body(a, "recall", nil), ac, 200)
	if x.glims(alice) != 15 || earned(alice) != 10 {
		t.Fatal("the recall", x.glims(alice), earned(alice))
	}
	x.glimsConserved()

	// By shelf: bob pays alice, and alice's sale is not earned either.
	x.shelfSetup(ac, &a)
	x.stockShelf(ac, &a, 0, "comfrey-salve", 6)
	x.shelfOp(bc, &b, map[string]any{"op": "buy", "gate": 0, "slot": 0}, 200)
	if x.glims(alice) != 21 || earned(alice) != 10 || x.glims(bob) != 19 || earned(bob) != 0 {
		t.Fatal("the shelf", x.glims(alice), earned(alice), x.glims(bob), earned(bob))
	}
	x.glimsConserved()

	// Bob at 0 HP: 19 glims, none from XP, and the rest is refused.
	x.refresh(bc, &b)
	lease := b.Lease
	b = x.expect("POST", "/api/profile", x.profileBody(b, profile("bob", 1, 0, 20), b.State), bc, 200)
	b.Lease = lease
	b = x.reportState(bc, b, 0, 0, testWhere(b.State))
	if _, _, code, _ := x.request("POST", "/api/spend", spendBody(b, "rest", "", "passed-rest", b.State), bc); code != "needs-earned" {
		t.Fatal("rested on glims a friend passed over:", code)
	}
	x.glimsConserved()
}

// TestTopUpCapThirtyGlimsADay (silas-yard.md 1.5): at most 30 glims a UTC
// day from top-ups, across at most two. Reserve refuses `top-up-cap` when
// today's glims plus this one would pass 30, counting moved and unconfirmed
// rows; the purse says how many glims are left (Purse.glims_left).
func TestTopUpCapThirtyGlimsADay(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.setGold(1000)
	if read := x.purseRead(c); read.Purse.GlimsLeft != 30 || read.Purse.TopUpsLeft != 2 {
		t.Fatalf("a new day %+v", read.Purse)
	}
	refused := func(key string, gold int, want string) {
		t.Helper()
		status, out := x.topUp(s.Lease, key, gold, secret, c)
		if status/100 != 4 || out.Error == nil || out.Error.Code != want {
			t.Fatalf("%d gold: %d %+v, want %s", gold, status, out.Error, want)
		}
	}
	// 31 glims at once is past the cap, and nothing is called upstream.
	calls := len(x.habiticaCalls())
	refused("too-many", 62, "top-up-cap")
	if len(x.habiticaCalls()) != calls {
		t.Fatal("a capped top-up called Habitica")
	}
	// An unconfirmed top-up counts toward the cap as it counts toward the
	// day (its glims may have moved).
	x.setScore("timeout-partial")
	x.setPurseChecks([]time.Duration{time.Millisecond, 2 * time.Millisecond})
	if row := x.topUpOK(s, "unsure", 40, c); row.State != "unconfirmed" || row.Glims != 20 {
		t.Fatalf("%+v", row)
	}
	if read := x.purseRead(c); read.Purse.GlimsLeft != 10 || read.Purse.TopUpsLeft != 1 {
		t.Fatalf("after 20 unconfirmed %+v", read.Purse)
	}
	x.setScore("ok")
	refused("eleven", 22, "top-up-cap")
	if row := x.topUpOK(s, "ten", 20, c); row.State != "moved" || row.Glims != 10 {
		t.Fatalf("%+v", row)
	}
	if read := x.purseRead(c); read.Purse.GlimsLeft != 0 || read.Purse.TopUpsLeft != 0 {
		t.Fatalf("the day's 30 %+v", read.Purse)
	}
	if x.glimsBalance(x.account("alice")) != 10 {
		t.Fatal("only the moved top-up credits", x.glimsBalance(x.account("alice")))
	}
	// A new UTC day starts the cap again.
	x.now.Store(x.now.Load() + 86400)
	if read := x.purseRead(c); read.Purse.GlimsLeft != 30 || read.Purse.TopUpsLeft != 2 {
		t.Fatalf("the next day %+v", read.Purse)
	}
	// Two top-ups of 10 leave 10 glims a top-up could bring, but no top-up
	// to bring them: glims_left is 0 (the Max fills nothing).
	x.topUpOK(s, "next-1", 20, c)
	x.topUpOK(s, "next-2", 20, c)
	if read := x.purseRead(c); read.Purse.GlimsLeft != 0 || read.Purse.TopUpsLeft != 0 {
		t.Fatalf("two top-ups, no more %+v", read.Purse)
	}
	x.glimsConserved()
}

// TestGlimLogShowsTopUpsSpendsAndTransfers (silas-yard.md 1.6): the Glim
// log is every top-up, spend, sale, letter and give, plus 0.6.1's one
// currency-merge row; glims earned from XP, the welcome and quest rewards,
// and the zero marks are not in it.
func TestGlimLogShowsTopUpsSpendsAndTransfers(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("alice")
	alice := x.account("alice")
	now := x.now.Load()
	rows := []struct {
		delta       int
		reason, ref string
	}{
		{6, "currency-merge", "gold:13"},
		{4, "sync", "xp"},
		{5, "welcome", "first-sync"},
		{0, "world-move", "a>b"},
		{3, "quest", "quest-gift:x"},
		{10, "habitica-topup", "top-1"},
		{-2, "spend", "rest:"},
		{-3, "mend", "bench-axe"},
		{-8, "homestead-buy", "stool"},
		{-1, "market-buy", "hazels-kitchen:tallow"},
	}
	for i, row := range rows {
		if _, err := x.db.DB.Exec("INSERT INTO ledger(account_id,currency,delta,earned_delta,reason,ref,created_at) VALUES(?,'glims',?,0,?,?,?)", alice, row.delta, row.reason, row.ref, now+int64(i)); err != nil {
			t.Fatal(err)
		}
	}
	read := x.purseRead(c)
	got := map[string]purseLineWire{}
	for _, line := range read.Lines {
		got[line.Reason] = line
	}
	for _, reason := range []string{"currency-merge", "habitica-topup", "spend", "mend", "homestead-buy", "market-buy"} {
		if _, ok := got[reason]; !ok {
			t.Fatalf("the log has no %s line: %+v", reason, read.Lines)
		}
	}
	for _, reason := range []string{"sync", "welcome", "world-move", "quest", "test-funding"} {
		if _, ok := got[reason]; ok {
			t.Fatalf("the log shows a %s line", reason)
		}
	}
	if merge := got["currency-merge"]; merge.Delta != 6 || merge.Qty != 13 {
		t.Fatalf("the turn-in names its gold %+v", merge)
	}
	if got["mend"].ItemDef != "bench-axe" || got["homestead-buy"].ItemDef != "stool" {
		t.Fatalf("spends name their item %+v %+v", got["mend"], got["homestead-buy"])
	}
	// Newest first.
	if read.Lines[0].Reason != "market-buy" {
		t.Fatalf("order %+v", read.Lines)
	}
}
