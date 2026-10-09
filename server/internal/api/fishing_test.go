package api

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/worldchange"
	"google.golang.org/protobuf/encoding/protojson"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Fishing at the mill pond (docs/design/crafts.md 5, lane D): the three
// keyed operations and the waters read, the stock through the world-changes
// table, the reservation, the lazy lapse and the world move.

const millPondID = "water:village:mill-pond"

// ------------------------------------------------------------ what the tests read

// castView is one cast as the wire spells it.
type castView struct {
	ID        string  `json:"id"`
	Water     string  `json:"water"`
	Bank      string  `json:"bank"`
	Species   string  `json:"species"`
	StartedAt float64 `json:"startedAt"`
	ReadyAt   float64 `json:"readyAt"`
	HoldUntil float64 `json:"holdUntil"`
	Band      string  `json:"band"`
}

type fishingStateView struct {
	Cast       *castView `json:"cast"`
	NextCastAt float64   `json:"nextCastAt"`
}

type castResponse struct {
	Result struct {
		Cast castView `json:"cast"`
		Band string   `json:"band"`
	} `json:"result"`
}

type settleResponse struct {
	Result struct {
		Cast string      `json:"cast"`
		Kept bool        `json:"kept"`
		Item string      `json:"item"`
		Wear *wearResult `json:"wear"`
		Band string      `json:"band"`
	} `json:"result"`
}

type cancelResponse struct {
	Result struct {
		Cast string `json:"cast"`
		Band string `json:"band"`
	} `json:"result"`
}

// PlayerState.fishing off a raw answer (the domain bridge projects the
// snapshot over `state`, so the tests read the wire's own bytes).
func rawFishing(t *testing.T, w *httptest.ResponseRecorder) fishingStateView {
	t.Helper()
	var out struct {
		State struct {
			Fishing fishingStateView `json:"fishing"`
		} `json:"state"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		t.Fatal(err, w.Body.String())
	}
	return out.State.Fishing
}

// ------------------------------------------------------------ rig helpers

// bankSpot is where a hero stands at one of the pond's bank tiles (the
// tile's centre — lane G measures reach the same way).
func bankSpot(t *testing.T, s response, bank string) rules.State {
	t.Helper()
	w, ok := content.WaterFor(millPondID)
	if !ok {
		t.Fatal("the mill pond")
	}
	b, ok := content.BankFor(w, bank)
	if !ok {
		t.Fatal(bank)
	}
	tile := b.GetTiles()[len(b.GetTiles())/2]
	doc := s.State
	doc.Area = w.GetArea()
	doc.Position = rules.Position{X: float64(int(tile.GetTx())*16 + 8), Y: float64(int(tile.GetTy())*16 + 8)}
	return doc
}

func castBody(s response, key, bank, rod string, at rules.State) map[string]any {
	return body(s, key, map[string]any{"water": millPondID, "bank": bank, "rod": rod, "progress": at})
}

// A cancel's request carries no where at all (5.4): only the cast.
func cancelBody(s response, key, cast string) map[string]any {
	return map[string]any{"op": map[string]any{"lease": s.Lease, "key": key}, "cast": cast}
}

func settleBody(s response, key, cast string, keep bool, at rules.State) map[string]any {
	return body(s, key, map[string]any{"cast": cast, "keep": keep, "progress": at})
}

func fishKey(x *rig, what string) string {
	return fmt.Sprintf("%s-%d-%d", what, x.now.Load(), keySeq())
}

// fisheryView is the stock a test asserts on (the row's ProtoJSON).
type fisheryView struct {
	Stock, Reserved, At float64
}

// The stock as the world-changes row stores it (false: no row — untouched).
func (x *rig) storedStock(world, entity string) (fisheryView, bool) {
	x.t.Helper()
	var raw string
	err := x.db.DB.QueryRow(`SELECT state FROM world_changes WHERE world_id=? AND entity=?`, world, entity).Scan(&raw)
	if err == sql.ErrNoRows {
		return fisheryView{}, false
	}
	if err != nil {
		x.t.Fatal(err)
	}
	f := contract.FisheryState{}
	if err := protojson.Unmarshal([]byte(raw), &f); err != nil {
		x.t.Fatal(err)
	}
	return fisheryView{Stock: f.Stock, Reserved: f.Reserved, At: f.At}, true
}

// setStock writes a water's stock straight to its row (a test emptying the
// pond without a dozen casts).
func (x *rig) setStock(world, entity string, at, stock, reserved float64) {
	x.t.Helper()
	w, ok := content.WaterFor(entity)
	if !ok {
		x.t.Fatal(entity)
	}
	raw, err := (protojson.MarshalOptions{EmitUnpopulated: true}).Marshal(&contract.FisheryState{Stock: stock, Reserved: reserved, At: at})
	if err != nil {
		x.t.Fatal(err)
	}
	err = worldchange.Put(context.Background(), x.db.DB, worldchange.Row{
		Key: worldchange.Key{WorldID: world, Realm: w.GetArea(), Entity: entity}, Kind: "fishery", State: raw,
	}, x.now.Load())
	if err != nil {
		x.t.Fatal(err)
	}
}

func (x *rig) castState(account, id string) string {
	x.t.Helper()
	var state string
	if err := x.db.DB.QueryRow(`SELECT state FROM fishing_casts WHERE id=? AND account_id=?`, id, account).Scan(&state); err != nil {
		x.t.Fatal(err)
	}
	return state
}

// PlayerState.fishing, as any state-bearing answer spells it.
func (x *rig) stateFishing(c *http.Cookie) fishingStateView {
	x.t.Helper()
	w := x.rawHTTP(http.MethodGet, "/api/state", nil, c)
	if w.Code != 200 {
		x.t.Fatalf("state: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		State struct {
			Fishing fishingStateView `json:"fishing"`
		} `json:"state"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		x.t.Fatal(err, w.Body.String())
	}
	return out.State.Fishing
}

