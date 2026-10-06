package api

import (
	"fingersnap/content"
	"slices"
	"testing"
)

// Tests for the four heirloom tools (BRIEF.md):
//  1. Brack felling axe — Silas (Hollis's name known)
//  2. Orrin's mason pick — Orrin (north bridge mended)
//  3. Ada's garden spade — Ada (brought window oil 3 times)
//  4. Nan's lamplighter pole — Nan's settled echo camp
//
// Rules verified per grant:
//  - Condition unmet -> refused (409 condition-unmet)
//  - Condition met -> granted once (200 OK, instanced, ledgered, flag set)
//  - Replay with same key -> same answer (idem)
//  - Subsequent request with new key -> refused (409 already-granted)
//  - Not giveable or sellable

func TestHeirloomBrackFellingAxe(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	// 1. Condition unmet: Hollis's name unknown
	bad := x.items("POST", "/api/items/heirloom", body(s, "axe-unmet", map[string]any{"itemDef": "brack-felling-axe"}), c, 409)
	if bad.Error.Code != "condition-unmet" {
		t.Fatalf("expected condition-unmet, got %s", bad.Error.Code)
	}

	// 2. Meet condition: player learns Hollis's name (e.g. read paper ashwatch-ledger-excerpts)
	doc := s.State
	doc.Flags = append(doc.Flags, "paper:ashwatch-ledger-excerpts")
	x.expect("PUT", "/api/progress", mutation(s, doc), c, 200)
	x.refresh(c, &s)

	// 3. Condition met: grant with key
	key := "axe-grant-key-1"
	res := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{"itemDef": "brack-felling-axe"}), c, 200)
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

	// 4. Replay with same key returns identical successful result
	replay := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{"itemDef": "brack-felling-axe"}), c, 200)
	if replay.Result.Heirloom != "brack-felling-axe" || len(replay.Result.Created) != 1 {
		t.Fatalf("replay mismatch: %+v", replay.Result)
	}

	// 5. Subsequent request with new key is refused: already granted
	s.Rev = res.Rev
	dup := x.items("POST", "/api/items/heirloom", body(s, "axe-grant-key-2", map[string]any{"itemDef": "brack-felling-axe"}), c, 409)
	if dup.Error.Code != "already-granted" {
		t.Fatalf("expected already-granted, got %s", dup.Error.Code)
	}

	// 6. Conservation check (ledger matches held instances)
	x.conserved("alice")
}

func TestHeirloomOrrinsMasonPick(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	// 1. Condition unmet: north bridge not mended
	bad := x.items("POST", "/api/items/heirloom", body(s, "pick-unmet", map[string]any{"itemDef": "orrins-mason-pick"}), c, 409)
	if bad.Error.Code != "condition-unmet" {
		t.Fatalf("expected condition-unmet, got %s", bad.Error.Code)
	}

	// 2. Meet condition: north bridge mended
	doc := s.State
	doc.Flags = append(doc.Flags, "project:north-bridge:complete")
	x.expect("PUT", "/api/progress", mutation(s, doc), c, 200)
	x.refresh(c, &s)

	// 3. Condition met: grant with key
	key := "pick-grant-key-1"
	res := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{"itemDef": "orrins-mason-pick"}), c, 200)
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

	// 4. Replay with same key returns identical result
	replay := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{"itemDef": "orrins-mason-pick"}), c, 200)
	if replay.Result.Heirloom != "orrins-mason-pick" {
		t.Fatalf("replay mismatch: %+v", replay.Result)
	}

	// 5. Subsequent request with new key: already-granted
	s.Rev = res.Rev
	dup := x.items("POST", "/api/items/heirloom", body(s, "pick-grant-key-2", map[string]any{"itemDef": "orrins-mason-pick"}), c, 409)
	if dup.Error.Code != "already-granted" {
		t.Fatalf("expected already-granted, got %s", dup.Error.Code)
	}

	x.conserved("alice")
}

