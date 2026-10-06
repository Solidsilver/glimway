package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync"
	"testing"
)

// The item system core (docs/items/): instances, wear, breaking and
// blunting, mending, fittings, consumables, giving, pockets, the off hand
// and pickups.

type itemsResponse struct {
	store.Snapshot
	Items  itemsView `json:"items"`
	Result struct {
		Items   itemsView      `json:"items"`
		Wear    *wearResult    `json:"wear"`
		Used    string         `json:"used"`
		Pickup  string         `json:"pickup"`
		Given   *content.Asset `json:"given"`
		Mended  string         `json:"mended"`
		Created  []string       `json:"created"`
		Returned string         `json:"returned"`
		Paper    *string        `json:"paper"`
	} `json:"result"`
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

func (x *rig) items(method, path string, b any, c *http.Cookie, status int) itemsResponse {
	x.t.Helper()
	var r *http.Request
	if b == nil {
		r = httptest.NewRequest(method, path, nil)
	} else {
		r = httptest.NewRequest(method, path, bytes.NewBufferString(store.JSON(b)))
	}
	r.Header.Set("Content-Type", "application/json")
	if c != nil {
		r.AddCookie(c)
	}
	w := httptest.NewRecorder()
	x.api.ServeHTTP(w, r)
	var v itemsResponse
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		x.t.Fatal(err)
	}
	if w.Code != status {
		x.t.Fatalf("%s %s got %d %s want %d", method, path, w.Code, w.Body.String(), status)
	}
	return v
}

// op runs one item mutation with a fresh key at the caller's current revision.
func (x *rig) op(c *http.Cookie, s *response, op string, fields map[string]any, status int) itemsResponse {
	x.t.Helper()
	x.refresh(c, s)
	x.now.Add(0)
	v := x.items("POST", "/api/items/"+op, body(*s, fmt.Sprintf("%s-%d-%d-%d", op, s.Rev, x.now.Load(), keySeq()), fields), c, status)
	if status == 200 {
		s.Snapshot = v.Snapshot
	}
	return v
}

var keyCounter struct {
	sync.Mutex
	n int
}

func keySeq() int {
	keyCounter.Lock()
	defer keyCounter.Unlock()
	keyCounter.n++
	return keyCounter.n
}

// instance puts one instance straight into a pack (story-given heirlooms
// have no gameplay source yet). condition < 0 is full.
func (x *rig) instance(owner, def string, condition int, maker string) string {
	x.t.Helper()
	d, ok := content.ItemFor(def)
	if !ok {
		x.t.Fatal(def)
	}
	tx, err := x.db.DB.Begin()
	if err != nil {
		x.t.Fatal(err)
	}
	defer tx.Rollback()
	id, err := newInstance(context.Background(), tx, d, instanceAt{"pack", owner}, maker, condition, x.now.Load())
	if err == nil {
		err = currency(context.Background(), tx, owner, content.StackCurrency(def), 1, "test-funding", "", x.now.Load())
	}
	if err == nil {
		err = tx.Commit()
	}
	if err != nil {
		x.t.Fatal(err)
	}
	return id
}
func (x *rig) stack(owner, def, maker string, n int) {
	x.t.Helper()
	tx, err := x.db.DB.Begin()
	if err != nil {
		x.t.Fatal(err)
	}
	defer tx.Rollback()
	if err = packPut(context.Background(), tx, owner, def, []makerQty{{maker, n}}, "test-funding", "", x.now.Load()); err != nil {
		x.t.Fatal(err)
	}
	if err = tx.Commit(); err != nil {
		x.t.Fatal(err)
	}
}
func findInstance(v itemsView, id string) *instanceView {
	for i := range v.Instances {
		if v.Instances[i].ID == id {
			return &v.Instances[i]
		}
	}
	return nil
}
func stackQty(v itemsView, def string) int {
	n := 0
	for _, s := range v.Stacks {
		if s.ItemDef == def {
			n += s.Qty
		}
	}
	return n
}

// conserved: for every carried definition, the ledger's pack currency adds
// up to what the tables hold (stacks plus loose instances) for this player.
func (x *rig) conserved(id string) {
	x.t.Helper()
	rows, err := x.db.DB.Query("SELECT currency,SUM(delta) FROM ledger WHERE habitica_id=? AND (currency LIKE 'material:%' OR currency LIKE 'item:%') GROUP BY currency", id)
	if err != nil {
		x.t.Fatal(err)
	}
	ledger := map[string]int{}
	for rows.Next() {
		var c string
		var n int
		if err = rows.Scan(&c, &n); err != nil {
			x.t.Fatal(err)
		}
		ledger[c] = n
	}
	rows.Close()
	held := map[string]int{}
	rows, err = x.db.DB.Query("SELECT item_def,SUM(qty) FROM item_stacks WHERE location='pack' AND owner=? GROUP BY item_def UNION ALL SELECT item_def,count(*) FROM item_instances WHERE location='pack' AND owner=? GROUP BY item_def", id, id)
	if err != nil {
		x.t.Fatal(err)
	}
	for rows.Next() {
		var d string
		var n int
		if err = rows.Scan(&d, &n); err != nil {
			x.t.Fatal(err)
		}
		held[content.StackCurrency(d)] += n
	}
	rows.Close()
	for c, n := range ledger {
		if held[c] != n {
			x.t.Fatalf("%s: ledger %d, held %d", c, n, held[c])
		}
	}
	for c, n := range held {
		if ledger[c] != n {
			x.t.Fatalf("%s: held %d, ledger %d", c, n, ledger[c])
		}
	}
}

