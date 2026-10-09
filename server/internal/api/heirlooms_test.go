package api

import (
	"glimway/content"
	"glimway/server/internal/rules"
	"slices"
	"testing"
)

// Tests for the four heirloom tools (BRIEF.md & BRIEF-FIXES.md):
//  1. Brack felling axe — Silas (Hollis's name known)
//  2. Orrin's mason pick — Orrin (north bridge mended)
//  3. Ada's garden spade — Ada (brought window oil 3 times)
//  4. Nan's lamplighter pole — Nan's settled echo camp
//
// Rules verified per grant:
//  - Proximity check -> refused (409 too-far-away)
//  - Forged flags -> refused (409 condition-unmet)
//  - Condition unmet -> refused (409 condition-unmet)
//  - Condition met -> granted once (200 OK, instanced, ledgered, flag set)
//  - Replay with same key -> same answer (idem)
//  - Subsequent request with new key -> refused (409 already-granted)
//  - Not giveable or sellable, refused into shared chest (409 not-giveable)

func TestHeirloomBrackFellingAxe(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	m, ok := content.MenderFor("silas")
	if !ok {
		t.Fatal("mender silas not found")
	}
	silasPos := rules.Position{X: float64(m.TX*16 + 8), Y: float64(m.TY*16 + 20)}

	// 1. Condition unmet: Hollis's name unknown (Alice at Silas)
	atSilasDoc := s.State
	atSilasDoc.Area = m.Area
	atSilasDoc.Position = silasPos
	bad := x.items("POST", "/api/items/heirloom", body(s, "axe-unmet", map[string]any{
		"itemDef":  "brack-felling-axe",
		"progress": atSilasDoc,
	}), c, 409)
	if bad.Error.Code != "condition-unmet" {
		t.Fatalf("expected condition-unmet, got %s", bad.Error.Code)
	}

	// 2. Forged flag test: sending returned:whittled-fox in progress without ledger row
	forgedDoc := atSilasDoc
	forgedDoc.Flags = append(slices.Clone(atSilasDoc.Flags), "returned:whittled-fox")
	badForged := x.items("POST", "/api/items/heirloom", body(s, "axe-forged", map[string]any{
		"itemDef":  "brack-felling-axe",
		"progress": forgedDoc,
	}), c, 409)
	if badForged.Error.Code != "condition-unmet" {
		t.Fatalf("expected condition-unmet for forged returned:whittled-fox, got %s", badForged.Error.Code)
	}

	// 3. Meet condition by reading ashwatch ledger excerpts
	conditionMetDoc := atSilasDoc
	conditionMetDoc.Flags = append(slices.Clone(atSilasDoc.Flags), "paper:ashwatch-ledger-excerpts")
	x.db.DB.Exec("INSERT OR IGNORE INTO story_marks VALUES(?,'paper:ashwatch-ledger-excerpts','server',?)", s.AccountID, x.now.Load())

	// Proximity check: condition met, but player is far away in Village
	farDoc := conditionMetDoc
	farDoc.Area = "village"
	farDoc.Position = rules.Position{X: 100, Y: 100}
	badFar := x.items("POST", "/api/items/heirloom", body(s, "axe-far", map[string]any{
		"itemDef":  "brack-felling-axe",
		"progress": farDoc,
	}), c, 409)
	if badFar.Error.Code != "too-far-away" {
		t.Fatalf("expected too-far-away, got %s", badFar.Error.Code)
	}

	// 4. Condition met & standing near Silas: grant with key
	key := "axe-grant-key-1"
	res := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{
		"itemDef":  "brack-felling-axe",
		"progress": conditionMetDoc,
	}), c, 200)
	if res.Result.Heirloom != "brack-felling-axe" {
		t.Fatalf("expected heirloom brack-felling-axe, got %s", res.Result.Heirloom)
	}
	if len(res.Result.Created) != 1 {
		t.Fatalf("expected 1 created instance, got %v", res.Result.Created)
	}
	if !slices.Contains(res.State.Flags, "heirloom:brack-felling-axe") {
		t.Fatalf("expected heirloom:brack-felling-axe flag, got %v", res.State.Flags)
	}
	inst := findInstance(res.Result.Items, res.Result.Created[0])
	if inst == nil || inst.ItemDef != "brack-felling-axe" || inst.Condition != 240 || inst.UsesLeft != 80 {
		t.Fatalf("unexpected instance: %+v", inst)
	}

	// 5. Replay with same key returns identical successful result
	replay := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{
		"itemDef":  "brack-felling-axe",
		"progress": conditionMetDoc,
	}), c, 200)
	if replay.Result.Heirloom != "brack-felling-axe" || len(replay.Result.Created) != 1 {
		t.Fatalf("replay mismatch: %+v", replay.Result)
	}

	// 6. Subsequent request with new key is refused: already granted
	s.Version = res.Version
	dup := x.items("POST", "/api/items/heirloom", body(s, "axe-grant-key-2", map[string]any{
		"itemDef":  "brack-felling-axe",
		"progress": conditionMetDoc,
	}), c, 409)
	if dup.Error.Code != "already-granted" {
		t.Fatalf("expected already-granted, got %s", dup.Error.Code)
	}

	// 7. Conservation check (ledger matches held instances)
	x.conserved(x.account("alice"))
}

