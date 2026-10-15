package wilds

import "testing"

// The seams beside the fixed block (hearthwick-2.md §5), over whole
// frontiers.

// TestV3SoftBand: in front of every open fixed edge tile the first generated
// tile is open (a lot's back never faces a wall); in the soft band at most
// one tile in each run of four is solid and never two side by side along
// the edge; past it the woods thin toward the block instead of standing at
// a straight wall.
func TestV3SoftBand(t *testing.T) {
	woods := landIndex("woods")
	var near, nearN, far, farN int
	for _, ws := range v3Worlds(6) {
		m := buildFrontier(t, ws[0], ws[1])
		w := newWorld(WickEpoch(ws[0], ws[1]))
		type run struct{ dx, dy, run int }
		solids := map[run]int{}
		for k, s := range seams().soft {
			if !m.in(k[0], k[1]) {
				continue
			}
			open := m.walkable(k[0], k[1])
			switch s.depth {
			case 1:
				if !open {
					t.Fatalf("%s: %d,%d walls an open fixed edge", ws[0], k[0], k[1])
				}
			case softDepth:
				if open {
					continue
				}
				solids[run{s.dx, s.dy, floorDiv(s.along, 4)}]++
				nx, ny := k[0]+s.dy, k[1]+s.dx // the next along the edge
				if n, ok := seams().soft[[2]int{nx, ny}]; ok && n.depth == softDepth && n.dx == s.dx && n.dy == s.dy && !m.walkable(nx, ny) {
					t.Fatalf("%s: two solid side by side in the soft band at %d,%d", ws[0], k[0], k[1])
				}
			}
		}
		for r, n := range solids {
			if n > 1 {
				t.Fatalf("%s: %d solid in one run of four of the soft band %v", ws[0], n, r)
			}
		}
		// Woods beside the west lot backs: depth 3..5 against 10..16.
		for ty := 26; ty < 118; ty++ {
			for d := softDepth; d <= 16; d++ {
				tx := -48 - d
				if s, ok := seams().soft[[2]int{tx, ty}]; (ok && s.depth != d) || (!ok && d <= featherDepth) || w.landOne(tx, ty) != woods {
					continue
				}
				solid := 0
				if !m.walkable(tx, ty) {
					solid = 1
				}
				switch {
				case d <= 5:
					near, nearN = near+solid, nearN+1
				case d >= 10:
					far, farN = far+solid, farN+1
				}
			}
		}
	}
	t.Logf("woods solid: depth 3..5 %d/%d, depth 10..16 %d/%d", near, nearN, far, farN)
	if nearN == 0 || farN == 0 || near*farN*3 >= far*nearN*2 {
		t.Fatalf("the woods don't thin toward the lot backs: depth 3..5 %d/%d solid, 10..16 %d/%d", near, nearN, far, farN)
	}
}

// TestV3LotVerges: the footpaths between neighbouring lots run from the Lot
// Row lane, between the lots' fences, out past the backs into the Wilds.
// They open on chunk seams, where the edge band would shut a two-tile way
// in a few tiles out (about one world in thirty before each got a route).
func TestV3LotVerges(t *testing.T) {
	for _, ws := range v3Worlds(24) {
		m := buildFrontier(t, ws[0], ws[1])
		for _, y := range []int{47, 48, 95, 96} {
			for _, side := range []struct{ lane, back, out int }{{-23, -48, -1}, {46, 71, 1}} {
				seen := m.reach(side.lane, y)
				if !seen[m.i(side.back, y)] || !seen[m.i(side.back+side.out, y)] {
					t.Fatalf("%s: the verge at y %d doesn't reach the Wilds past %d", ws[0], y, side.back)
				}
				deep := false
				for dy := -4; dy <= 4 && !deep; dy++ {
					deep = seen[m.i(side.back+side.out*(softDepth+2), y+dy)]
				}
				if !deep {
					t.Fatalf("%s: the verge at y %d stops at a wall behind %d", ws[0], y, side.back)
				}
			}
		}
	}
}