func TestHeirloomAdaGardenSpadeAndOil(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	// 1. Condition unmet: oil gifts < 3
	bad := x.items("POST", "/api/items/heirloom", body(s, "spade-unmet", map[string]any{"itemDef": "ada-garden-spade"}), c, 409)
	if bad.Error.Code != "condition-unmet" {
		t.Fatalf("expected condition-unmet, got %s", bad.Error.Code)
	}

	// 2. Give oil without oil in pack -> 409 insufficient-items
	noOil := x.items("POST", "/api/items/ada-oil", body(s, "oil-none", map[string]any{"itemDef": "hearth-oil"}), c, 409)
	if noOil.Error.Code != "insufficient-items" {
		t.Fatalf("expected insufficient-items, got %s", noOil.Error.Code)
	}

	// Put 4 hearth-oil in pack
	x.stack("alice", "hearth-oil", "", 4)
	x.conserved("alice")

	// 3. Give oil gift 1
	g1 := x.op(c, &s, "ada-oil", map[string]any{"itemDef": "hearth-oil"}, 200)
	if g1.Result.AdaOilCount != 1 {
		t.Fatalf("expected AdaOilCount 1, got %d", g1.Result.AdaOilCount)
	}
	if !slices.Contains(g1.State.Flags, "ada-oil-gifts:1") {
		t.Fatalf("expected ada-oil-gifts:1 flag, got %v", g1.State.Flags)
	}
	x.conserved("alice")

	// 4. Give oil gift 2
	g2 := x.op(c, &s, "ada-oil", map[string]any{"itemDef": "hearth-oil"}, 200)
	if g2.Result.AdaOilCount != 2 {
		t.Fatalf("expected AdaOilCount 2, got %d", g2.Result.AdaOilCount)
	}
	x.conserved("alice")

	// 5. Spade still unmet at 2 gifts
	s.Rev = g2.Rev
	bad2 := x.items("POST", "/api/items/heirloom", body(s, "spade-unmet-2", map[string]any{"itemDef": "ada-garden-spade"}), c, 409)
	if bad2.Error.Code != "condition-unmet" {
		t.Fatalf("expected condition-unmet, got %s", bad2.Error.Code)
	}

	// 6. Give oil gift 3
	g3 := x.op(c, &s, "ada-oil", map[string]any{"itemDef": "hearth-oil"}, 200)
	if g3.Result.AdaOilCount != 3 {
		t.Fatalf("expected AdaOilCount 3, got %d", g3.Result.AdaOilCount)
	}
	x.conserved("alice")

	// 7. 4th gift refused: not needed
	noMore := x.items("POST", "/api/items/ada-oil", body(s, "oil-extra", map[string]any{"itemDef": "hearth-oil"}), c, 409)
	if noMore.Error.Code != "not-needed" {
		t.Fatalf("expected not-needed, got %s", noMore.Error.Code)
	}

	// 8. Condition met: grant spade
	key := "spade-grant-key-1"
	s.Rev = g3.Rev
	res := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{"itemDef": "ada-garden-spade"}), c, 200)
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

	// 9. Replay with same key returns identical result
	replay := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{"itemDef": "ada-garden-spade"}), c, 200)
	if replay.Result.Heirloom != "ada-garden-spade" {
		t.Fatalf("replay mismatch: %+v", replay.Result)
	}

	// 10. Subsequent request with new key: already-granted
	s.Rev = res.Rev
	dup := x.items("POST", "/api/items/heirloom", body(s, "spade-grant-key-2", map[string]any{"itemDef": "ada-garden-spade"}), c, 409)
	if dup.Error.Code != "already-granted" {
		t.Fatalf("expected already-granted, got %s", dup.Error.Code)
	}

	x.conserved("alice")
}

func TestHeirloomNansLamplighterPole(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")

	// 1. Condition unmet: Nan's echo not settled
	bad := x.items("POST", "/api/items/heirloom", body(s, "pole-unmet", map[string]any{"itemDef": "nans-lamplighter-pole"}), c, 409)
	if bad.Error.Code != "condition-unmet" {
		t.Fatalf("expected condition-unmet, got %s", bad.Error.Code)
	}

	// 2. Meet condition: Nan's echo settled
	doc := s.State
	doc.Flags = append(doc.Flags, "echo:nan")
	x.expect("PUT", "/api/progress", mutation(s, doc), c, 200)
	x.refresh(c, &s)

	// 3. Condition met: grant with key
	key := "pole-grant-key-1"
	res := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{"itemDef": "nans-lamplighter-pole"}), c, 200)
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
	replay := x.items("POST", "/api/items/heirloom", body(s, key, map[string]any{"itemDef": "nans-lamplighter-pole"}), c, 200)
	if replay.Result.Heirloom != "nans-lamplighter-pole" {
		t.Fatalf("replay mismatch: %+v", replay.Result)
	}

	// 5. Subsequent request with new key: already-granted
	s.Rev = res.Rev
	dup := x.items("POST", "/api/items/heirloom", body(s, "pole-grant-key-2", map[string]any{"itemDef": "nans-lamplighter-pole"}), c, 409)
	if dup.Error.Code != "already-granted" {
		t.Fatalf("expected already-granted, got %s", dup.Error.Code)
	}

	x.conserved("alice")
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
