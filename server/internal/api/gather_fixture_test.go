package api

import (
	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/rules"
	"glimway/server/internal/wilds"
)

// Budget/yield tests use explicit geometry fakes; geometry validation has its own tests.
func (x *rig) gatherFixture(s response, fields map[string]any) {
	doc, ok := fields["progress"].(rules.State)
	if !ok || doc.Area != "wilds" {
		return
	}
	// Tiles are world tiles: the Tangle's chunk (0,0) holds 0..23 each way;
	// "whitequiet" moves the gather four chunks north, into the Whitequiet.
	region := "tangle"
	if v, ok := fields["region"].(string); ok {
		region = v
	}
	tile, ok := fields["tile"].([2]int)
	if !ok {
		tile = [2]int{int(doc.Position.X / 16), int((doc.Position.Y - 8) / 16)}
	}
	if region == "whitequiet" {
		tile[1] -= 4 * 24
		doc.Position.Y -= 4 * 24 * 16
	}
	kind, _ := fields["target"].(string)
	if kind == "tangle-tree" || kind == "tree" {
		kind = "oak"
	}
	if kind == "lamp-stone" {
		kind = "cairn"
	}
	if kind == "willow" {
		kind = "snag"
	}
	if kind == "herbs" || kind == "bloom-patch" {
		kind = "flowers"
	}
	if kind == "sapling" {
		kind = "fern"
	}
	if kind == "hollow-tree" {
		kind = "log"
	}
	size := 24
	cx, cy := wilds.FloorDiv(tile[0], size), wilds.FloorDiv(tile[1], size)
	id := "gather-fixture"
	epoch := &contract.WildsEpoch{Id: id, Kind: wilds.EpochKindAt(cx, cy), GeneratorVersion: 3, StartsAt: float64(x.now.Load())}
	x.api.Config.Epochs = &chunks.FakeEpochs{Values: map[chunks.EpochKey]*contract.WildsEpoch{{World: s.WorldID, Kind: epoch.Kind}: epoch}}
	x.api.Config.Chunks = &chunks.Fake{Chunks: map[chunks.Key]*contract.WildsChunk{{World: s.WorldID, Epoch: id, CX: int32(cx), CY: int32(cy)}: {EpochId: id, Size: 24, Cx: int32(cx), Cy: int32(cy), Decor: &contract.DecorList{Kinds: []string{kind}, Kind: []uint32{0}, Tx: []uint32{uint32(tile[0] - cx*size)}, Ty: []uint32{uint32(tile[1] - cy*size)}}}}}
	fields["tile"] = tile
	fields["where"] = testWhere(doc)
	delete(fields, "progress")
}