func TestItemsCraftedToolIsAnInstanceWithMakerAndCondition(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	s = x.openWorkshop(c, s)
	x.refresh(c, &s)
	crafted := x.p5("POST", "/api/craft", body(s, "axe", map[string]any{"recipeId": "craft-bench-axe", "qty": 1}), c, 200)
	if len(crafted.Result.InstanceIDs) != 1 {
		t.Fatal("no instance")
	}
	id := crafted.Result.InstanceIDs[0]
	v := x.items("GET", "/api/items", nil, c, 200)
	axe := findInstance(v.Items, id)
	if axe == nil || axe.ItemDef != "bench-axe" || axe.Condition != 90 || axe.MaxCondition != 90 || axe.UsesLeft != 30 || axe.State != "whole" || axe.Maker == nil || axe.Maker.ID != "alice" || axe.Maker.Name != "Hero" || len(axe.Fittings) != 0 {
		t.Fatalf("crafted axe %+v", axe)
	}
	// Made parts carry the maker too; the workshop view lists instances.
	x.refresh(c, &s)
	wick := x.p5("POST", "/api/craft", body(s, "wick", map[string]any{"recipeId": "craft-lamp-wick", "qty": 2}), c, 200)
	if len(wick.Result.Inventory.Instances) != 1 {
		t.Fatal("workshop instances")
	}
	v = x.items("GET", "/api/items", nil, c, 200)
	for _, st := range v.Items.Stacks {
		if st.ItemDef == "lamp-wick" && (st.Maker == nil || st.Maker.ID != "alice" || st.Qty != 2) {
			t.Fatal("marked stack", st)
		}
	}
	if v.Items.OffHand.Open || len(v.Items.Pockets) != 1 {
		t.Fatal("classless, one pocket")
	}
	x.conserved("alice")
}

func TestItemsCheapToolWearsToZeroAndBreaks(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	axe := x.instance("alice", "bench-axe", -1, "")
	x.op(c, &s, "use", map[string]any{"instance": axe, "action": "dig"}, 409)
	// A replayed use is the same use, not a second one.
	x.refresh(c, &s)
	once := body(s, "swing-once", map[string]any{"instance": axe})
	first := x.items("POST", "/api/items/use", once, c, 200)
	if again := x.items("POST", "/api/items/use", once, c, 200); store.JSON(first) != store.JSON(again) || first.Result.Wear.UsesLeft != 29 {
		t.Fatal("replayed use")
	}
	if x.op(c, &s, "use", map[string]any{"instance": axe}, 200).Result.Wear.UsesLeft != 28 {
		t.Fatal("uses after replay")
	}
	for i := 3; i < 30; i++ {
		v := x.op(c, &s, "use", map[string]any{"instance": axe, "action": "chop"}, 200)
		if v.Result.Wear.Broke || v.Result.Wear.UsesLeft != 30-i {
			t.Fatal("use", i, v.Result.Wear)
		}
		if want := map[bool]string{true: "worn", false: "whole"}[(30-i)*3*100 < 90*50]; v.Result.Wear.State != want {
			t.Fatal("state", i, v.Result.Wear.State)
		}
	}
	// The last use still happens; then the axe is gone.
	last := x.op(c, &s, "use", map[string]any{"instance": axe}, 200)
	if !last.Result.Wear.Broke || last.Result.Wear.State != "broken" || findInstance(last.Result.Items, axe) != nil {
		t.Fatal("break", last.Result.Wear)
	}
	if x.op(c, &s, "use", map[string]any{"instance": axe}, 404).Error.Code != "item-not-found" {
		t.Fatal("used a broken axe")
	}
	if count(t, x.db, "SELECT count(*) FROM ledger WHERE reason='tool-broke' AND currency='item:bench-axe' AND delta=-1") != 1 {
		t.Fatal("break ledger")
	}
	x.conserved("alice")
	// Someone else's tool is not yours to swing.
	bc, b := x.member("bob", s.WorldID)
	other := x.instance("alice", "bench-pick", -1, "")
	x.op(bc, &b, "use", map[string]any{"instance": other}, 404)
	x.op(c, &s, "use", map[string]any{"instance": "missing"}, 404)
}

