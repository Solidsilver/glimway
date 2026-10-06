package api

import (
	"bytes"
	"context"
	"encoding/json"
	"fingersnap/content"
	"fingersnap/server/internal/rules"
	"fingersnap/server/internal/store"
	"fingersnap/server/internal/wilds"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"
)

type repairsTestResponse struct {
	store.Snapshot
	Open       []choreView        `json:"open"`
	Mended     []mendedView       `json:"mended"`
	WorldFlags []string           `json:"worldFlags"`
	History    []choreHistoryView `json:"history"`
	Result     struct {
		Repairs  repairsView         `json:"repairs"`
		Mended   string              `json:"mended"`
		Reaction string              `json:"reaction"`
		Gift     *content.RepairGift `json:"gift"`
		Items    itemsView           `json:"items"`
	} `json:"result"`
	Error struct {
		Code string `json:"code"`
	} `json:"error"`
}

func (x *rig) repairsReq(method, path string, b any, c *http.Cookie, status int) repairsTestResponse {
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
	var v repairsTestResponse
	if err := json.Unmarshal(w.Body.Bytes(), &v); err != nil {
		x.t.Fatal(err)
	}
	if w.Code != status {
		x.t.Fatalf("%s %s got %d %s want %d", method, path, w.Code, w.Body.String(), status)
	}
	return v
}

func (x *rig) mend(c *http.Cookie, s *response, repairID string, fields map[string]any, status int) repairsTestResponse {
	x.t.Helper()
	x.refresh(c, s)
	x.now.Add(0)
	v := x.repairsReq("POST", "/api/repairs/"+repairID+"/mend", body(*s, fmt.Sprintf("mend-%s-%d-%d", repairID, s.Rev, keySeq()), fields), c, status)
	if status == 200 {
		s.Snapshot = v.Snapshot
	}
	return v
}

func TestRepairsScriptedProgressionAndMending(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	// 1. Initial read: well-rope is open
	read := x.repairsReq("GET", "/api/repairs", nil, c, 200)
	if len(read.Open) != 1 || read.Open[0].ID != "well-rope" {
		t.Fatalf("expected well-rope open, got %+v", read.Open)
	}
	if len(read.Mended) != 0 {
		t.Fatalf("expected 0 mended, got %+v", read.Mended)
	}

	// 2. Far away: fails too-far-away (409, like every other proximity refusal)
	farDoc := s.State
	farDoc.Area = "village"
	farDoc.Position = rules.Position{X: 100, Y: 100}
	bad := x.mend(c, &s, "well-rope", map[string]any{"progress": farDoc}, 409)
	if bad.Error.Code != "too-far-away" {
		t.Fatalf("expected too-far-away, got %s", bad.Error.Code)
	}

	// 3. Proximity to well (tx: 13, ty: 12) but no fibre-rope in pack
	wellDoc := s.State
	wellDoc.Area = "village"
	wellDoc.Position = rules.Position{X: float64(13*16 + 8), Y: float64(12*16 + 8)}
	bad = x.mend(c, &s, "well-rope", map[string]any{"progress": wellDoc}, 409)
	if bad.Error.Code != "insufficient-items" {
		t.Fatalf("expected insufficient-items, got %s", bad.Error.Code)
	}

	// 4. Seed fibre-rope in pack
	x.stack("alice", "fibre-rope", "", 1)
	x.conserved("alice")

	// Mend well-rope
	mended := x.mend(c, &s, "well-rope", map[string]any{"progress": wellDoc}, 200)
	if mended.Result.Mended != "well-rope" {
		t.Fatalf("expected mended well-rope, got %s", mended.Result.Mended)
	}
	if mended.Result.Reaction != "Bread tastes of the well again." {
		t.Fatalf("unexpected reaction: %s", mended.Result.Reaction)
	}
	if mended.Result.Gift == nil || mended.Result.Gift.ID != "keepers-twists" || mended.Result.Gift.Qty != 1 {
		t.Fatalf("unexpected gift: %+v", mended.Result.Gift)
	}
	// Gift placed into pack: check conservation
	x.conserved("alice")

	// 5. Subsequent read: well-rope is mended, fence-rail is now open!
	read2 := x.repairsReq("GET", "/api/repairs", nil, c, 200)
	if len(read2.Mended) != 1 || read2.Mended[0].RepairID != "well-rope" {
		t.Fatalf("expected well-rope in mended, got %+v", read2.Mended)
	}
	if len(read2.Open) != 1 || read2.Open[0].ID != "fence-rail" {
		t.Fatalf("expected fence-rail open next, got %+v", read2.Open)
	}
	if !slices.Contains(read2.WorldFlags, "repair:well-rope:mended") {
		t.Fatalf("expected repair:well-rope:mended in worldFlags, got %+v", read2.WorldFlags)
	}

	// 6. Mending well-rope again fails with already-mended (409)
	x.stack("alice", "fibre-rope", "", 1)
	bad = x.mend(c, &s, "well-rope", map[string]any{"progress": wellDoc}, 409)
	if bad.Error.Code != "already-mended" {
		t.Fatalf("expected already-mended, got %s", bad.Error.Code)
	}
}