func TestHeirloomOrrinsMasonPick(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	m, ok := content.MenderFor("orrin")
	if !ok {
		t.Fatal("mender orrin not found")
	}
	orrinPos := rules.Position{X: float64(m.TX*16 + 8), Y: float64(m.TY*16 + 8)}

	// 1. Condition unmet: north bridge not mended in DB
	atOrrinDoc := s.State
	atOrrinDoc.Area = m.Area
	atOrrinDoc.Position = orrinPos
	bad := x.items("POST", "/api/items/heirloom", body(s, "pick-unmet", map[string]any{
		"itemDef":  "orrins-mason-pick",
		"progress": atOrrinDoc,
	}), c, 409)
	if bad.Error.Code != "condition-unmet" {
		t.Fatalf("expected condition-unmet, got %s", bad.Error.Code)
	}

	// 2. Forged flag test: send project:north-bridge:complete flag in progress, bridge not mended in DB
	forgedDoc := atOrrinDoc
	forgedDoc.Flags = append(slices.Clone(atOrrinDoc.Flags), "project:north-bridge:complete")
	badForged := x.items("POST", "/api/items/heirloom", body(s, "pick-forged", map[string]any{
		"itemDef":  "orrins-mason-pick",
		"progress": forgedDoc,
	}), c, 409)
	if badForged.Error.Code != "condition-unmet" {
		t.Fatalf("expected condition-unmet for forged project:north-bridge:complete flag, got %s", badForged.Error.Code)
	}

	// 3. Meet condition: north bridge mended in projects table
	if _, err := x.db.DB.Exec("INSERT INTO projects(world_id, project_def, completed_at, world_flag) VALUES(?, 'north-bridge', 1000, 'project:north-bridge:complete')", s.WorldID); err != nil {
		t.Fatalf("insert project: %v", err)
	}

	// Proximity check: bridge mended, but player is far away in Commons
	farDoc := atOrrinDoc
	farDoc.Area = "commons"
	farDoc.Position = rules.Position{X: 100, Y: 100}
	badFar := x.items("POST", "/api/items/heirloom", body(s, "pick-far", map[string]any{
		"itemDef":  "orrins-mason-pick",
		"progress": farDoc,
	}), c, 409)
	if badFar.Error.Code != "too-far-away" {
		t.Fatalf("expected too-far-away, got %s", badFar.Error.Code)
	}

	// 4. Condition met & standing near Orrin: grant with key
	key := "pick-grant-key-1"
	res := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{
		"itemDef":  "orrins-mason-pick",
		"progress": atOrrinDoc,
	}), c, 200)
	if res.Result.Heirloom != "orrins-mason-pick" {
		t.Fatalf("expected heirloom orrins-mason-pick, got %s", res.Result.Heirloom)
	}
	if len(res.Result.Created) != 1 {
		t.Fatalf("expected 1 created instance, got %v", res.Result.Created)
	}
	if !slices.Contains(res.State.Flags, "heirloom:orrins-mason-pick") {
		t.Fatalf("expected heirloom:orrins-mason-pick flag, got %v", res.State.Flags)
	}
	inst := findInstance(res.Result.Items, res.Result.Created[0])
	if inst == nil || inst.ItemDef != "orrins-mason-pick" || inst.Condition != 240 || inst.UsesLeft != 80 {
		t.Fatalf("unexpected instance: %+v", inst)
	}

	// 5. Replay with same key returns identical result
	replay := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{
		"itemDef":  "orrins-mason-pick",
		"progress": atOrrinDoc,
	}), c, 200)
	if replay.Result.Heirloom != "orrins-mason-pick" {
		t.Fatalf("replay mismatch: %+v", replay.Result)
	}

	// 6. Subsequent request with new key: already-granted
	s.Version = res.Version
	dup := x.items("POST", "/api/items/heirloom", body(s, "pick-grant-key-2", map[string]any{
		"itemDef":  "orrins-mason-pick",
		"progress": atOrrinDoc,
	}), c, 409)
	if dup.Error.Code != "already-granted" {
		t.Fatalf("expected already-granted, got %s", dup.Error.Code)
	}

	x.conserved(x.account("alice"))
}