func TestItemsHeirloomBluntsAndIsMendedAtTheBenchOrByAMender(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	brack := x.instance("alice", "brack-felling-axe", 3, "")
	v := x.op(c, &s, "use", map[string]any{"instance": brack}, 200)
	if v.Result.Wear.Broke || v.Result.Wear.State != "blunt" || v.Result.Wear.Condition != 0 {
		t.Fatal("blunt", v.Result.Wear)
	}
	if x.op(c, &s, "use", map[string]any{"instance": brack}, 409).Error.Code != "tool-blunt" {
		t.Fatal("blunt axe swung")
	}
	// No workshop yet: the bench refuses; Silas mends while you talk, if you're by him.
	if x.op(c, &s, "repair", map[string]any{"instance": brack, "at": "bench"}, 409).Error.Code != "not-a-member" {
		t.Fatal("homeless bench")
	}
	x.give("alice", "timber", 4)
	x.give("alice", "wooden-peg", 2)
	if x.op(c, &s, "repair", map[string]any{"instance": brack, "at": "silas"}, 409).Error.Code != "too-far-away" {
		t.Fatal("mended from afar")
	}
	x.op(c, &s, "repair", map[string]any{"instance": brack, "at": "nobody"}, 400)
	m, _ := content.MenderFor("silas")
	doc := s.State
	doc.Area = m.Area
	doc.Position = rules.Position{X: float64(m.TX*16 + 8), Y: float64(m.TY*16 + 20)}
	mended := x.op(c, &s, "repair", map[string]any{"instance": brack, "at": "silas", "progress": doc}, 200)
	if axe := findInstance(mended.Result.Items, brack); axe == nil || axe.Condition != 240 || axe.State != "whole" || stackQty(mended.Result.Items, "timber") != 2 || stackQty(mended.Result.Items, "wooden-peg") != 1 {
		t.Fatal("mended", axe)
	}
	if x.op(c, &s, "repair", map[string]any{"instance": brack, "at": "silas"}, 409).Error.Code != "not-needed" {
		t.Fatal("mended a sharp axe")
	}
	// At the bench, with a workshop: the same bill.
	x.op(c, &s, "use", map[string]any{"instance": brack}, 200)
	s = x.openWorkshop(c, s)
	x.refresh(c, &s)
	beforeTimber := x.items("GET", "/api/items", nil, c, 200).Items
	bench := x.op(c, &s, "repair", map[string]any{"instance": brack, "at": "bench"}, 200)
	if findInstance(bench.Result.Items, brack).Condition != 240 || stackQty(bench.Result.Items, "timber") != stackQty(beforeTimber, "timber")-2 {
		t.Fatal("bench mend")
	}
	// Cheap tools can't be mended; nor can the poor afford it.
	axe := x.instance("alice", "bench-axe", 10, "")
	if x.op(c, &s, "repair", map[string]any{"instance": axe, "at": "bench"}, 409).Error.Code != "cannot-mend" {
		t.Fatal("mended a cheap tool")
	}
	pole := x.instance("alice", "nans-lamplighter-pole", 0, "")
	if st := findInstance(x.items("GET", "/api/items", nil, c, 200).Items, pole).State; st != "cracked" {
		t.Fatal("pole state", st)
	}
	x.give("alice", "fiber", -count(t, x.db, "SELECT qty FROM item_stacks WHERE owner='alice' AND item_def='fiber'"))
	if x.op(c, &s, "repair", map[string]any{"instance": pole, "at": "bench"}, 409).Error.Code != "insufficient-materials" {
		t.Fatal("free mend")
	}
	x.conserved("alice")
}