func TestDrawingWaterAtWell(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	bucketID := x.instance("alice", "stave-bucket", 90, "")
	x.conserved("alice")

	// 1. Drawing water when well-rope is broken fails (well-rope-broken)
	wellDoc := s.State
	wellDoc.Area = "village"
	wellDoc.Position = rules.Position{X: float64(13*16 + 8), Y: float64(12*16 + 8)}
	bad := x.op(c, &s, "use", map[string]any{"instance": bucketID, "action": "draw", "progress": wellDoc}, 409)
	if bad.Error.Code != "well-rope-broken" {
		t.Fatalf("expected well-rope-broken, got %s", bad.Error.Code)
	}

	// 2. Mend well-rope
	x.stack("alice", "fibre-rope", "", 1)
	x.mend(c, &s, "well-rope", map[string]any{"progress": wellDoc}, 200)

	// 3. Drawing water far away fails (too-far-away)
	farDoc := s.State
	farDoc.Area = "village"
	farDoc.Position = rules.Position{X: 100, Y: 100}
	bad = x.op(c, &s, "use", map[string]any{"instance": bucketID, "action": "draw", "progress": farDoc}, 409)
	if bad.Error.Code != "too-far-away" {
		t.Fatalf("expected too-far-away, got %s", bad.Error.Code)
	}

	// 4. Drawing water at the well succeeds and wears the bucket by 3 wear points (1 use)
	used := x.op(c, &s, "use", map[string]any{"instance": bucketID, "action": "draw", "progress": wellDoc}, 200)
	if used.Result.Wear == nil || used.Result.Wear.ItemDef != "stave-bucket" {
		t.Fatalf("expected wear on stave-bucket, got %+v", used.Result.Wear)
	}
	inst := findInstance(used.Result.Items, bucketID)
	if inst == nil || inst.Condition != 87 {
		t.Fatalf("expected bucket condition 87, got %+v", inst)
	}
	x.conserved("alice")
}