func TestHeirloomAdaGardenSpadeAndOil(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	spot, ok := content.ResidentAt("ada", float64(x.now.Load()))
	if !ok {
		t.Fatal("resident ada not found")
	}
	adaPos := rules.Position{X: float64(spot.GetTx()*16 + 8), Y: float64(spot.GetTy()*16 + 8)}

	atAdaDoc := s.State
	atAdaDoc.Area = spot.GetArea()
	atAdaDoc.Position = adaPos

	// 1. Condition unmet: oil gifts < 3
	bad := x.items("POST", "/api/items/heirloom", body(s, "spade-unmet", map[string]any{
		"itemDef":  "ada-garden-spade",
		"progress": atAdaDoc,
	}), c, 409)
	if bad.Error.Code != "condition-unmet" {
		t.Fatalf("expected condition-unmet, got %s", bad.Error.Code)
	}

	// 2. Forged flag test: send ada-oil-gifts:3 in progress without outcomes in DB
	forgedDoc := atAdaDoc
	forgedDoc.Flags = append(slices.Clone(atAdaDoc.Flags), "ada-oil-gifts:3")
	badForged := x.items("POST", "/api/items/heirloom", body(s, "spade-forged", map[string]any{
		"itemDef":  "ada-garden-spade",
		"progress": forgedDoc,
	}), c, 409)
	if badForged.Error.Code != "condition-unmet" {
		t.Fatalf("expected condition-unmet for forged ada-oil-gifts:3 flag, got %s", badForged.Error.Code)
	}
	unknownOil := x.items("POST", "/api/items/ada-oil", body(s, "oil-window", map[string]any{
		"itemDef":  "window-oil",
		"progress": atAdaDoc,
	}), c, 400)
	if unknownOil.Error.Code != "invalid-item" {
		t.Fatalf("expected invalid-item for window-oil, got %s", unknownOil.Error.Code)
	}

	// 3. Proximity test for giveAdaOil: player in Commons cannot give oil
	x.stack(x.account("alice"), "hearth-oil", "", 3)
	x.conserved(x.account("alice"))
	farDoc := atAdaDoc
	farDoc.Area = "commons"
	farDoc.Position = rules.Position{X: 100, Y: 100}
	badOilFar := x.items("POST", "/api/items/ada-oil", body(s, "oil-far", map[string]any{
		"itemDef":  "hearth-oil",
		"progress": farDoc,
	}), c, 409)
	if badOilFar.Error.Code != "too-far-away" {
		t.Fatalf("expected too-far-away, got %s", badOilFar.Error.Code)
	}

	// 4. Give oil without oil in pack -> 409 insufficient-items (tested with a new player bob)
	bc, b := x.ready("bob")
	bDoc := b.State
	bDoc.Area = spot.GetArea()
	bDoc.Position = adaPos
	noOil := x.items("POST", "/api/items/ada-oil", body(b, "oil-none", map[string]any{
		"itemDef":  "hearth-oil",
		"progress": bDoc,
	}), bc, 409)
	if noOil.Error.Code != "insufficient-items" {
		t.Fatalf("expected insufficient-items, got %s", noOil.Error.Code)
	}

	// 5. Alice has 3 hearth-oil. Give oil gift 1 (2 left)
	g1 := x.items("POST", "/api/items/ada-oil", body(s, "oil-1", map[string]any{
		"itemDef":  "hearth-oil",
		"progress": atAdaDoc,
	}), c, 200)
	if g1.Result.AdaOilCount != 1 {
		t.Fatalf("expected AdaOilCount 1, got %d", g1.Result.AdaOilCount)
	}
	if !slices.Contains(g1.State.Flags, "ada-oil-gifts:1") {
		t.Fatalf("expected ada-oil-gifts:1 flag, got %v", g1.State.Flags)
	}
	x.conserved(x.account("alice"))

	// 6. Give oil gift 2 (1 left)
	s.Version = g1.Version
	atAdaDoc.Flags = g1.State.Flags
	g2 := x.items("POST", "/api/items/ada-oil", body(s, "oil-2", map[string]any{
		"itemDef":  "hearth-oil",
		"progress": atAdaDoc,
	}), c, 200)
	if g2.Result.AdaOilCount != 2 {
		t.Fatalf("expected AdaOilCount 2, got %d", g2.Result.AdaOilCount)
	}
	x.conserved(x.account("alice"))

	// Spade still unmet at 2 gifts
	s.Version = g2.Version
	atAdaDoc.Flags = g2.State.Flags
	bad2 := x.items("POST", "/api/items/heirloom", body(s, "spade-unmet-2", map[string]any{
		"itemDef":  "ada-garden-spade",
		"progress": atAdaDoc,
	}), c, 409)
	if bad2.Error.Code != "condition-unmet" {
		t.Fatalf("expected condition-unmet, got %s", bad2.Error.Code)
	}

	// 7. Give oil gift 3 (0 left)
	g3 := x.items("POST", "/api/items/ada-oil", body(s, "oil-3", map[string]any{
		"itemDef":  "hearth-oil",
		"progress": atAdaDoc,
	}), c, 200)
	if g3.Result.AdaOilCount != 3 {
		t.Fatalf("expected AdaOilCount 3, got %d", g3.Result.AdaOilCount)
	}
	x.conserved(x.account("alice"))

	// 8. 4th gift refused: not-needed (even though Alice carries 0 oil! Testing count check runs first)
	s.Version = g3.Version
	atAdaDoc.Flags = g3.State.Flags
	noMore := x.items("POST", "/api/items/ada-oil", body(s, "oil-extra", map[string]any{
		"itemDef":  "hearth-oil",
		"progress": atAdaDoc,
	}), c, 409)
	if noMore.Error.Code != "not-needed" {
		t.Fatalf("expected not-needed with 0 oil in pack, got %s", noMore.Error.Code)
	}

	// Proximity check on spade grant: player in Commons cannot claim spade
	badSpadeFar := x.items("POST", "/api/items/heirloom", body(s, "spade-far", map[string]any{
		"itemDef":  "ada-garden-spade",
		"progress": farDoc,
	}), c, 409)
	if badSpadeFar.Error.Code != "too-far-away" {
		t.Fatalf("expected too-far-away, got %s", badSpadeFar.Error.Code)
	}

	// 9. Condition met: grant spade standing near Ada
	key := "spade-grant-key-1"
	res := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{
		"itemDef":  "ada-garden-spade",
		"progress": atAdaDoc,
	}), c, 200)
	if res.Result.Heirloom != "ada-garden-spade" {
		t.Fatalf("expected heirloom ada-garden-spade, got %s", res.Result.Heirloom)
	}
	if len(res.Result.Created) != 1 {
		t.Fatalf("expected 1 created instance, got %v", res.Result.Created)
	}
	if !slices.Contains(res.State.Flags, "heirloom:ada-garden-spade") {
		t.Fatalf("expected heirloom:ada-garden-spade flag, got %v", res.State.Flags)
	}
	inst := findInstance(res.Result.Items, res.Result.Created[0])
	if inst == nil || inst.ItemDef != "ada-garden-spade" || inst.Condition != 240 || inst.UsesLeft != 80 {
		t.Fatalf("unexpected instance: %+v", inst)
	}

	// 10. Replay with same key returns identical result
	replay := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{
		"itemDef":  "ada-garden-spade",
		"progress": atAdaDoc,
	}), c, 200)
	if replay.Result.Heirloom != "ada-garden-spade" {
		t.Fatalf("replay mismatch: %+v", replay.Result)
	}

	// 11. Subsequent request with new key: already-granted
	s.Version = res.Version
	dup := x.items("POST", "/api/items/heirloom", body(s, "spade-grant-key-2", map[string]any{
		"itemDef":  "ada-garden-spade",
		"progress": atAdaDoc,
	}), c, 409)
	if dup.Error.Code != "already-granted" {
		t.Fatalf("expected already-granted, got %s", dup.Error.Code)
	}

	x.conserved(x.account("alice"))
}