func TestItemsFittingsHoldWearAndMove(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	axe := x.instance("alice", "bench-axe", -1, "")
	nail := x.instance("alice", "loose-road-nail", -1, "")
	// Fitting needs the bench.
	if x.op(c, &s, "fit", map[string]any{"tool": axe, "instance": nail}, 409).Error.Code != "not-a-member" {
		t.Fatal("fitted without a bench")
	}
	s = x.openWorkshop(c, s)
	fitted := x.op(c, &s, "fit", map[string]any{"tool": axe, "instance": nail}, 200)
	a := findInstance(fitted.Result.Items, axe)
	if a == nil || len(a.Fittings) != 1 || a.Fittings[0].Fitting != "hold" || a.UsesLeft != 45 || findInstance(fitted.Result.Items, nail) != nil {
		t.Fatalf("fitted %+v", a)
	}
	// One slot on a cheap tool.
	strip := x.instance("alice", "tarrow-edge-strip", -1, "")
	if x.op(c, &s, "fit", map[string]any{"tool": axe, "instance": strip}, 409).Error.Code != "no-free-slot" {
		t.Fatal("two fittings on a cheap tool")
	}
	// Thirty uses wear the nail out; the axe goes back to wearing normally:
	// 90 points at 2 a use is 30 points left, at 3 a use is 10 more uses.
	var v itemsResponse
	for i := 0; i < 30; i++ {
		v = x.op(c, &s, "use", map[string]any{"instance": axe}, 200)
	}
	if len(v.Result.Wear.WornOut) != 1 || v.Result.Wear.WornOut[0] != "loose-road-nail" || v.Result.Wear.Condition != 30 || v.Result.Wear.UsesLeft != 10 {
		t.Fatal("nail worn out", v.Result.Wear)
	}
	for i := 0; i < 9; i++ {
		x.op(c, &s, "use", map[string]any{"instance": axe}, 200)
	}
	if !x.op(c, &s, "use", map[string]any{"instance": axe}, 200).Result.Wear.Broke {
		t.Fatal("forty uses with a nail for thirty")
	}
	// An heirloom takes one of each kind, up to three; fittings move between
	// tools keeping their wear, and come off into the pack.
	brack := x.instance("alice", "brack-felling-axe", -1, "")
	pick := x.instance("alice", "bench-pick", -1, "")
	x.op(c, &s, "fit", map[string]any{"tool": pick, "instance": strip}, 200)
	x.op(c, &s, "use", map[string]any{"instance": pick}, 200)
	x.op(c, &s, "fit", map[string]any{"tool": brack, "instance": strip}, 200)
	moved := x.items("GET", "/api/items", nil, c, 200).Items
	if b := findInstance(moved, brack); len(b.Fittings) != 1 || b.Fittings[0].Condition != 87 || len(findInstance(moved, pick).Fittings) != 0 {
		t.Fatal("moved fitting", b.Fittings)
	}
	second := x.instance("alice", "tarrow-edge-strip", -1, "")
	if x.op(c, &s, "fit", map[string]any{"tool": brack, "instance": second}, 409).Error.Code != "fitting-kind-taken" {
		t.Fatal("two bites")
	}
	if x.op(c, &s, "fit", map[string]any{"tool": brack, "instance": strip}, 409).Error.Code != "already-fitted" {
		t.Fatal("refit in place")
	}
	off := x.op(c, &s, "unfit", map[string]any{"instance": strip}, 200)
	if f := findInstance(off.Result.Items, strip); f == nil || f.Condition != 87 {
		t.Fatal("unfit")
	}
	x.op(c, &s, "unfit", map[string]any{"instance": strip}, 409)
	x.op(c, &s, "fit", map[string]any{"tool": strip, "instance": second}, 400)
	x.conserved("alice")
}

func TestItemsBreakingDropsFittingsIntoThePack(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	s = x.openWorkshop(c, s)
	spade := x.instance("alice", "bench-spade", 3, "")
	bead := x.instance("alice", "amber-bead", -1, "")
	x.op(c, &s, "fit", map[string]any{"tool": spade, "instance": bead}, 200)
	v := x.op(c, &s, "use", map[string]any{"instance": spade}, 200)
	if !v.Result.Wear.Broke || len(v.Result.Wear.Returned) != 1 {
		t.Fatal("broke", v.Result.Wear)
	}
	if b := findInstance(v.Result.Items, bead); b == nil || b.Condition != 87 {
		t.Fatal("bead back in the pack")
	}
	x.conserved("alice")
}

func TestItemsWardenSetDullsAndHealsOvernight(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	s = x.openWorkshop(c, s)
	axe := x.instance("alice", "bench-axe", -1, "")
	sliver := x.instance("alice", "warden-sliver", -1, "")
	x.op(c, &s, "fit", map[string]any{"tool": axe, "instance": sliver}, 200)
	var v itemsResponse
	for i := 0; i < 45; i++ {
		v = x.op(c, &s, "use", map[string]any{"instance": axe}, 200)
		if v.Result.Wear.Broke {
			t.Fatal("warden-set broke")
		}
	}
	if v.Result.Wear.State != "dull" || v.Result.Wear.Condition != 0 {
		t.Fatal("dull", v.Result.Wear)
	}
	if a := findInstance(v.Result.Items, axe); !a.WardenSet || a.Fittings[0].MaxCondition != 0 {
		t.Fatal("sliver never wears")
	}
	x.now.Add(86400)
	if a := findInstance(x.items("GET", "/api/items", nil, c, 200).Items, axe); a.Condition != 90 || a.State != "whole" {
		t.Fatal("healed overnight", a)
	}
}

