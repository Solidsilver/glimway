package api

import (
	"glimway/server/internal/chunks"
	"testing"
)

func TestWildsGatherRequiresStoredSpeciesAndReach(t *testing.T) {
	x := newRig(t)
	c, s := x.ready("alice")
	tool := x.instance(s.AccountID, "bench-axe", -1, "")
	fields := gatherIn(s, "wilds", [2]int{20, 20}, tool, "chop", "tangle-tree", "visit")
	x.gatherFixture(s, fields)
	fake := x.api.Config.Chunks.(*chunks.Fake)
	for _, chunk := range fake.Chunks {
		chunk.Decor.Kinds = []string{"iron-oak"}
	}
	req := body(s, "species", fields)
	before := x.expect("GET", "/api/state", nil, c, 200)
	wear := count(t, x.db, "SELECT condition FROM item_instances WHERE id=?", tool)
	ledger := count(t, x.db, "SELECT count(*) FROM ledger")
	if got := x.items("POST", "/api/items/gather", req, c, 409).Error.Code; got != "cannot-gather-here" {
		t.Fatal(got)
	}
	unchanged(t, before.Snapshot, x.expect("GET", "/api/state", nil, c, 200).Snapshot)
	if count(t, x.db, "SELECT condition FROM item_instances WHERE id=?", tool) != wear || count(t, x.db, "SELECT count(*) FROM ledger") != ledger || count(t, x.db, "SELECT count(*) FROM gathering_caps") != 0 {
		t.Fatal("refusal charged gathering")
	}
	for _, chunk := range fake.Chunks {
		chunk.Decor.Kinds = []string{"oak"}
	}
	req["op"].(map[string]any)["key"] = "far"
	req["where"] = map[string]any{"area": "wilds:inner-1", "x": 100, "y": 100}
	if got := x.items("POST", "/api/items/gather", req, c, 409).Error.Code; got != "too-far-away" {
		t.Fatal(got)
	}
	// Refused chops are remembered for replay but cannot prove local felling.
	spade := x.instance(s.AccountID, "bench-spade", -1, "")
	stump := map[string]any{"tool": spade, "action": "dig", "target": "stump", "visitId": "visit", "tile": fields["tile"], "where": fields["where"], "region": fields["region"]}
	if got := x.items("POST", "/api/items/gather", body(s, "refused-chop-stump", stump), c, 409).Error.Code; got != "cannot-gather-here" {
		t.Fatal("refused chop proved stump", got)
	}
	req["op"].(map[string]any)["key"] = "chop"
	req["where"] = fields["where"]
	x.items("POST", "/api/items/gather", req, c, 200)
	fields["tool"] = spade
	fields["action"] = "dig"
	fields["target"] = "stump"
	fields["visitId"] = "another-visit"
	req = body(s, "stump", fields)
	if got := x.items("POST", "/api/items/gather", req, c, 409).Error.Code; got != "cannot-gather-here" {
		t.Fatal("unproven stump", got)
	}
	fields["visitId"] = "visit"
	req = body(s, "proven-stump", fields)
	x.items("POST", "/api/items/gather", req, c, 200)
	if count(t, x.db, "SELECT count(*) FROM gathering_caps") != 2 {
		t.Fatal("valid tree and stump didn't consume their caps")
	}
}