func TestReturningKeepsakes(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	// 1. Tam's halter -> Ada (tx: 35, ty: 8 in village)
	x.stack("alice", "knotted-halter", "", 1)
	x.conserved("alice")

	adaDoc := s.State
	adaDoc.Area = "village"
	adaDoc.Position = rules.Position{X: float64(35*16 + 8), Y: float64(8*16 + 8)}

	// Too far away from Ada
	farDoc := s.State
	farDoc.Area = "village"
	farDoc.Position = rules.Position{X: 100, Y: 100}
	bad := x.op(c, &s, "return", map[string]any{"itemDef": "knotted-halter", "target": "ada", "progress": farDoc}, 409)
	if bad.Error.Code != "too-far-away" {
		t.Fatalf("expected too-far-away, got %s", bad.Error.Code)
	}

	// Wrong recipient
	bad = x.op(c, &s, "return", map[string]any{"itemDef": "knotted-halter", "target": "hazel", "progress": adaDoc}, 400)
	if bad.Error.Code != "wrong-recipient" {
		t.Fatalf("expected wrong-recipient, got %s", bad.Error.Code)
	}

	// Return halter to Ada
	retAda := x.op(c, &s, "return", map[string]any{"itemDef": "knotted-halter", "target": "ada", "progress": adaDoc}, 200)
	if retAda.Result.Returned != "knotted-halter" {
		t.Fatalf("expected returned knotted-halter, got %s", retAda.Result.Returned)
	}
	if retAda.Result.Paper == nil || *retAda.Result.Paper != "adas-oil-receipts" {
		t.Fatalf("expected paper adas-oil-receipts, got %+v", retAda.Result.Paper)
	}
	if !slices.Contains(retAda.Snapshot.State.Flags, "paper:adas-oil-receipts") || !slices.Contains(retAda.Snapshot.State.Flags, "returned:knotted-halter") {
		t.Fatalf("expected story flags set, got %+v", retAda.Snapshot.State.Flags)
	}
	x.conserved("alice")

	// Re-returning fails
	x.stack("alice", "knotted-halter", "", 1)
	bad = x.op(c, &s, "return", map[string]any{"itemDef": "knotted-halter", "target": "ada", "progress": adaDoc}, 409)
	if bad.Error.Code != "already-returned" {
		t.Fatalf("expected already-returned, got %s", bad.Error.Code)
	}

	// 2. Joss's whistle -> Hazel (tx: 12, ty: 15 in village)
	x.stack("alice", "tin-whistle", "", 1)
	x.conserved("alice")
	hazelDoc := s.State
	hazelDoc.Area = "village"
	hazelDoc.Position = rules.Position{X: float64(12*16 + 8), Y: float64(15*16 + 8)}

	retHazel := x.op(c, &s, "return", map[string]any{"itemDef": "tin-whistle", "target": "hazel", "progress": hazelDoc}, 200)
	if retHazel.Result.Returned != "tin-whistle" || retHazel.Result.Paper == nil || *retHazel.Result.Paper != "keepers-twists-recipe-card" {
		t.Fatalf("expected keepers-twists-recipe-card, got %+v", retHazel.Result)
	}
	if !slices.Contains(retHazel.Snapshot.State.Flags, "paper:keepers-twists-recipe-card") {
		t.Fatalf("expected paper flag for recipe card, got %+v", retHazel.Snapshot.State.Flags)
	}
	x.conserved("alice")

	// 3. Hollis's fox -> Silas (tx: 51, ty: 21 in commons)
	x.stack("alice", "whittled-fox", "", 1)
	x.conserved("alice")
	silasDoc := s.State
	silasDoc.Area = "commons"
	silasDoc.Position = rules.Position{X: float64(51*16 + 8), Y: float64(21*16 + 8)}

	retSilas := x.op(c, &s, "return", map[string]any{"itemDef": "whittled-fox", "target": "silas", "progress": silasDoc}, 200)
	if retSilas.Result.Returned != "whittled-fox" || retSilas.Result.Paper != nil {
		t.Fatalf("expected no paper from Silas, got %+v", retSilas.Result)
	}
	if !slices.Contains(retSilas.Snapshot.State.Flags, "returned:whittled-fox") {
		t.Fatalf("expected returned:whittled-fox flag, got %+v", retSilas.Snapshot.State.Flags)
	}
	x.conserved("alice")

	// 4. Bett's candle -> Bett's echo camp (in wilds)
	x.stack("alice", "beeswax-candle", "", 1)
	x.conserved("alice")
	wildsDoc := s.State
	wildsDoc.Area = "wilds"
	retBett := x.op(c, &s, "return", map[string]any{"itemDef": "beeswax-candle", "target": "bett", "progress": wildsDoc}, 200)
	if retBett.Result.Returned != "beeswax-candle" || !slices.Contains(retBett.Snapshot.State.Flags, "echo:bett:softened") {
		t.Fatalf("expected echo:bett:softened flag, got %+v", retBett.Snapshot.State.Flags)
	}
	x.conserved("alice")

	// 5. Nan's nails -> Nan's echo camp (in wilds)
	x.stack("alice", "road-nails", "", 1)
	x.conserved("alice")
	retNan := x.op(c, &s, "return", map[string]any{"itemDef": "road-nails", "target": "nan", "progress": wildsDoc}, 200)
	if retNan.Result.Returned != "road-nails" || !slices.Contains(retNan.Snapshot.State.Flags, "echo:nan:softened") {
		t.Fatalf("expected echo:nan:softened flag, got %+v", retNan.Snapshot.State.Flags)
	}
	x.conserved("alice")
}