func TestItemsConsumablesRestoreAndThankTheMaker(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	x.stack("alice", "keepers-twists", "bob", 2)
	x.stack("alice", "keepers-twists", "", 1)
	x.stack("alice", "comfrey-salve", "", 1)
	// Hurt alice (HP 20 of 50 from the imported profile already).
	x.refresh(c, &s)
	if s.State.HP >= s.State.MaxHP {
		t.Fatal("rig hp")
	}
	hp := s.State.HP
	bob := "bob"
	v := x.op(c, &s, "use", map[string]any{"itemDef": "keepers-twists", "maker": bob}, 200)
	if v.Result.Used != "keepers-twists" || v.State.HP != hp+10 || stackQty(v.Result.Items, "keepers-twists") != 2 {
		t.Fatal("twist", v.State.HP)
	}
	// Bob was away: a quiet thank-you waits for him.
	if th := x.items("GET", "/api/items", nil, bc, 200).Items.Thanks; len(th) != 1 || th[0].FromName != "Hero" || th[0].ItemDef != "keepers-twists" {
		t.Fatal("thanks", th)
	}
	// Together, nothing is sent.
	x.stand("alice", s.WorldID, "village", 100, 100)
	x.stand("bob", s.WorldID, "village", 120, 100)
	x.op(c, &s, "use", map[string]any{"itemDef": "keepers-twists", "maker": bob}, 200)
	if count(t, x.db, "SELECT count(*) FROM item_thanks") != 1 {
		t.Fatal("thanked while together")
	}
	if x.op(c, &s, "use", map[string]any{"itemDef": "keepers-twists", "maker": bob}, 409).Error.Code != "insufficient-items" {
		t.Fatal("bob's twists ran out")
	}
	if x.op(c, &s, "use", map[string]any{"itemDef": "comfrey-salve"}, 409).Error.Code != "not-usable-yet" {
		t.Fatal("unmoored isn't in the game yet")
	}
	x.op(c, &s, "use", map[string]any{"itemDef": "timber"}, 400)
	// At full health a twist would be wasted.
	if _, err := x.db.DB.Exec("UPDATE progress SET doc_json=json_set(doc_json,'$.hp',50) WHERE habitica_id='alice'"); err != nil {
		t.Fatal(err)
	}
	if x.op(c, &s, "use", map[string]any{"itemDef": "keepers-twists"}, 409).Error.Code != "not-needed" {
		t.Fatal("wasted twist")
	}
	_ = b
	x.conserved("alice")
}

func TestItemsGiveHandsOverToSomeoneNearby(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	oc, o := x.ready("outsider")
	x.stack("alice", "lamp-wick", "alice", 3)
	x.stack("alice", "whittled-fox", "", 1)
	axe := x.instance("alice", "bench-axe", 50, "alice")
	gift := map[string]any{"toId": "bob", "asset": map[string]any{"kind": "item", "id": "lamp-wick", "qty": 2}}
	if x.op(c, &s, "give", gift, 409).Error.Code != "not-together" {
		t.Fatal("gave across the map")
	}
	x.stand("alice", s.WorldID, "commons", 300, 300)
	x.stand("bob", s.WorldID, "commons", 330, 310)
	x.refresh(bc, &b)
	bobRev := b.Rev
	v := x.op(c, &s, "give", gift, 200)
	if v.Result.Given == nil || stackQty(v.Result.Items, "lamp-wick") != 1 {
		t.Fatal("given")
	}
	got := x.items("GET", "/api/items", nil, bc, 200)
	if stackQty(got.Items, "lamp-wick") != 2 || got.Items.Stacks[0].Maker == nil || got.Items.Stacks[0].Maker.ID != "alice" || got.Rev != bobRev {
		t.Fatal("received with the maker's mark", got.Items.Stacks, got.Rev, bobRev)
	}
	// A tool goes with its condition and maker.
	x.op(c, &s, "give", map[string]any{"toId": "bob", "asset": map[string]any{"kind": "instance", "id": "bench-axe", "qty": 1, "instance": axe}}, 200)
	if a := findInstance(x.items("GET", "/api/items", nil, bc, 200).Items, axe); a == nil || a.Condition != 50 || a.Maker.ID != "alice" {
		t.Fatal("tool handed over")
	}
	// Story keepsakes and heirlooms stay; nobody gives to themselves or outside the world.
	if x.op(c, &s, "give", map[string]any{"toId": "bob", "asset": map[string]any{"kind": "item", "id": "whittled-fox", "qty": 1}}, 409).Error.Code != "not-giveable" {
		t.Fatal("gave a story keepsake")
	}
	brack := x.instance("alice", "brack-felling-axe", -1, "")
	if x.op(c, &s, "give", map[string]any{"toId": "bob", "asset": map[string]any{"kind": "instance", "id": "brack-felling-axe", "qty": 1, "instance": brack}}, 409).Error.Code != "not-giveable" {
		t.Fatal("gave an heirloom")
	}
	x.op(c, &s, "give", map[string]any{"toId": "alice", "asset": map[string]any{"kind": "item", "id": "lamp-wick", "qty": 1}}, 400)
	x.stand("outsider", o.WorldID, "commons", 300, 300)
	x.op(c, &s, "give", map[string]any{"toId": "outsider", "asset": map[string]any{"kind": "item", "id": "lamp-wick", "qty": 1}}, 403)
	x.op(c, &s, "give", map[string]any{"toId": "bob", "asset": map[string]any{"kind": "item", "id": "lamp-wick", "qty": 5}}, 409)
	x.op(c, &s, "give", map[string]any{"toId": "bob", "asset": map[string]any{"kind": "instance", "id": "bench-axe", "qty": 1, "instance": axe}}, 409)
	// Exactly once on replay.
	x.refresh(c, &s)
	req := body(s, "give-once", map[string]any{"toId": "bob", "asset": map[string]any{"kind": "item", "id": "lamp-wick", "qty": 1}})
	first := x.items("POST", "/api/items/give", req, c, 200)
	again := x.items("POST", "/api/items/give", req, c, 200)
	if store.JSON(first) != store.JSON(again) || count(t, x.db, "SELECT qty FROM item_stacks WHERE owner='bob' AND item_def='lamp-wick'") != 3 {
		t.Fatal("replayed give")
	}
	_, _ = oc, o
	for _, id := range []string{"alice", "bob"} {
		x.conserved(id)
	}
}