func TestHeirloomNansLamplighterPole(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	// 1. Condition unmet: Nan's echo not settled
	wildsDoc := s.State
	wildsDoc.Area = "wilds"
	wildsDoc.Position = rules.Position{X: 160, Y: 160}
	bad := x.items("POST", "/api/items/heirloom", body(s, "pole-unmet", map[string]any{
		"itemDef":  "nans-lamplighter-pole",
		"progress": wildsDoc,
	}), c, 409)
	if bad.Error.Code != "condition-unmet" {
		t.Fatalf("expected condition-unmet, got %s", bad.Error.Code)
	}

	// 2. Meet condition: Nan's echo settled
	conditionDoc := wildsDoc
	conditionDoc.Flags = append(slices.Clone(wildsDoc.Flags), "echo:nan")
	x.db.DB.Exec("INSERT OR IGNORE INTO story_marks VALUES(?,'echo:nan','server',?)", s.AccountID, x.now.Load())

	// Proximity check: condition met, but player is in village
	villageDoc := conditionDoc
	villageDoc.Area = "village"
	badFar := x.items("POST", "/api/items/heirloom", body(s, "pole-far", map[string]any{
		"itemDef":  "nans-lamplighter-pole",
		"progress": villageDoc,
	}), c, 409)
	if badFar.Error.Code != "too-far-away" {
		t.Fatalf("expected too-far-away, got %s", badFar.Error.Code)
	}

	// 3. Condition met and in Wilds: grant with key
	key := "pole-grant-key-1"
	res := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{
		"itemDef":  "nans-lamplighter-pole",
		"progress": conditionDoc,
	}), c, 200)
	if res.Result.Heirloom != "nans-lamplighter-pole" {
		t.Fatalf("expected heirloom nans-lamplighter-pole, got %s", res.Result.Heirloom)
	}
	if len(res.Result.Created) != 1 {
		t.Fatalf("expected 1 created instance, got %v", res.Result.Created)
	}
	if !slices.Contains(res.State.Flags, "heirloom:nans-lamplighter-pole") {
		t.Fatalf("expected heirloom:nans-lamplighter-pole flag, got %v", res.State.Flags)
	}
	inst := findInstance(res.Result.Items, res.Result.Created[0])
	if inst == nil || inst.ItemDef != "nans-lamplighter-pole" || inst.Condition != 240 || inst.UsesLeft != 80 {
		t.Fatalf("unexpected instance: %+v", inst)
	}

	// 4. Replay with same key
	replay := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{
		"itemDef":  "nans-lamplighter-pole",
		"progress": conditionDoc,
	}), c, 200)
	if replay.Result.Heirloom != "nans-lamplighter-pole" {
		t.Fatalf("replay mismatch: %+v", replay.Result)
	}

	// 5. Subsequent request with new key: already-granted
	s.Version = res.Version
	dup := x.items("POST", "/api/items/heirloom", body(s, "pole-grant-key-2", map[string]any{
		"itemDef":  "nans-lamplighter-pole",
		"progress": conditionDoc,
	}), c, 409)
	if dup.Error.Code != "already-granted" {
		t.Fatalf("expected already-granted, got %s", dup.Error.Code)
	}

	x.conserved(x.account("alice"))
}