// The break weather (review finding 2): after the scripted two, one new
// breakage opens per wick, never the same thing twice in a row, up to
// maxOpen. Repairs must come back (re-break) or the chores list empties
// for good. Candidates run in content order, so the rotation cycles through
// the list, skipping whatever was mended last.
func TestRepairsWeatherPacing(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	// The idle session expires in exactly 7 days, so a wick jump re-logins.
	nextWick := func() repairsTestResponse {
		x.now.Add(7*86400 + 3600)
		c = x.login("alice", "")
		x.refresh(c, &s)
		return x.repairsReq("GET", "/api/repairs", nil, c, 200)
	}

	// The scripted two, mended (their parts seeded; both near the square).
	wellDoc := s.State
	wellDoc.Area = "village"
	wellDoc.Position = rules.Position{X: float64(13*16 + 8), Y: float64(12*16 + 8)}
	fenceDoc := s.State
	fenceDoc.Area = "village"
	fenceDoc.Position = rules.Position{X: float64(27*16 + 8), Y: float64(18*16 + 8)}
	for _, chore := range []struct {
		id   string
		part string
		doc  rules.State
	}{{"well-rope", "fibre-rope", wellDoc}, {"fence-rail", "split-rail", fenceDoc}} {
		x.stack("alice", chore.part, "", 1)
		x.mend(c, &s, chore.id, map[string]any{"progress": chore.doc}, 200)
	}

	// One weather breakage opens now (the wick's first), not all of them:
	// the oldest mend (the well rope) rots again first.
	read := x.repairsReq("GET", "/api/repairs", nil, c, 200)
	if len(read.Open) != 1 || read.Open[0].ID != "well-rope" {
		t.Fatalf("expected exactly the well rope open after the fence, got %+v", read.Open)
	}
	// A second read in the same wick opens nothing more.
	read = x.repairsReq("GET", "/api/repairs", nil, c, 200)
	if len(read.Open) != 1 {
		t.Fatalf("expected the same single chore on re-read, got %+v", read.Open)
	}

	// A wick later, the fence takes its turn (never the same thing twice in
	// a row), and a re-broken repair is not mended any more.
	x.stack("alice", "fibre-rope", "", 1)
	x.mend(c, &s, "well-rope", map[string]any{"progress": wellDoc}, 200)
	read = nextWick()
	if len(read.Open) != 1 || read.Open[0].ID != "fence-rail" {
		t.Fatalf("expected the fence rail next wick, got %+v", read.Open)
	}
	if slices.ContainsFunc(read.Mended, func(m mendedView) bool { return m.RepairID == "fence-rail" }) {
		t.Fatal("a re-broken repair is not mended any more")
	}
	x.conserved("alice")
}

// The hame is a festival chore: it only breaks shortly before Carting Day,
// in its content window (openFrom: Cart wick, day 5).
func TestRepairsHameWaitsForCartingDay(t *testing.T) {
	x := newRig(t)
	c, _ := x.ready("alice")

	// The world has mended everything else; only the hame is left, and the
	// weather clock spent last wick's breakage.
	epoch := int64(1767571200) // the calendar's epoch (2026-01-05)
	cartDay5 := epoch + (5*7+4)*86400
	x.now.Store(cartDay5 - 86400) // Cart wick, day 4: the window is shut
	_, err := x.db.DB.Exec("INSERT INTO village_repairs(world_id, repair_id, mended_by, mended_at, created_at) SELECT id, 'well-rope', NULL, 1, 0 FROM worlds")
	if err != nil {
		t.Fatal(err)
	}
	for _, id := range []string{"fence-rail", "library-roof", "bench-slat", "village-lamp"} {
		if _, err = x.db.DB.Exec("INSERT INTO village_repairs(world_id, repair_id, mended_by, mended_at, created_at) SELECT id, ?, NULL, 1, 0 FROM worlds", id); err != nil {
			t.Fatal(err)
		}
	}
	if _, err = x.db.DB.Exec("INSERT INTO village_repair_log(id, world_id, repair_id, mended_by, mended_at) SELECT hex(randomblob(16)), id, 'village-lamp', (SELECT habitica_id FROM players LIMIT 1), 1 FROM worlds"); err != nil {
		t.Fatal(err)
	}
	// This wick's weather breakage is already spent (wick 6; Cart is wick 6):
	// the hame is a festival chore, so it does not wait for the weather.
	if _, err = x.db.DB.Exec(`INSERT INTO village_repair_clock(world_id, last_break_wick) SELECT id, 6 FROM worlds WHERE true ON CONFLICT(world_id) DO UPDATE SET last_break_wick=6`); err != nil {
		t.Fatal(err)
	}

	// Day 4 of Cart: the hame stays shut, nothing opens.
	read := x.repairsReq("GET", "/api/repairs", nil, c, 200)
	if len(read.Open) != 0 {
		t.Fatalf("expected the hame to wait for its window, got %+v, logs: %s", read.Open, x.logs.String())
	}

	// Day 5, the day before the festival: the hame breaks.
	x.now.Store(cartDay5)
	read = x.repairsReq("GET", "/api/repairs", nil, c, 200)
	if len(read.Open) != 1 || read.Open[0].ID != "gate-hame" {
		t.Fatalf("expected the hame open the day before Carting Day, got %+v", read.Open)
	}
	x.conserved("alice")
}