// Two hand-overs of the same things at once, on independent connections:
// the instance goes to exactly one player; a stack never goes negative.
func TestItemsGiveRaces(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	cc, cr := x.member("cara", s.WorldID)
	_, _, _, _ = bc, b, cc, cr
	for _, id := range []string{"alice", "bob", "cara"} {
		x.stand(id, s.WorldID, "village", 200, 200)
	}
	other, err := store.Open(filepath.Join(x.dir, "game.sqlite"))
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	api2 := New(other, x.api.Habitica, x.api.Config)
	api2.presence = x.api.presence
	race := func(bodies []map[string]any) []int {
		start := make(chan struct{})
		out := make(chan int, len(bodies))
		var wg sync.WaitGroup
		for i, b := range bodies {
			wg.Add(1)
			go func(i int, b map[string]any) {
				defer wg.Done()
				<-start
				r := httptest.NewRequest("POST", "/api/items/give", bytes.NewBufferString(store.JSON(b)))
				r.Header.Set("Content-Type", "application/json")
				r.AddCookie(c)
				w := httptest.NewRecorder()
				if i%2 == 0 {
					x.api.ServeHTTP(w, r)
				} else {
					api2.ServeHTTP(w, r)
				}
				out <- w.Code
			}(i, b)
		}
		close(start)
		wg.Wait()
		close(out)
		codes := []int{}
		for n := range out {
			codes = append(codes, n)
		}
		return codes
	}
	ok := func(codes []int) int {
		n := 0
		for _, c := range codes {
			if c == 200 {
				n++
			}
		}
		return n
	}
	axe := x.instance("alice", "bench-axe", -1, "")
	x.refresh(c, &s)
	asset := map[string]any{"kind": "instance", "id": "bench-axe", "qty": 1, "instance": axe}
	codes := race([]map[string]any{
		body(s, "race-bob", map[string]any{"toId": "bob", "asset": asset}),
		body(s, "race-cara", map[string]any{"toId": "cara", "asset": asset}),
	})
	if ok(codes) != 1 || count(t, x.db, "SELECT count(*) FROM item_instances WHERE id=? AND location='pack' AND owner IN ('bob','cara')", axe) != 1 {
		t.Fatal("instance race", codes)
	}
	x.stack("alice", "lamp-wick", "", 3)
	x.refresh(c, &s)
	wick := map[string]any{"kind": "item", "id": "lamp-wick", "qty": 2}
	codes = race([]map[string]any{
		body(s, "wick-bob", map[string]any{"toId": "bob", "asset": wick}),
		body(s, "wick-cara", map[string]any{"toId": "cara", "asset": wick}),
	})
	if ok(codes) != 1 || count(t, x.db, "SELECT COALESCE(SUM(qty),0) FROM item_stacks WHERE item_def='lamp-wick'") != 3 {
		t.Fatal("stack race", codes)
	}
	for _, id := range []string{"alice", "bob", "cara"} {
		x.conserved(id)
	}
}