func TestHeirloomsNotGiveable(t *testing.T) {
	for _, id := range []string{"brack-felling-axe", "orrins-mason-pick", "ada-garden-spade", "nans-lamplighter-pole"} {
		def, ok := content.ItemFor(id)
		if !ok {
			t.Fatalf("item not found: %s", id)
		}
		if def.Giveable() {
			t.Fatalf("heirloom %s must not be giveable", id)
		}
	}
}

func TestHeirloomSharedStorageRefusal(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	s = x.openWorkshop(c, s)
	axe := x.instance(x.account("alice"), "brack-felling-axe", 240, "")
	x.refresh(c, &s)

	// Depositing non-giveable heirloom into shared storage must be refused with 409 not-giveable
	asset := content.Asset{Kind: "instance", ID: "brack-felling-axe", Qty: 1, Instance: axe}
	bad := x.p5("POST", "/api/storage", body(s, "dep-shared", map[string]any{
		"direction": "deposit",
		"chest":     "shared",
		"asset":     asset,
	}), c, 409)
	if bad.Error.Code != "not-giveable" {
		t.Fatalf("expected not-giveable for shared chest deposit, got %s", bad.Error.Code)
	}

	// Depositing into personal storage is allowed
	ok := x.p5("POST", "/api/storage", body(s, "dep-personal", map[string]any{
		"direction": "deposit",
		"chest":     "personal",
		"asset":     asset,
	}), c, 200)
	if ok.Result.Storage == nil {
		t.Fatalf("expected storage result for personal deposit, got nil")
	}
}
