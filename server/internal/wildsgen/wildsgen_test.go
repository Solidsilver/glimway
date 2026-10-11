package wildsgen

import (
	"testing"

	"glimway/server/internal/chunks"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/wilds"
)

// TestGlimpsesMatchOneByOne: the batch answers, in order, what
// wilds.Glimpse answers chunk by chunk.
func TestGlimpsesMatchOneByOne(t *testing.T) {
	e := &contract.WildsEpoch{Id: "e", WorldSeed: "glimpse", Kind: wilds.EpochWick, GeneratorVersion: wilds.GeneratorV3, Season: "t:1795000000:1796209600"}
	var at []chunks.ChunkXY
	for cy := int32(-10); cy <= 0; cy++ {
		for cx := int32(-6); cx <= 6; cx += 2 {
			at = append(at, chunks.ChunkXY{CX: cx, CY: cy})
		}
	}
	got, err := V3{}.Glimpses(e, at)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != len(at) {
		t.Fatalf("%d glimpses for %d chunks", len(got), len(at))
	}
	rivers := 0
	for i, c := range at {
		land, river := wilds.Glimpse(Epoch(e), int(c.CX), int(c.CY))
		if got[i].Land != land || got[i].River != river {
			t.Fatalf("chunk %v: batch %+v, one by one %s %v", c, got[i], land, river)
		}
		if river {
			rivers++
		}
	}
	if rivers == 0 {
		t.Fatal("no glimpse saw the Wend")
	}
	if empty, err := (V3{}).Glimpses(e, nil); err != nil || len(empty) != 0 {
		t.Fatalf("no chunks: %v %v", empty, err)
	}
}