func TestItemsPocketsAndCarryGear(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	x.stack("alice", "whittled-fox", "", 1)
	x.stack("alice", "work-glove", "", 1)
	x.stack("alice", "lamp-wick", "", 1)
	v := x.op(c, &s, "pocket", map[string]any{"slot": 1, "itemDef": "whittled-fox"}, 200)
	if len(v.Result.Items.Pockets) != 1 || *v.Result.Items.Pockets[0].ItemDef != "whittled-fox" {
		t.Fatal("pocketed")
	}
	if x.op(c, &s, "pocket", map[string]any{"slot": 2, "itemDef": "work-glove"}, 409).Error.Code != "no-such-pocket" {
		t.Fatal("second pocket without carry gear")
	}
	x.op(c, &s, "pocket", map[string]any{"slot": 3, "itemDef": "work-glove"}, 400)
	x.op(c, &s, "pocket", map[string]any{"slot": 1, "itemDef": "lamp-wick"}, 400)
	x.op(c, &s, "pocket", map[string]any{"slot": 1, "itemDef": "river-glass-bead"}, 409)
	satchel := x.instance("alice", "forager-satchel", -1, "")
	v = x.op(c, &s, "pocket", map[string]any{"slot": 2, "itemDef": "work-glove"}, 200)
	if len(v.Result.Items.Pockets) != 2 || *v.Result.Items.Pockets[1].ItemDef != "work-glove" {
		t.Fatal("two pockets")
	}
	// The same keepsake can't fill both pockets: it moves.
	v = x.op(c, &s, "pocket", map[string]any{"slot": 2, "itemDef": "whittled-fox"}, 200)
	if v.Result.Items.Pockets[0].ItemDef != nil || *v.Result.Items.Pockets[1].ItemDef != "whittled-fox" {
		t.Fatal("moved between pockets")
	}
	x.op(c, &s, "pocket", map[string]any{"slot": 1, "itemDef": "work-glove"}, 200)
	// Handing the satchel over closes the second pocket.
	x.stand("alice", s.WorldID, "village", 10, 10)
	x.stand("bob", s.WorldID, "village", 12, 10)
	v = x.op(c, &s, "give", map[string]any{"toId": "bob", "asset": map[string]any{"kind": "instance", "id": "forager-satchel", "qty": 1, "instance": satchel}}, 200)
	if len(v.Result.Items.Pockets) != 1 || count(t, x.db, "SELECT count(*) FROM item_slots WHERE habitica_id='alice'") != 1 {
		t.Fatal("pocket 2 settled")
	}
	// Giving the last glove away empties its pocket.
	v = x.op(c, &s, "give", map[string]any{"toId": "bob", "asset": map[string]any{"kind": "item", "id": "work-glove", "qty": 1}}, 200)
	if v.Result.Items.Pockets[0].ItemDef != nil {
		t.Fatal("pocketed a glove you gave away")
	}
	x.op(c, &s, "pocket", map[string]any{"slot": 1}, 200)
	_, _ = bc, b
}

func TestItemsOffHandOpensWithAClass(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	lantern := x.instance("alice", "carters-lantern", -1, "")
	axe := x.instance("alice", "bench-axe", -1, "")
	x.stack("alice", "tin-whistle", "", 1)
	x.stack("alice", "work-glove", "", 1)
	if x.op(c, &s, "offhand", map[string]any{"instance": lantern}, 409).Error.Code != "off-hand-closed" {
		t.Fatal("classless off hand")
	}
	warrior := "warrior"
	p := profile("alice", 10, 0, 20)
	p.Class = &warrior
	x.set(p)
	x.refresh(c, &s)
	// The class arrives with the next Habitica sync.
	s.Snapshot = x.expect("POST", "/api/sync", syncBody(s, p, s.State), c, 200).Snapshot
	v := x.op(c, &s, "offhand", map[string]any{"instance": lantern}, 200)
	if !v.Result.Items.OffHand.Open || *v.Result.Items.OffHand.Class != "warrior" || *v.Result.Items.OffHand.Instance != lantern || *v.Result.Items.OffHand.ItemDef != "carters-lantern" {
		t.Fatal("lantern in hand", v.Result.Items.OffHand)
	}
	v = x.op(c, &s, "offhand", map[string]any{"itemDef": "tin-whistle"}, 200)
	if *v.Result.Items.OffHand.ItemDef != "tin-whistle" || v.Result.Items.OffHand.Instance != nil {
		t.Fatal("whistle in hand")
	}
	if x.op(c, &s, "offhand", map[string]any{"instance": axe}, 409).Error.Code != "not-for-the-off-hand" {
		t.Fatal("an axe in the off hand")
	}
	x.op(c, &s, "offhand", map[string]any{"itemDef": "work-glove"}, 409)
	if v = x.op(c, &s, "offhand", map[string]any{}, 200); v.Result.Items.OffHand.ItemDef != nil {
		t.Fatal("emptied")
	}
	// Without a class the off hand closes, and anything in it is put away.
	x.op(c, &s, "offhand", map[string]any{"instance": lantern}, 200)
	p.Class = nil
	x.set(p)
	x.refresh(c, &s)
	s.Snapshot = x.expect("POST", "/api/sync", syncBody(s, p, s.State), c, 200).Snapshot
	if v = x.op(c, &s, "pocket", map[string]any{"slot": 1}, 200); v.Result.Items.OffHand.Open || count(t, x.db, "SELECT count(*) FROM item_slots WHERE slot='off-hand'") != 0 {
		t.Fatal("off hand closed with the class")
	}
}