// The waters read: each village water's band.
func (x *rig) waters(c *http.Cookie) map[string]string {
	x.t.Helper()
	w := x.rawHTTP(http.MethodGet, "/api/fishing/waters?area=village", nil, c)
	if w.Code != 200 {
		x.t.Fatalf("waters: %d %s", w.Code, w.Body.String())
	}
	var out struct {
		Waters []struct {
			ID   string `json:"id"`
			Band string `json:"band"`
		} `json:"waters"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &out); err != nil {
		x.t.Fatal(err, w.Body.String())
	}
	bands := map[string]string{}
	for _, v := range out.Waters {
		bands[v.ID] = v.Band
	}
	return bands
}

func (x *rig) packQty(account, def string) int {
	x.t.Helper()
	var n int
	if err := x.db.DB.QueryRow(`SELECT coalesce(sum(qty),0) FROM item_stacks WHERE location='pack' AND owner=? AND item_def=?`, account, def).Scan(&n); err != nil {
		x.t.Fatal(err)
	}
	return n
}

// ------------------------------------------------------------ cast, settle, cancel

// A cast reserves its fish; keep takes it out of the water, wears the rod
// one use and puts the roach in the pack. The band and the bite are frozen
// on the cast (5.3).
func TestFishCastReservesAndKeepTakesTheFish(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	x.fundEmbers(s.AccountID, 10)
	// Finn's rod comes over as one instance (marketBuy, lane A's fix) and
	// it is what fishes here.
	buy := x.opRefreshing(c, &s, "buy", map[string]any{"seller": "finns-mill-door", "good": "willow-rod", "progress": bySeller(s, "finns-mill-door", x.now.Load())}, 200)
	rod := ""
	for i := range buy.Result.Items.Instances {
		if buy.Result.Items.Instances[i].ItemDef == "willow-rod" {
			rod = buy.Result.Items.Instances[i].ID
		}
	}
	if rod == "" {
		t.Fatal("no rod from Finn")
	}
	at := bankSpot(t, s, "north")

	w := x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, at), c)
	if w.Code != 200 {
		t.Fatalf("cast: %d %s", w.Code, w.Body.String())
	}
	cast := decodeHTTP[castResponse](x.t, w)
	f := cast.Result.Cast
	if f.Water != millPondID || f.Bank != "north" || f.Species != "mill-roach" || f.Band != "healthy" {
		t.Fatal("cast", f)
	}
	if f.ReadyAt != f.StartedAt+10 || f.HoldUntil != f.ReadyAt+600 {
		t.Fatal("the band's wait and the hold are not frozen on the cast", f)
	}
	if cast.Result.Band != "healthy" {
		t.Fatal("band", cast.Result.Band)
	}
	// The fish is reserved against the shared stock, and the stored row
	// carries the recovered stock with its clock (5.3).
	stock, ok := x.storedStock(s.WorldID, millPondID)
	if !ok || stock.Stock != 12 || stock.Reserved != 1 || stock.At != f.StartedAt {
		t.Fatal("stock", stock, ok)
	}
	// A reload at the bank puts the float back, and the spacing is on the
	// state too (5.5).
	st := rawFishing(t, w)
	if st.Cast == nil || st.Cast.ID != f.ID || st.NextCastAt != f.StartedAt+8 {
		t.Fatal("state fishing", st)
	}
	if band := x.waters(c)[millPondID]; band != "healthy" {
		t.Fatal("waters", band)
	}

	// No failure window: before the bite the fish waits and settle says so.
	x.now.Add(5)
	early := settleBody(s, fishKey(x, "settle"), f.ID, true, at)
	if st, _, e, _ := x.request("POST", "/api/fishing/settle", early, c); st != 409 || e != "not-yet" {
		t.Fatal("settled before the bite", st, e)
	}
	x.now.Add(5)
	w = x.rawHTTP("POST", "/api/fishing/settle", settleBody(s, fishKey(x, "settle"), f.ID, true, at), c)
	if w.Code != 200 {
		t.Fatalf("keep: %d %s", w.Code, w.Body.String())
	}
	kept := decodeHTTP[settleResponse](x.t, w)
	if !kept.Result.Kept || kept.Result.Item != "mill-roach" || kept.Result.Cast != f.ID {
		t.Fatal("kept", kept.Result)
	}
	if kept.Result.Wear == nil || kept.Result.Wear.ItemDef != "willow-rod" || kept.Result.Wear.UsesLeft != 29 || kept.Result.Wear.Condition != 87 {
		t.Fatal("the rod's wear", kept.Result.Wear)
	}
	if kept.Result.Band != "healthy" {
		t.Fatal("band after the keep", kept.Result.Band)
	}
	if n := x.packQty(s.AccountID, "mill-roach"); n != 1 {
		t.Fatal("no roach in the pack", n)
	}
	// Keep consumed the reservation and took the fish out of the water.
	stock, _ = x.storedStock(s.WorldID, millPondID)
	if stock.Stock != 11 || stock.Reserved != 0 {
		t.Fatal("stock after keep", stock)
	}
	if st := x.castState(s.AccountID, f.ID); st != "kept" {
		t.Fatal("cast", st)
	}
	if x.stateFishing(c).Cast != nil {
		t.Fatal("a settled cast is still on the line")
	}
	x.conserved(s.AccountID)
}

// Cancel and Release give the fish back and never wear the rod; cancelling
// doesn't reset the cast spacing (5.3).
func TestFishCancelAndReleaseGiveTheFishBack(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	rod := x.instance(s.AccountID, "willow-rod", -1, "")
	at := bankSpot(t, s, "north")

	w := x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, at), c)
	if w.Code != 200 {
		t.Fatalf("cast: %d %s", w.Code, w.Body.String())
	}
	f := decodeHTTP[castResponse](x.t, w).Result.Cast

	// The line comes in: the fish goes back to the water.
	w = x.rawHTTP("POST", "/api/fishing/cancel", cancelBody(s, fishKey(x, "cancel"), f.ID), c)
	if w.Code != 200 {
		t.Fatalf("cancel: %d %s", w.Code, w.Body.String())
	}
	cancelled := decodeHTTP[cancelResponse](x.t, w)
	if cancelled.Result.Cast != f.ID || cancelled.Result.Band != "healthy" {
		t.Fatal("cancel", cancelled.Result)
	}
	if stock, _ := x.storedStock(s.WorldID, millPondID); stock.Stock != 12 || stock.Reserved != 0 {
		t.Fatal("a cancelled cast kept its fish", stock)
	}
	if st := x.castState(s.AccountID, f.ID); st != "cancelled" {
		t.Fatal("cast", st)
	}
	// Cancelling a cast already closed answers no-cast (its stored result
	// comes back by key; another key is refused).
	if st, _, e, _ := x.request("POST", "/api/fishing/cancel", cancelBody(s, fishKey(x, "cancel"), f.ID), c); st != 409 || e != "no-cast" {
		t.Fatal("cancelled twice", st, e)
	}
	// Cancelling doesn't reset the spacing.
	if st, _, e, _ := x.request("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, at), c); st != 409 || e != "cast-too-soon" {
		t.Fatal("cast again at once", st, e)
	}

	x.now.Add(8)
	w = x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, at), c)
	if w.Code != 200 {
		t.Fatalf("second cast: %d %s", w.Code, w.Body.String())
	}
	f2 := decodeHTTP[castResponse](x.t, w).Result.Cast
	if f2.ID == f.ID || f2.Species != "mill-roach" {
		t.Fatal("second cast", f2)
	}
	x.now.Add(10)
	w = x.rawHTTP("POST", "/api/fishing/settle", settleBody(s, fishKey(x, "settle"), f2.ID, false, at), c)
	if w.Code != 200 {
		t.Fatalf("release: %d %s", w.Code, w.Body.String())
	}
	released := decodeHTTP[settleResponse](x.t, w)
	if released.Result.Kept || released.Result.Item != "" || released.Result.Wear != nil {
		t.Fatal("released", released.Result)
	}
	if stock, _ := x.storedStock(s.WorldID, millPondID); stock.Stock != 12 || stock.Reserved != 0 {
		t.Fatal("a released fish didn't go back", stock)
	}
	if x.packQty(s.AccountID, "mill-roach") != 0 {
		t.Fatal("a released fish was kept")
	}
	// No wear for a release: the rod is as it was.
	var condition int
	if err := x.db.DB.QueryRow(`SELECT condition FROM item_instances WHERE id=?`, rod).Scan(&condition); err != nil {
		t.Fatal(err)
	}
	if condition != content.ItemMaxPoints(mustItem(t, "willow-rod")) {
		t.Fatal("a released fish wore the rod", condition)
	}
	if st := x.castState(s.AccountID, f2.ID); st != "released" {
		t.Fatal("cast", st)
	}
	x.conserved(s.AccountID)
}

func mustItem(t *testing.T, def string) *content.ItemDef {
	t.Helper()
	d, ok := content.ItemFor(def)
	if !ok {
		t.Fatal(def)
	}
	return d
}

// One open cast per account; a ready fish waits its hold through a reload
// and then slips back — lazily, closed by the next read or operation that
// touches the account or the water (5.3, 5.4).
func TestFishOneOpenCastAndLazyLapse(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	rod := x.instance(s.AccountID, "willow-rod", -1, "")
	at := bankSpot(t, s, "race")

	w := x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "race", rod, at), c)
	if w.Code != 200 {
		t.Fatalf("cast: %d %s", w.Code, w.Body.String())
	}
	f := decodeHTTP[castResponse](x.t, w).Result.Cast
	if st, _, e, _ := x.request("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "race", rod, at), c); st != 409 || e != "already-casting" {
		t.Fatal("two lines out", st, e)
	}

	// The hold runs out: the state read closes the cast and the fish is
	// back in the water. A reload shows no line.
	x.now.Add(10 + 600 + 1)
	if st := x.stateFishing(c); st.Cast != nil {
		t.Fatal("a lapsed cast is still on the line", st)
	}
	if state := x.castState(s.AccountID, f.ID); state != "lapsed" {
		t.Fatal("cast", state)
	}
	if stock, _ := x.storedStock(s.WorldID, millPondID); stock.Reserved != 0 {
		t.Fatal("a lapsed hold kept its fish", stock)
	}

	// Another cast lapses by the waters read just the same.
	w = x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "race", rod, at), c)
	if w.Code != 200 {
		t.Fatalf("second cast: %d %s", w.Code, w.Body.String())
	}
	f2 := decodeHTTP[castResponse](x.t, w).Result.Cast
	x.now.Add(10 + 600 + 1)
	if band := x.waters(c)[millPondID]; band != "healthy" {
		t.Fatal("the water is not whole again", band)
	}
	if state := x.castState(s.AccountID, f2.ID); state != "lapsed" {
		t.Fatal("cast", state)
	}
	if stock, _ := x.storedStock(s.WorldID, millPondID); stock.Stock != 12 || stock.Reserved != 0 {
		t.Fatal("stock", stock)
	}
	x.conserved(s.AccountID)
}

// The bands, the waits and the still water (5.3): the fullness counts the
// fish off lines, and an empty water refuses.
func TestFishBandsStockAndStill(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	rod := x.instance(s.AccountID, "willow-rod", -1, "")
	at := bankSpot(t, s, "north")

	// Very low: under 20 % but a fish in it — a minute to the bite, frozen
	// on the cast.
	x.setStock(s.WorldID, millPondID, float64(x.now.Load()), 2, 0)
	if band := x.waters(c)[millPondID]; band != "very-low" {
		t.Fatal("band", band)
	}
	x.now.Add(8)
	w := x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, at), c)
	if w.Code != 200 {
		t.Fatalf("cast: %d %s", w.Code, w.Body.String())
	}
	f := decodeHTTP[castResponse](x.t, w).Result.Cast
	if f.Band != "very-low" || f.ReadyAt != f.StartedAt+60 {
		t.Fatal("the very low wait", f)
	}
	w = x.rawHTTP("POST", "/api/fishing/cancel", cancelBody(s, fishKey(x, "cancel"), f.ID), c)
	if w.Code != 200 {
		t.Fatalf("cancel: %d %s", w.Code, w.Body.String())
	}

	// A water with less than a fish in it is still: no band, no cast.
	x.setStock(s.WorldID, millPondID, float64(x.now.Load()), 0.5, 0)
	if band := x.waters(c)[millPondID]; band != "still" {
		t.Fatal("band", band)
	}
	x.now.Add(8)
	if st, _, e, _ := x.request("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, at), c); st != 409 || e != "water-still" {
		t.Fatal("cast into an empty pond", st, e)
	}

	// The last fish is a free one; the ones on lines are not.
	x.setStock(s.WorldID, millPondID, float64(x.now.Load()), 12, 11)
	x.now.Add(8)
	w = x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, at), c)
	if w.Code != 200 {
		t.Fatalf("the last fish: %d %s", w.Code, w.Body.String())
	}
	last := decodeHTTP[castResponse](x.t, w).Result.Cast
	if last.Band != "very-low" {
		t.Fatal("the last fish's band", last.Band)
	}
	if st, _, e, _ := x.request("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "race", rod, bankSpot(t, s, "race")), c); st != 409 || e != "already-casting" {
		t.Fatal("a second line", st, e)
	}
	// The hold on that one runs out.
	x.now.Add(10 + 600 + 1)

	// Recovery is worked out, never ticked, and the next operation stores
	// the recovered stock with its clock (5.3): a pond left at six fish is
	// seven fish (and one on a line) ten minutes later.
	x.setStock(s.WorldID, millPondID, float64(x.now.Load()), 6, 0)
	x.now.Add(600)
	w = x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, at), c)
	if w.Code != 200 {
		t.Fatalf("recovered cast: %d %s", w.Code, w.Body.String())
	}
	stock, _ := x.storedStock(s.WorldID, millPondID)
	if stock.Stock != 7 || stock.Reserved != 1 || stock.At != float64(x.now.Load()) {
		t.Fatal("recovery is not stored with its clock", stock)
	}
}

// The banks are server-known rows: where the cast comes from, and the marks
// a bank is closed in (5.1, 5.4). The race bank is open all year.
func TestFishBanksReachAndSeason(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	rod := x.instance(s.AccountID, "willow-rod", -1, "")
	pond, _ := content.WaterFor(millPondID)

	// A cast from the Commons is refused whatever the client map says.
	far := s.State
	far.Area = "commons"
	far.Position = rules.Position{X: 8 * 16, Y: 8 * 16}
	if st, _, e, _ := x.request("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, far), c); st != 409 || e != "too-far-away" {
		t.Fatal("cast from the Commons", st, e)
	}
	// Out of the bank's reach, in the village, is refused too.
	off := s.State
	off.Area = pond.GetArea()
	off.Position = rules.Position{X: 30 * 16, Y: 12 * 16}
	if st, _, e, _ := x.request("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, off), c); st != 409 || e != "too-far-away" {
		t.Fatal("cast from across the green", st, e)
	}
	// A bank that isn't on that water is a client bug.
	bad := body(s, fishKey(x, "cast"), map[string]any{"water": millPondID, "bank": "west", "rod": rod, "progress": bankSpot(t, s, "north")})
	if st, _, e, _ := x.request("POST", "/api/fishing/cast", bad, c); st != 400 || e != "invalid-request" {
		t.Fatal("a bank that isn't there", st, e)
	}

	// In the Quiet the pond is iced: the north bank is closed and the race
	// above the wheel is open (fishing.md decision 6).
	c = x.jumpToAs("alice", "mark", "Quiet")
	s = x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c, 200)
	if st, _, e, _ := x.request("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, bankSpot(t, s, "north")), c); st != 409 || e != "not-in-season" {
		t.Fatal("the iced pond took a cast", st, e)
	}
	w := x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "race", rod, bankSpot(t, s, "race")), c)
	if w.Code != 200 {
		t.Fatalf("the race bank: %d %s", w.Code, w.Body.String())
	}
	if f := decodeHTTP[castResponse](x.t, w).Result.Cast; f.Bank != "race" {
		t.Fatal("cast", f)
	}
}

// The rod is checked the way a tool's use is (5.4): one of yours, in the
// pack, a tool with the fish action, with a use left.
func TestFishRodChecks(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	at := bankSpot(t, s, "north")

	if st, _, e, _ := x.request("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", "", at), c); st != 404 || e != "item-not-found" {
		t.Fatal("cast with no rod", st, e)
	}
	axe := x.instance(s.AccountID, "bench-axe", -1, "")
	if st, _, e, _ := x.request("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", axe, at), c); st != 409 || e != "wrong-tool" {
		t.Fatal("cast with an axe", st, e)
	}
	blunt := x.instance(s.AccountID, "willow-rod", 0, "")
	if st, _, e, _ := x.request("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", blunt, at), c); st != 409 || e != "tool-blunt" {
		t.Fatal("cast with a blunt rod", st, e)
	}
}

// Settle's own refusals (5.4): a cast that isn't yours and open is no-cast;
// one past its hold has lapsed and is no-cast; a rod that has left the pack
// can't wear one and is a wrong tool.
func TestFishSettleRefusals(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	rod := x.instance(s.AccountID, "willow-rod", -1, "")
	at := bankSpot(t, s, "north")

	if st, _, e, _ := x.request("POST", "/api/fishing/settle", settleBody(s, fishKey(x, "settle"), "cast:nobody", true, at), c); st != 409 || e != "no-cast" {
		t.Fatal("settled a cast that isn't there", st, e)
	}

	w := x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, at), c)
	if w.Code != 200 {
		t.Fatalf("cast: %d %s", w.Code, w.Body.String())
	}
	f := decodeHTTP[castResponse](x.t, w).Result.Cast
	// The rod leaves the pack: keeping can't wear it (wrong-tool), but the
	// fish may still go back.
	if _, err := x.db.DB.Exec(`UPDATE item_instances SET location='storage',owner='home' WHERE id=?`, rod); err != nil {
		t.Fatal(err)
	}
	x.now.Add(10)
	if st, _, e, _ := x.request("POST", "/api/fishing/settle", settleBody(s, fishKey(x, "settle"), f.ID, true, at), c); st != 409 || e != "wrong-tool" {
		t.Fatal("kept with a rod that left the pack", st, e)
	}
	w = x.rawHTTP("POST", "/api/fishing/settle", settleBody(s, fishKey(x, "settle"), f.ID, false, at), c)
	if w.Code != 200 {
		t.Fatalf("release: %d %s", w.Code, w.Body.String())
	}
	if r := decodeHTTP[settleResponse](x.t, w).Result; r.Kept || r.Wear != nil {
		t.Fatal("released", r)
	}

	// Past its hold the cast has lapsed: the answer is no-cast and the fish
	// is back in the water.
	if st, _, e, _ := x.request("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, at), c); st != 404 || e != "item-not-found" {
		t.Fatal("cast with a rod in the chest", st, e)
	}
	if _, err := x.db.DB.Exec(`UPDATE item_instances SET location='pack',owner=? WHERE id=?`, s.AccountID, rod); err != nil {
		t.Fatal(err)
	}
	w = x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, at), c)
	if w.Code != 200 {
		t.Fatalf("cast: %d %s", w.Code, w.Body.String())
	}
	f2 := decodeHTTP[castResponse](x.t, w).Result.Cast
	x.now.Add(10 + 600 + 1)
	if st, _, e, _ := x.request("POST", "/api/fishing/settle", settleBody(s, fishKey(x, "settle"), f2.ID, true, at), c); st != 409 || e != "no-cast" {
		t.Fatal("settled a fish that slipped back", st, e)
	}
	if stock, _ := x.storedStock(s.WorldID, millPondID); stock.Reserved != 0 {
		t.Fatal("a lapsed hold kept its fish", stock)
	}
}

// A world move pulls the line in (5.4): the cast closes in the move's own
// transaction and its fish goes back to the old world's pond.
func TestFishWorldMoveClosesAnOpenCast(t *testing.T) {
	x := newRig(t)
	x.hero("olive", "Olive", "p1")
	x.ready("olive")
	pw := x.partyWorldOf("p1")
	x.hero("rue", "Rue", "p1")
	_, c := x.signInAsked("rue", "p1", "")
	x.expect("POST", "/api/world/choose", map[string]any{"choice": "own"}, c, 200)
	s := x.expect("POST", "/api/play", map[string]any{"clientId": "tab-a"}, c, 200)
	rod := x.instance(s.AccountID, "willow-rod", -1, "")
	home := s.WorldID

	w := x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "race", rod, bankSpot(t, s, "race")), c)
	if w.Code != 200 {
		t.Fatalf("cast: %d %s", w.Code, w.Body.String())
	}
	f := decodeHTTP[castResponse](x.t, w).Result.Cast
	if stock, _ := x.storedStock(home, millPondID); stock.Reserved != 1 {
		t.Fatal("stock", stock)
	}

	moved := x.worldReq("POST", "/api/world/move", moveBody(s, "move", pw, "village"), c, 200)
	if moved.Snapshot.WorldID != pw {
		t.Fatal("moved", moved.raw)
	}
	if state := x.castState(s.AccountID, f.ID); state != "cancelled" {
		t.Fatal("a world move left the line out", state)
	}
	if stock, _ := x.storedStock(home, millPondID); stock.Stock != 12 || stock.Reserved != 0 {
		t.Fatal("the fish didn't go back", stock)
	}
	if x.stateFishing(c).Cast != nil {
		t.Fatal("the line is still out after the move")
	}
	x.conserved(s.AccountID)
}

// The wire shapes lane G's client reads (its link's TYPED results and its
// readWaters): the operations answer as Envelope cases named fishCast,
// fishSettle and fishCancel beside the state, and the waters read is the
// plain waters message — no state, no result wrapper.
func TestFishingWireShapesTheClientReads(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	rod := x.instance(s.AccountID, "willow-rod", -1, "")
	at := bankSpot(t, s, "north")
	top := func(w *httptest.ResponseRecorder) map[string]json.RawMessage {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(w.Body.Bytes(), &fields); err != nil {
			t.Fatal(err, w.Body.String())
		}
		return fields
	}

	w := x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, at), c)
	if w.Code != 200 {
		t.Fatalf("cast: %d %s", w.Code, w.Body.String())
	}
	fields := top(w)
	if fields["fishCast"] == nil || fields["state"] == nil {
		t.Fatal("the cast's answer is not the fishCast case beside the state", fields)
	}
	if rawFishing(t, w).Cast == nil {
		t.Fatal("the state beside a cast carries no line")
	}
	f := decodeHTTP[castResponse](x.t, w).Result.Cast

	x.now.Add(10)
	w = x.rawHTTP("POST", "/api/fishing/settle", settleBody(s, fishKey(x, "settle"), f.ID, false, at), c)
	if fields = top(w); fields["fishSettle"] == nil {
		t.Fatal("the settle's answer is not the fishSettle case", fields)
	}
	w = x.rawHTTP("POST", "/api/fishing/cast", castBody(s, fishKey(x, "cast"), "north", rod, at), c)
	if w.Code != 200 {
		t.Fatalf("cast: %d %s", w.Code, w.Body.String())
	}
	f2 := decodeHTTP[castResponse](x.t, w).Result.Cast
	w = x.rawHTTP("POST", "/api/fishing/cancel", cancelBody(s, fishKey(x, "cancel"), f2.ID), c)
	if fields = top(w); fields["fishCancel"] == nil {
		t.Fatal("the cancel's answer is not the fishCancel case", fields)
	}

	w = x.rawHTTP("GET", "/api/fishing/waters?area=village", nil, c)
	fields = top(w)
	if len(fields) != 1 || fields["waters"] == nil {
		t.Fatal("the waters read is not the plain waters message", fields)
	}
}

// ------------------------------------------------------------ the stock's own rules

// Recovery is fractional and capped at capacity; the band counts only the
// fish off lines (5.3).
func TestFisheryStockMath(t *testing.T) {
	x := newRig(t)
	_, s := x.ready("alice")
	w, ok := content.WaterFor(millPondID)
	if !ok {
		t.Fatal("the mill pond")
	}
	x.setStock(s.WorldID, millPondID, 1000, 6, 0)
	// Ten minutes later the pond is a fish fuller; ten more can't overfill.
	for _, tc := range []struct {
		at, now, want float64
	}{{1000, 1000, 6}, {1000, 1300, 6.5}, {1000, 6600, 12}, {1000, 1e9, 12}} {
		f, err := fisheryAt(context.Background(), x.db.DB, s.WorldID, w, tc.now)
		if err != nil {
			t.Fatal(err)
		}
		if f.Stock != tc.want {
			t.Fatalf("recovery to %v: %v", tc.now, f.Stock)
		}
	}
	// The band is read before the reservation: a reserved fish counts
	// against the fullness but not as a free fish.
	f := &contract.FisheryState{Stock: 12, Reserved: 3, At: 0}
	if b := bandFor(w, f); b == nil || b.GetId() != "healthy" {
		t.Fatal("healthy band", b)
	}
	f.Reserved = 10
	if b := bandFor(w, f); b == nil || b.GetId() != "very-low" {
		t.Fatal("very low band", b)
	}
	f.Reserved = 11
	if b := bandFor(w, f); b == nil || b.GetId() != "very-low" {
		t.Fatal("the last fish", b)
	}
	f.Reserved = 12
	if b := bandFor(w, f); b != nil || bandID(w, f) != "still" {
		t.Fatal("an empty pond has a band", b)
	}
}

// The species roll is seeded by the account's cast sequence (5.2): the same
// account and sequence roll the same fish, and weights are honoured.
func TestFishSpeciesRollIsSeededByTheCastSequence(t *testing.T) {
	w, ok := content.WaterFor(millPondID)
	if !ok {
		t.Fatal("the mill pond")
	}
	for seq := 0; seq < 8; seq++ {
		if rollSpecies(w, "alice", seq) != rollSpecies(w, "alice", seq) {
			t.Fatal("the roll is not the cast's own")
		}
	}
	if rollSpecies(w, "alice", 0) != "mill-roach" {
		t.Fatal("the pond's only species")
	}
	// Weights: a species ten times as likely is drawn far more often over
	// the account's cast sequence.
	two := &content.FishWater{Species: []*content.FishSpecies{{Item: "mill-roach", Weight: 9}, {Item: "flour", Weight: 1}}}
	n := 0
	for seq := 0; seq < 400; seq++ {
		if rollSpecies(two, "alice", seq) == "flour" {
			n++
		}
	}
	if n < 10 || n > 90 {
		t.Fatal("the weights are not being rolled", n)
	}
}
