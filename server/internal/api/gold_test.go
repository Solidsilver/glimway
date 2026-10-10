package api

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"glimway/content"
	"glimway/server/internal/store"
)

// The gold between players (docs/design/purse-and-wardrobe.md 3): a price on
// a shelf, a letter, or hand to hand. Gold enters a purse only through a
// top-up (lane B settles those; fundGold below stands in for one) and leaves
// play only at a seller's. Every transfer writes both sides of the ledger in
// one transaction (3.5), and goldConserved checks that after each kind.

// fundGold credits a purse the way a settled top-up does (lane B's
// `habitica-topup`): in these tests it is the only way gold enters.
func (x *rig) fundGold(id string, n int) {
	x.t.Helper()
	ctx := context.Background()
	tx, err := x.db.DB.Begin()
	if err != nil {
		x.t.Fatal(err)
	}
	defer tx.Rollback()
	if err = store.CreditGold(ctx, tx, id, n, "habitica-topup", "test-topup", x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		x.t.Fatal(err)
	}
}

// gold is what one purse holds.
func (x *rig) gold(id string) int {
	x.t.Helper()
	return count(x.t, x.db, "SELECT gold FROM balances WHERE account_id=?", id)
}

// goldConserved is design 3.5, checked whole-database: each account's gold
// rows sum to its purse; the gold in play is only what top-ups put in minus
// what sellers took out; and the letter escrow (mail:gold:gold) holds exactly
// the letters still in flight, so nothing is stranded anywhere.
func (x *rig) goldConserved() {
	x.t.Helper()
	rows, err := x.db.DB.Query("SELECT account_id,gold FROM balances")
	if err != nil {
		x.t.Fatal(err)
	}
	type purse struct {
		id   string
		gold int
	}
	purses := []purse{}
	for rows.Next() {
		var p purse
		if err = rows.Scan(&p.id, &p.gold); err != nil {
			rows.Close()
			x.t.Fatal(err)
		}
		purses = append(purses, p)
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		x.t.Fatal(err)
	}
	total := 0
	for _, p := range purses {
		total += p.gold
		if rows := count(x.t, x.db, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE account_id=? AND currency='gold'", p.id); rows != p.gold {
			x.t.Fatalf("%s: gold rows sum to %d, purse holds %d", p.id, rows, p.gold)
		}
	}
	// The escrow holds exactly the letters in flight — and per sender, so
	// closing it on the wrong account fails here even when the global totals
	// balance (3.3: the sender's lines sum to the same total throughout).
	escrowBy := map[string]int{}
	waitingBy := map[string]int{}
	for _, q := range []struct {
		sql string
		to  map[string]int
	}{
		{"SELECT account_id,COALESCE(SUM(delta),0) FROM ledger WHERE currency='mail:gold:gold' GROUP BY account_id", escrowBy},
		{"SELECT from_id,COALESCE(SUM(qty),0) FROM mail WHERE kind='gold' AND claimed_at IS NULL AND returned_at IS NULL GROUP BY from_id", waitingBy},
	} {
		rows, err := x.db.DB.Query(q.sql)
		if err != nil {
			x.t.Fatal(err)
		}
		for rows.Next() {
			var id string
			var n int
			if err = rows.Scan(&id, &n); err != nil {
				rows.Close()
				x.t.Fatal(err)
			}
			q.to[id] = n
		}
		rows.Close()
		if err = rows.Err(); err != nil {
			x.t.Fatal(err)
		}
	}
	escrow, waiting := 0, 0
	for id, n := range escrowBy {
		escrow += n
		if waitingBy[id] != n {
			x.t.Fatalf("%s: escrow rows sum to %d, their waiting letters hold %d", id, n, waitingBy[id])
		}
	}
	for id, n := range waitingBy {
		waiting += n
		if escrowBy[id] != n {
			x.t.Fatalf("%s: waiting letters hold %d, escrow rows sum to %d", id, n, escrowBy[id])
		}
	}
	if escrow != waiting {
		x.t.Fatalf("escrow holds %d, waiting letters hold %d", escrow, waiting)
	}
	// Every gold row's reason is one of PurseLine.reason's eleven words
	// (proto/glimway/v1/purse.proto; lane B's purse read maps them), and a
	// market-buy row is the game's one sink: negative, never positive.
	known := map[string]bool{
		"habitica-topup": true, "purse-settle": true, "market-buy": true,
		"shelf-buy": true, "shelf-sale": true, "mail-send": true, "mail-claim": true,
		"mail-return": true, "mail-recall": true, "give": true, "gift": true,
	}
	rows, err = x.db.DB.Query("SELECT DISTINCT reason FROM ledger WHERE currency='gold'")
	if err != nil {
		x.t.Fatal(err)
	}
	for rows.Next() {
		var reason string
		if err = rows.Scan(&reason); err != nil {
			rows.Close()
			x.t.Fatal(err)
		}
		if !known[reason] {
			rows.Close()
			x.t.Fatalf("gold moved with reason %q, which no purse line reads", reason)
		}
	}
	rows.Close()
	if err = rows.Err(); err != nil {
		x.t.Fatal(err)
	}
	if count(x.t, x.db, "SELECT count(*) FROM ledger WHERE currency='gold' AND reason='market-buy' AND delta>=0") != 0 {
		x.t.Fatal("a market-buy row added gold")
	}
	// Only top-ups and owner settlements put gold in play (3.5); only the
	// sellers take it out.
	sources := count(x.t, x.db, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE currency='gold' AND reason IN ('habitica-topup','purse-settle')")
	sellers := count(x.t, x.db, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE currency='gold' AND reason='market-buy'")
	if total+escrow != sources+sellers {
		x.t.Fatalf("gold in play %d plus %d in letters, sources %d, sellers %d", total, escrow, sources, sellers)
	}
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

// stockShelf stocks one giveable item on a slot, with an optional gold price.
func (x *rig) stockShelf(c *http.Cookie, s *response, slot int, def string, price int) {
	x.t.Helper()
	x.stack(x.account("alice"), def, x.account("alice"), 1)
	fields := map[string]any{"op": "stock", "gate": 0, "slot": slot, "asset": map[string]any{"kind": "item", "id": def, "qty": 1}}
	if price > 0 {
		fields["price"] = price
	}
	x.shelfOp(c, s, fields, 200)
}

// TestGoldConservationAcrossEveryTransfer walks every kind of transfer in
// design 3.5's table and checks conservation after each: nothing is made or
// lost between players, and a seller is the only thing that takes gold out.
func TestGoldConservationAcrossEveryTransfer(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	alice, bob := x.account("alice"), x.account("bob")
	x.fundGold(alice, 100)
	x.fundGold(bob, 20)
	x.goldConserved()

	// A shelf buy: the buyer's purse pays whoever stocked the slot (3.2).
	x.shelfSetup(ac, &a)
	x.stockShelf(ac, &a, 0, "comfrey-salve", 12)
	x.shelfOp(bc, &b, map[string]any{"op": "buy", "gate": 0, "slot": 0}, 200)
	if x.gold(alice) != 112 || x.gold(bob) != 8 {
		t.Fatal("shelf buy", x.gold(alice), x.gold(bob))
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND currency='gold' AND reason='shelf-buy' AND ref=?", bob, alice+":comfrey-salve") != 1 ||
		count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND currency='gold' AND reason='shelf-sale' AND ref=?", alice, bob+":comfrey-salve") != 1 {
		t.Fatal("the shelf rows do not name the other player and the item")
	}
	x.goldConserved()

	// A gold letter: out of the purse into the letter, then to the recipient
	// (3.3) — the sender's lines sum to the same total throughout.
	sent := x.p5("POST", "/api/mail", body(a, "send-claim", map[string]any{"toId": bob, "gold": 20}), ac, 200)
	if x.gold(alice) != 92 || count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND currency='mail:gold:gold' AND reason='mail-send' AND ref=?", alice, sent.Result.MailID) != 1 {
		t.Fatal("the gold did not wait in the letter", x.gold(alice))
	}
	x.goldConserved()
	x.p5("POST", "/api/mail/"+sent.Result.MailID+"/claim", body(b, "claim", nil), bc, 200)
	if x.gold(bob) != 28 || x.gold(alice) != 92 {
		t.Fatal("the letter was collected", x.gold(alice), x.gold(bob))
	}
	x.goldConserved()

	// A letter that comes back: the gold is whole again on the sender's side.
	back := x.p5("POST", "/api/mail", body(a, "send-back", map[string]any{"toId": bob, "gold": 30}), ac, 200)
	x.p5("POST", "/api/mail/"+back.Result.MailID+"/recall", body(a, "recall", nil), ac, 200)
	if x.gold(alice) != 92 {
		t.Fatal("a recalled letter", x.gold(alice))
	}
	x.goldConserved()

	// Gold by hand (3.4): both purses in one transaction.
	x.stand(alice, a.WorldID, "commons", 300, 300)
	x.stand(bob, a.WorldID, "commons", 330, 310)
	x.refresh(bc, &b)
	x.opRefreshing(ac, &a, "give", map[string]any{"toId": bob, "gold": 15}, 200)
	if x.gold(alice) != 77 || x.gold(bob) != 43 {
		t.Fatal("the give", x.gold(alice), x.gold(bob))
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND currency='gold' AND reason='give' AND ref=?", alice, bob) != 1 ||
		count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND currency='gold' AND reason='gift' AND ref=?", bob, alice) != 1 {
		t.Fatal("the give's rows do not name each other")
	}
	x.goldConserved()

	// A seller is the one sink: the gold leaves play and nothing is credited.
	x.opRefreshing(ac, &a, "buy", map[string]any{"seller": "silas-yard", "good": "timber", "pay": "gold", "progress": bySeller(a, "silas-yard", x.now.Load())}, 200)
	if x.gold(alice) != 71 {
		t.Fatal("timber from Silas", x.gold(alice))
	}
	x.goldConserved()
	if total := count(t, x.db, "SELECT COALESCE(SUM(gold),0) FROM balances"); total != 120-6 {
		t.Fatal("gold in play", total)
	}
}

// TestGoldLettersReturnFourWays: recall, expiry, a world move and access
// removal all give a gold letter back (3.3) — one path, store.ReturnMail's
// gold case — and the sender's purse is whole again each time.
func TestGoldLettersReturnFourWays(t *testing.T) {
	returned := func(t *testing.T, x *rig, account, id string) {
		t.Helper()
		if count(t, x.db, "SELECT count(*) FROM mail WHERE id=? AND returned_at IS NOT NULL", id) != 1 {
			t.Fatal("the letter was not returned")
		}
		if count(t, x.db, "SELECT COALESCE(SUM(delta),0) FROM ledger WHERE account_id=? AND currency='mail:gold:gold'", account) != 0 {
			t.Fatal("the escrow was not closed")
		}
		x.goldConserved()
	}

	t.Run("recall", func(t *testing.T) {
		x := newRig(t)
		ac, a := x.ready("alice")
		_, b := x.member("bob", a.WorldID)
		alice := x.account("alice")
		x.fundGold(alice, 40)
		sent := x.p5("POST", "/api/mail", body(a, "send", map[string]any{"toId": x.account("bob"), "gold": 25}), ac, 200)
		if x.gold(alice) != 15 {
			t.Fatal("sent", x.gold(alice))
		}
		x.p5("POST", "/api/mail/"+sent.Result.MailID+"/recall", body(a, "recall", nil), ac, 200)
		if x.gold(alice) != 40 {
			t.Fatal("recalled", x.gold(alice))
		}
		_ = b
		returned(t, x, alice, sent.Result.MailID)
	})

	t.Run("expiry", func(t *testing.T) {
		x := newRig(t)
		ac, a := x.ready("alice")
		_, b := x.member("bob", a.WorldID)
		alice := x.account("alice")
		x.fundGold(alice, 40)
		sent := x.p5("POST", "/api/mail", body(a, "send", map[string]any{"toId": x.account("bob"), "gold": 25}), ac, 200)
		if _, err := x.db.DB.Exec("UPDATE mail SET sent_at=? WHERE id=?", x.now.Load()-30*86400, sent.Result.MailID); err != nil {
			t.Fatal(err)
		}
		x.p5("GET", "/api/mail", nil, ac, 200) // the request sweeps what is due
		if x.gold(alice) != 40 || count(t, x.db, "SELECT count(*) FROM mail WHERE id=? AND return_reason='expired'", sent.Result.MailID) != 1 {
			t.Fatal("expired", x.gold(alice))
		}
		_ = b
		returned(t, x, alice, sent.Result.MailID)
	})

	t.Run("access-removal", func(t *testing.T) {
		x := newRig(t)
		ac, a := x.ready("alice")
		_, b := x.member("bob", a.WorldID)
		alice := x.account("alice")
		x.fundGold(alice, 40)
		sent := x.p5("POST", "/api/mail", body(a, "send", map[string]any{"toId": x.account("bob"), "gold": 25}), ac, 200)
		if err := x.db.Allow(context.Background(), "bob", false, x.now.Load()); err != nil {
			t.Fatal(err)
		}
		if x.gold(alice) != 40 {
			t.Fatal("access removed", x.gold(alice))
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
		x.fundGold(olive, 40)
		// Hal has a world of his own and moves into the party's world to
		// receive the letter; his move back is a world move (relocate).
		x.hero("hal", "Hal", "")
		_, h := x.ready("hal")
		home := h.WorldID
		x.hero("hal", "Hal", "p1")
		hc, h := x.again("hal")
		h.Snapshot = x.worldReq("POST", "/api/world/move", moveBody(h, "in", pw, "village"), hc, 200).Snapshot
		sent := x.p5("POST", "/api/mail", body(o, "send", map[string]any{"toId": x.account("hal"), "gold": 25}), oc, 200)
		if x.gold(olive) != 15 {
			t.Fatal("sent", x.gold(olive))
		}
		x.now.Add(MoveCooldown)
		x.worldReq("POST", "/api/world/move", moveBody(h, "out", home, "village"), hc, 200)
		if x.gold(olive) != 40 || x.worldOf("hal") != home {
			t.Fatal("moved away", x.gold(olive))
		}
		returned(t, x, olive, sent.Result.MailID)
	})
}

// TestGoldGiveMovesBothPursesAndRefusesWhenApart: the same give checks as for
// items (3.4) — same world, allowed in, together — with both purses in one
// transaction, the recipient's version moved, and the presence notice.
func TestGoldGiveMovesBothPursesAndRefusesWhenApart(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	oc, o := x.ready("outsider")
	_, _ = oc, o
	alice, bob := x.account("alice"), x.account("bob")
	x.fundGold(alice, 50)

	// Not together: nothing moves.
	if x.opRefreshing(ac, &a, "give", map[string]any{"toId": bob, "gold": 15}, 409).Error.Code != "not-together" {
		t.Fatal("gave across the map")
	}
	if x.gold(alice) != 50 || x.gold(bob) != 0 {
		t.Fatal("a refused give moved gold", x.gold(alice), x.gold(bob))
	}
	x.goldConserved()

	// Together: both purses move in one transaction and the recipient hears
	// it (PresenceGift, kind "gold").
	x.stand(alice, a.WorldID, "commons", 300, 300)
	x.stand(bob, a.WorldID, "commons", 330, 310)
	x.refresh(bc, &b)
	bobRev := b.Version
	gift := x.opRefreshing(ac, &a, "give", map[string]any{"toId": bob, "gold": 15}, 200)
	if gift.Result.GoldGiven != 15 || gift.Result.Given == nil || gift.Result.Given.Kind != "gold" || gift.Result.Given.Qty != 15 {
		t.Fatal("the give's answer", gift.Result)
	}
	if x.gold(alice) != 35 || x.gold(bob) != 15 {
		t.Fatal("the give", x.gold(alice), x.gold(bob))
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
		if err != nil || m.GetGift() == nil || m.GetGift().GetKind() != "gold" || m.GetGift().GetItemDef() != "gold" || m.GetGift().GetQty() != 15 {
			t.Fatal("the notice", m, err)
		}
	default:
		t.Fatal("the recipient heard nothing")
	}
	x.goldConserved()

	// Self-gifts, other worlds, short purses and mixed shapes are refused.
	x.opRefreshing(ac, &a, "give", map[string]any{"toId": alice, "gold": 1}, 400)
	x.opRefreshing(ac, &a, "give", map[string]any{"toId": x.account("outsider"), "gold": 1}, 403)
	if x.opRefreshing(ac, &a, "give", map[string]any{"toId": bob, "gold": 100}, 409).Error.Code != "insufficient-gold" {
		t.Fatal("gave gold that isn't there")
	}
	if x.opRefreshing(ac, &a, "give", map[string]any{"toId": bob, "gold": 5, "asset": map[string]any{"kind": "item", "id": "lamp-wick", "qty": 1}}, 400).Error.Code != "invalid-request" {
		t.Fatal("a give of both")
	}
	if x.opRefreshing(ac, &a, "give", map[string]any{"toId": bob}, 400).Error.Code != "invalid-request" {
		t.Fatal("a give of neither")
	}
	x.goldConserved()
}

// TestShelfPricesBuyAndOwnStock (3.2): a price on a slot is paid to whoever
// stocked it, a bought slot is not a gift (no free take used), your own
// stock is refused, and a free slot keeps the take.
func TestShelfPricesBuyAndOwnStock(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	bc, b := x.member("bob", a.WorldID)
	alice, bob := x.account("alice"), x.account("bob")
	x.fundGold(alice, 100)
	x.fundGold(bob, 30)
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

	// A traveller buys the priced one: the purse pays the stocker, both rows
	// in one transaction.
	bought := x.shelfOp(bc, &b, map[string]any{"op": "buy", "gate": 0, "slot": 0}, 200)
	if bought.Result.Taken == nil || bought.Result.Taken.Id != "comfrey-salve" || bought.Result.Line == "" {
		t.Fatal("bought", bought.Result)
	}
	if x.gold(alice) != 112 || x.gold(bob) != 18 {
		t.Fatal("the sale", x.gold(alice), x.gold(bob))
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND reason='shelf-buy' AND ref=?", bob, alice+":comfrey-salve") != 1 ||
		count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND reason='shelf-sale' AND ref=?", alice, bob+":comfrey-salve") != 1 {
		t.Fatal("the sale's rows")
	}
	x.goldConserved()

	// A bought slot is not a gift: bob's one free take is still his.
	x.shelfOp(bc, &b, map[string]any{"op": "take", "gate": 0, "slot": 1}, 200)
	x.goldConserved()
}

// TestSilasYardBundlesBuyWithGold (3.1): Silas's bundles are gold only and
// capped, a good without the price asked for is invalid-good either way, and
// short of gold is insufficient-gold.
func TestSilasYardBundlesBuyWithGold(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.fundGold(s.AccountID, 20)
	buy := func(seller, good, pay string, status int) itemsResponse {
		fields := map[string]any{"seller": seller, "good": good, "progress": bySeller(s, seller, x.now.Load())}
		if pay != "" {
			fields["pay"] = pay
		}
		return x.opRefreshing(c, &s, "buy", fields, status)
	}
	// Lane A's rule stands: an ember buy of a gold-only bundle is refused.
	if buy("silas-yard", "timber", "", 400).Error.Code != "invalid-good" {
		t.Fatal("an ember buy of a gold-only bundle")
	}
	// The gold-price refusal is lane C's own line in marketBuy (a good with
	// no gold price), so it is tested for real: Hazel's tallow loses its gold
	// price for the length of this buy.
	hazel, ok := content.SellerFor("hazels-kitchen")
	if !ok {
		t.Fatal("hazels-kitchen")
	}
	var tallow *content.ItemGood
	for _, g := range hazel.GetGoods() {
		if g.GetItem() == "tallow" {
			tallow = g
		}
	}
	if tallow == nil || tallow.GetGold() != 2 || tallow.GetEmbers() != 1 {
		t.Fatal("tallow's prices", tallow)
	}
	price := tallow.Gold
	tallow.Gold = nil
	t.Cleanup(func() { tallow.Gold = price })
	if buy("hazels-kitchen", "tallow", "gold", 400).Error.Code != "invalid-good" {
		t.Fatal("a gold buy of a good with no gold price")
	}
	if x.gold(s.AccountID) != 20 {
		t.Fatal("a refused buy touched the purse", x.gold(s.AccountID))
	}
	tallow.Gold = price

	// A good priced in both currencies buys for gold: 2 gold, no embers.
	embers := count(t, x.db, "SELECT embers FROM balances WHERE account_id=?", s.AccountID)
	r := buy("hazels-kitchen", "tallow", "gold", 200)
	if r.Result.Bought == nil || r.Result.Bought.Gold != 2 || r.Result.Bought.Embers != 0 {
		t.Fatal("tallow for gold", r.Result.Bought)
	}
	if x.gold(s.AccountID) != 18 || count(t, x.db, "SELECT embers FROM balances WHERE account_id=?", s.AccountID) != embers {
		t.Fatal("tallow's price", x.gold(s.AccountID))
	}
	x.goldConserved()

	// Silas's bundles are gold only, and capped at three a day.
	if r = buy("silas-yard", "timber", "gold", 200); stackQty(r.Result.Items, "timber") != 4 || r.Result.Bought == nil || r.Result.Bought.Gold != 6 {
		t.Fatal("timber for gold", r.Result)
	}
	if x.gold(s.AccountID) != 12 {
		t.Fatal("the purse", x.gold(s.AccountID))
	}
	x.goldConserved()
	buy("silas-yard", "timber", "gold", 200)
	buy("silas-yard", "timber", "gold", 200)
	if buy("silas-yard", "timber", "gold", 409).Error.Code != "sold-out" {
		t.Fatal("the day's cap")
	}
	if x.opRefreshing(c, &s, "buy", map[string]any{"seller": "silas-yard", "good": "timber", "pay": "silver", "progress": bySeller(s, "silas-yard", x.now.Load())}, 400).Error.Code != "invalid-request" {
		t.Fatal("an unknown currency")
	}
	if x.opRefreshing(c, &s, "buy", map[string]any{"seller": "silas-yard", "good": "stone", "pay": "gold", "progress": bySeller(s, "silas-yard", x.now.Load())}, 409).Error.Code != "insufficient-gold" {
		t.Fatal("spent gold that isn't there")
	}
	x.goldConserved()
}

// A gold letter carries gold and nothing else (question 11): both, or
// neither, is invalid-request; an amount is at least 1; and a purse that
// can't cover it is insufficient-gold (3.3).
func TestGoldLettersRefuseBadShapes(t *testing.T) {
	x := newRig(t)
	ac, a := x.ready("alice")
	_, b := x.member("bob", a.WorldID)
	alice := x.account("alice")
	to := x.account("bob")
	x.fundGold(alice, 10)
	if x.p5("POST", "/api/mail", body(a, "both", map[string]any{"toId": to, "gold": 5, "asset": map[string]any{"kind": "item", "id": "lamp-wick", "qty": 1}}), ac, 400).Error.Code != "invalid-request" {
		t.Fatal("a letter of both")
	}
	if x.p5("POST", "/api/mail", body(a, "neither", map[string]any{"toId": to}), ac, 400).Error.Code != "invalid-request" {
		t.Fatal("a letter of neither")
	}
	if x.p5("POST", "/api/mail", body(a, "negative", map[string]any{"toId": to, "gold": -5}), ac, 400).Error.Code != "invalid-quantity" {
		t.Fatal("a letter of negative gold")
	}
	if x.p5("POST", "/api/mail", body(a, "short", map[string]any{"toId": to, "gold": 11}), ac, 409).Error.Code != "insufficient-gold" {
		t.Fatal("a letter of gold that isn't there")
	}
	if x.gold(alice) != 10 {
		t.Fatal("a refused letter moved gold", x.gold(alice))
	}
	_ = b
	x.goldConserved()
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
	x.fundGold(alice, 50)
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

	if x.gold(alice) != 50 || count(t, x.db, "SELECT count(*) FROM ledger WHERE account_id=? AND currency='gold' AND reason!='habitica-topup'", alice) != 0 {
		t.Fatal("a forged report fed the purse")
	}
	if count(t, x.db, "SELECT count(*) FROM player_gear WHERE account_id=?", alice) != 1 ||
		count(t, x.db, "SELECT count(*) FROM player_gear WHERE account_id=? AND owned_json=?", alice, store.JSON([]string{"head_warrior_1"})) != 1 {
		t.Fatal("a forged report changed the owned list")
	}
	// And the forged piece is not the player's to wear.
	if _, code := x.chooseWardrobe(c, s, "forged", map[string]string{"head": "head_armoire_admiralsBicorne"}, 409); code != "gear-not-owned" {
		t.Fatal("a forged report owned gear", code)
	}
	x.goldConserved()
}