func TestItemsPickupsOncePerPlayerStandingThere(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	p, _ := content.PickupFor("dropped-bucket")
	if x.op(c, &s, "pickup", map[string]any{"pickup": p.ID}, 409).Error.Code != "too-far-away" {
		t.Fatal("picked up from afar")
	}
	doc := s.State
	doc.Area = p.Area
	doc.Position = rules.Position{X: float64(p.TX*16 + 8), Y: float64(p.TY*16 + 12)}
	v := x.op(c, &s, "pickup", map[string]any{"pickup": p.ID, "progress": doc}, 200)
	if v.Result.Pickup != p.ID || len(v.Result.Created) != 1 || len(v.Result.Items.PickedUp) != 1 {
		t.Fatal("picked up")
	}
	if b := findInstance(v.Result.Items, v.Result.Created[0]); b == nil || b.ItemDef != "stave-bucket" || b.Condition != p.UsesLeft*3 || b.Maker != nil || b.State != "worn" {
		t.Fatal("found bucket", b)
	}
	if x.op(c, &s, "pickup", map[string]any{"pickup": p.ID}, 409).Error.Code != "already-picked-up" {
		t.Fatal("twice")
	}
	x.op(c, &s, "pickup", map[string]any{"pickup": "nothing-here"}, 404)
	cakes, _ := content.PickupFor("oatcake-parcel")
	doc.Area = cakes.Area
	doc.Position = rules.Position{X: float64(cakes.TX * 16), Y: float64(cakes.TY * 16)}
	v = x.op(c, &s, "pickup", map[string]any{"pickup": cakes.ID, "progress": doc}, 200)
	if stackQty(v.Result.Items, "oatcakes") != cakes.Qty {
		t.Fatal("oatcakes")
	}
	x.conserved("alice")
}

func TestItemsTravelByParcelAndChest(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	bc, b := x.member("bob", s.WorldID)
	s = x.openWorkshop(c, s)
	axe := x.instance("alice", "bench-axe", 40, "alice")
	nail := x.instance("alice", "loose-road-nail", -1, "")
	x.op(c, &s, "fit", map[string]any{"tool": axe, "instance": nail}, 200)
	x.stack("alice", "lamp-wick", "alice", 2)
	x.refresh(c, &s)
	asset := content.Asset{Kind: "instance", ID: "bench-axe", Qty: 1, Instance: axe}
	sent := x.p5("POST", "/api/mail", body(s, "post-axe", map[string]any{"toId": "bob", "asset": asset}), c, 200)
	s.Snapshot = sent.Snapshot
	if count(t, x.db, "SELECT count(*) FROM item_instances WHERE id=? AND location='mail' AND owner='alice'", axe) != 1 {
		t.Fatal("axe in the post")
	}
	x.refresh(bc, &b)
	x.p5("POST", "/api/mail/"+sent.Result.MailID+"/claim", body(b, "claim-axe", nil), bc, 200)
	got := findInstance(x.items("GET", "/api/items", nil, bc, 200).Items, axe)
	if got == nil || got.Condition != 40 || len(got.Fittings) != 1 || got.Maker.ID != "alice" {
		t.Fatal("parcel delivered the axe with its nail", got)
	}
	// Marked stacks keep their maker through the post and back.
	maker := "alice"
	wicks := content.Asset{Kind: "item", ID: "lamp-wick", Qty: 2, Maker: &maker}
	x.refresh(c, &s)
	sent = x.p5("POST", "/api/mail", body(s, "post-wicks", map[string]any{"toId": "bob", "asset": wicks}), c, 200)
	s.Snapshot = sent.Snapshot
	x.p5("POST", "/api/mail/"+sent.Result.MailID+"/recall", body(s, "recall-wicks", nil), c, 200)
	if count(t, x.db, "SELECT qty FROM item_stacks WHERE location='pack' AND owner='alice' AND item_def='lamp-wick' AND maker_id='alice'") != 2 {
		t.Fatal("recalled wicks lost their mark")
	}
	// A tool in the personal chest and back.
	pick := x.instance("alice", "bench-pick", -1, "")
	x.refresh(c, &s)
	dep := x.p5("POST", "/api/storage", body(s, "chest-pick", map[string]any{"direction": "deposit", "chest": "personal", "asset": content.Asset{Kind: "instance", ID: "bench-pick", Qty: 1, Instance: pick}}), c, 200)
	s.Snapshot = dep.Snapshot
	if len(dep.Result.Personal.Instances) != 1 || len(dep.Result.Inventory.Instances) != 0 {
		t.Fatal("pick in the chest")
	}
	x.p5("POST", "/api/storage", body(s, "chest-pick-2", map[string]any{"direction": "deposit", "chest": "personal", "asset": content.Asset{Kind: "instance", ID: "bench-pick", Qty: 1, Instance: pick}}), c, 409)
	back := x.p5("POST", "/api/storage", body(s, "chest-pick-back", map[string]any{"direction": "withdraw", "chest": "personal", "asset": content.Asset{Kind: "instance", ID: "bench-pick", Qty: 1, Instance: pick}}), c, 200)
	if len(back.Result.Inventory.Instances) != 1 {
		t.Fatal("pick back")
	}
	s.Snapshot = back.Snapshot
	x.p5("POST", "/api/storage", body(s, "bad-asset", map[string]any{"direction": "deposit", "chest": "personal", "asset": content.Asset{Kind: "item", ID: "bench-pick", Qty: 1}}), c, 400)
	for _, id := range []string{"alice", "bob"} {
		x.conserved(id)
	}
}
