package wilds

import (
	"reflect"
	"testing"
)

// TestLandformLastsAcrossSeasons: lasting geography (roadmap "Land: the
// three tiers"). Two wicks of one world, and its still epoch, draw the same
// land cells, sizes and border warp, and two wicks run the same Wend; in
// the generated frontier every chunk has the same main land and the same
// river water (water or ford: where the fords lie follows that wick's
// routes; ponds are detail). Another world's seed moves the landform.
func TestLandformLastsAcrossSeasons(t *testing.T) {
	const seasonA, seasonB = "t:1789948800:1790553600", "t:1795000000:1796209600"
	S := chunkSize()
	for _, seed := range []string{"v3-0", "oak-7"} {
		a, b, still := newWorld(WickEpoch(seed, seasonA)), newWorld(WickEpoch(seed, seasonB)), newWorld(StillEpoch(seed))
		for ly := -4; ly <= 4; ly++ {
			for lx := -4; lx <= 4; lx++ {
				pa := a.landPoint(lx, ly)
				if pb, ps := b.landPoint(lx, ly), still.landPoint(lx, ly); pa != pb || pa != ps {
					t.Fatalf("%s: land cell %d,%d is %+v, %+v in another wick, %+v in the still epoch", seed, lx, ly, pa, pb, ps)
				}
			}
		}
		if !reflect.DeepEqual(a.river.line, b.river.line) {
			t.Fatalf("%s: the Wend runs another course in another wick", seed)
		}
		for _, p := range []pt{tileCentre(-90, 40), tileCentre(17, -130)} {
			if a.warped(p.tile()) != b.warped(p.tile()) || a.warped(p.tile()) != still.warped(p.tile()) {
				t.Fatalf("%s: land borders warp another way in another epoch", seed)
			}
		}
		ma, mb := buildFrontier(t, seed, seasonA), buildFrontier(t, seed, seasonB)
		wet := func(k baseKind) bool { return k == bWater || k == bFord }
		for c, ca := range ma.chunks {
			if EpochKindAt(c[0], c[1]) != EpochWick {
				continue
			}
			cb := mb.chunks[c]
			if ca.Land != cb.Land {
				t.Fatalf("%s: chunk %d,%d is %s, then %s", seed, c[0], c[1], ca.Land, cb.Land)
			}
			x0, y0 := c[0]*S, c[1]*S
			ba, bb := a.fill(x0, y0, x0+S-1, y0+S-1, nil), b.fill(x0, y0, x0+S-1, y0+S-1, nil)
			for i := range ba {
				if wet(ba[i].kind) != wet(bb[i].kind) {
					t.Fatalf("%s: chunk %d,%d tile %d,%d is water in one wick, not the other", seed, c[0], c[1], i%S, i/S)
				}
			}
		}
	}
	if reflect.DeepEqual(newWorld(WickEpoch("v3-0", seasonA)).river.line, newWorld(WickEpoch("oak-7", seasonA)).river.line) {
		t.Fatal("two worlds share one Wend")
	}
}