// The mend's gift goes through the ledger with everything else (review
// finding 3): a failed gift insert must roll the whole mend back, leaving
// the ledger conserved, instead of committing a stack with no ledger row.
func TestMendGiftFailureRollsBack(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	// Sabotage the gift's ledger row: the stack insert succeeds, the ledger
	// row does not.
	if _, err := x.db.DB.Exec("CREATE TRIGGER sabotage_reward BEFORE INSERT ON ledger WHEN NEW.reason='village-reward' BEGIN SELECT RAISE(ABORT, 'sabotage'); END"); err != nil {
		t.Fatal(err)
	}
	x.stack("alice", "fibre-rope", "", 1)
	wellDoc := s.State
	wellDoc.Area = "village"
	wellDoc.Position = rules.Position{X: float64(13*16 + 8), Y: float64(12*16 + 8)}
	x.mend(c, &s, "well-rope", map[string]any{"progress": wellDoc}, 500)
	x.conserved("alice")

	// Nothing changed: the rope is still in the pack, the well still open.
	var n int
	if err := x.db.DB.QueryRow("SELECT count(*) FROM item_stacks WHERE item_def='keepers-twists'").Scan(&n); err != nil || n != 0 {
		t.Fatal("the gift outlived its failed ledger row", n)
	}
	read := x.repairsReq("GET", "/api/repairs", nil, c, 200)
	if len(read.Open) != 1 || read.Open[0].ID != "well-rope" {
		t.Fatalf("expected the well rope still open, got %+v", read.Open)
	}
}

// A story keepsake is a single, real thing (review INFO): the Wilds give a
// bound keepsake to a player once, no matter how often the loot roll says
// it again. Unbound trinkets (the mirror foxes) stay repeatable.
func TestStoryKeepsakeFoundOnce(t *testing.T) {
	x := newRig(t)
	x.ready("alice")
	ctx := context.Background()
	fox := "whittled-fox"
	mirror := "mirror-fox"
	for i := 0; i < 2; i++ {
		tx, err := x.db.DB.Begin()
		if err != nil {
			t.Fatal(err)
		}
		var worldID string
		if err = tx.QueryRow("SELECT id FROM worlds LIMIT 1").Scan(&worldID); err != nil {
			t.Fatal(err)
		}
		s := store.Snapshot{HabiticaID: "alice", WorldID: worldID}
		if err = grantLoot(ctx, tx, &s, wilds.LootDrop{Trinket: &fox}, "wilds-claim", "ref", int64(i)); err != nil {
			t.Fatal(err)
		}
		if err = grantLoot(ctx, tx, &s, wilds.LootDrop{Trinket: &mirror}, "wilds-claim", "ref", int64(i)); err != nil {
			t.Fatal(err)
		}
		if err = tx.Commit(); err != nil {
			t.Fatal(err)
		}
	}
	var foxes, mirrors int
	if err := x.db.DB.QueryRow("SELECT coalesce(sum(qty),0) FROM item_stacks WHERE owner='alice' AND item_def='whittled-fox'").Scan(&foxes); err != nil {
		t.Fatal(err)
	}
	if err := x.db.DB.QueryRow("SELECT coalesce(sum(qty),0) FROM item_stacks WHERE owner='alice' AND item_def='mirror-fox'").Scan(&mirrors); err != nil {
		t.Fatal(err)
	}
	if foxes != 1 || mirrors != 2 {
		t.Fatalf("story keepsake once, mirror foxes repeat: foxes=%d mirrors=%d", foxes, mirrors)
	}
	x.conserved("alice")
}