// TestV3KeepOut: no camp (so no enemy) and no dealt site stands within
// keepOutTiles of an open fixed edge, and the keep-out covers every lot
// back, both wildgates and the town's south mouths.
func TestV3KeepOut(t *testing.T) {
	for _, mouth := range [][2]int{{-49, 30}, {72, 100}, {-49, 71}, {72, 72}, {12, 120}, {-23, 120}, {46, 120}} {
		for _, d := range [][2]int{{0, 0}, {-5, 0}, {5, 0}, {0, 5}} {
			x, y := mouth[0]+d[0], mouth[1]+d[1]
			if FixedFootprintAt(floorDiv(x, chunkSize()), floorDiv(y, chunkSize())) == nil && !keptOut(x, y) {
				t.Fatalf("%d,%d beside the mouth %v isn't kept out", x, y, mouth)
			}
		}
	}
	dealt := map[SiteKind]bool{}
	for _, p := range contentRules().Places {
		for _, s := range p.GetDealt() {
			dealt[SiteKind(s.GetKind())] = true
		}
	}
	S := chunkSize()
	camps := 0
	for _, ws := range v3Worlds(6) {
		m := buildFrontier(t, ws[0], ws[1])
		for _, ch := range m.chunks {
			for _, e := range ch.Entities {
				if e.Kind != kindCamp && len(e.Enemies) == 0 {
					continue
				}
				camps++
				if keptOut(ch.CX*S+e.TX, ch.CY*S+e.TY) {
					t.Fatalf("%s: %s in the keep-out", ws[0], e.ID)
				}
			}
			for _, s := range ch.Sites {
				if dealt[s.Kind] && keptOut(ch.CX*S+s.TX, ch.CY*S+s.TY) {
					t.Fatalf("%s: dealt site %s in the keep-out", ws[0], s.ID)
				}
			}
		}
	}
	if camps == 0 {
		t.Fatal("no camps at all")
	}
}

// TestV3SideLean: beside the block the land leans to the lots' sides, woods
// west and meadow east, and fades out over ring 1.
func TestV3SideLean(t *testing.T) {
	woods, meadow := landIndex("woods"), landIndex("meadow")
	if woods != sideWoods || meadow != sideMeadow {
		t.Fatalf("side lands %d %d, homestead sides %d %d", woods, meadow, sideWoods, sideMeadow)
	}
	ring := int(contentRules().GetTierRingChunks()) * chunkSize()
	type share struct{ hit, n int }
	var west, east [3]share
	for _, ws := range v3Worlds(10) {
		w := newWorld(WickEpoch(ws[0], ws[1]))
		for ty := 24; ty < 120; ty += 2 {
			for d := 1; d <= ring; d += 3 {
				band := (d - 1) * 3 / ring
				if w.landOne(-48-d, ty) == woods {
					west[band].hit++
				}
				if w.landOne(71+d, ty) == meadow {
					east[band].hit++
				}
				west[band].n++
				east[band].n++
			}
		}
	}
	pc := func(s share) int { return s.hit * 100 / s.n }
	t.Logf("woods west %d%% %d%% %d%%, meadow east %d%% %d%% %d%%", pc(west[0]), pc(west[1]), pc(west[2]), pc(east[0]), pc(east[1]), pc(east[2]))
	for _, side := range [][3]share{west, east} {
		if pc(side[0]) < 75 || pc(side[0]) < pc(side[2])+20 {
			t.Fatalf("no lean beside the block: %d%% near, %d%% at ring 1's edge", pc(side[0]), pc(side[2]))
		}
	}
	// Outside ring 1 nothing leans.
	for _, ws := range v3Worlds(3) {
		w := newWorld(WickEpoch(ws[0], ws[1]))
		for _, tx := range []int{-48 - ring - 1, 71 + ring + 1, -200, 300} {
			for ty := -100; ty < 200; ty += 7 {
				if _, ok := w.sideLean(tx, ty); ok {
					t.Fatalf("lean at %d,%d, past ring 1", tx, ty)
				}
			}
		}
	}
}

// The soft band, the feather and the keep-out lie on generated wick ground
// only, never in a fixed or still chunk.
func TestSeamsOnWickGround(t *testing.T) {
	S := chunkSize()
	var tiles [][2]int
	for k := range seams().soft {
		tiles = append(tiles, k)
	}
	for k := range seams().keepOut {
		tiles = append(tiles, k)
	}
	for _, k := range tiles {
		cx, cy := floorDiv(k[0], S), floorDiv(k[1], S)
		if FixedFootprintAt(cx, cy) != nil || EpochKindAt(cx, cy) != EpochWick {
			t.Fatalf("seam tile %v off wick ground", k)
		}
	}
	// The Wend's centre keeps riverMargin tiles (plus its widest half) west
	// of the west lots; its banks must stay clear of the feather too.
	maxWidth := int(contentRules().GetRiver().GetMaxWidth())
	if (riverMargin+(maxWidth+1)/2-featherDepth)*fp <= maxWidth*fp/2+bankWidth {
		t.Fatalf("riverMargin %d lets the Wend's banks into the %d-tile feather", riverMargin, featherDepth)
	}
	if b := fixedBlocks(); len(b) != 1 || b[0] != tileBox(-48, 24, 71, 119) {
		t.Fatalf("the fixed places make blocks %v, want the one 5×4 block", b)
	}
}
