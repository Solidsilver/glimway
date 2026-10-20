package wilds

import "testing"

// TestHeldPatchSeams: held chunks (pinned to an older wick) stand in a new
// wick as the Tangle does. The new land beside them copies their two edge
// tiles (wider only where a held corner opens), and the access rule holds
// (location-seam.md §0 #8): on every side of every held patch that faces
// new land, each opening (an open edge tile) is reached from the Commons
// gate, and every patch has one. The patches lie beside the lots
// (backland), the Tangle and the town's fixed chunks.
func TestHeldPatchSeams(t *testing.T) {
	S := chunkSize()
	patches := [][][2]int{
		{{-3, 1}, {-3, 2}}, // west lots' backland
		{{3, 1}},           // an east lot's backland
		{{-2, 0}},          // beside the Tangle and the west lots
		{{2, 0}},           // beside the Tangle, the town and the east lots
	}
	for i, ws := range v3Worlds(8) {
		seed, older := ws[0], ws[1]
		season := wickSeason(1795000000 + int64(i)*86400*9)
		stored := map[[2]int]Chunk{}
		for _, p := range patches {
			for _, c := range p {
				stored[c] = mustV3(t, seed, older, c[0], c[1])
			}
		}
		m := buildFrontierStored(t, seed, season, stored, true)
		w := newWorld(WickEpoch(seed, season))
		for c := range stored {
			w.held[c] = true
		}
		copied := 0
		for c, ch := range m.chunks {
			if _, held := stored[c]; held || EpochKindAt(c[0], c[1]) != EpochWick {
				continue
			}
			for i := range ch.Ground {
				tx, ty := c[0]*S+i%S, c[1]*S+i/S
				mx, my, ok := w.seamMirror(tx, ty)
				if !ok {
					continue
				}
				// Open where the kept edge is; wider only one in from a held
				// edge tile that is open (heldThrough), or in a corner block
				// or a throat that the held-corner rule opened.
				open, keptOpen := m.walk[m.i(tx, ty)], m.walk[m.i(mx, my)]
				dx, dy := FloorDiv(mx, S)-c[0], FloorDiv(my, S)-c[1]
				through := (dx == 0 || dy == 0) && m.walk[m.i(mx-dx, my-dy)] && (mx-dx != tx || my-dy != ty)
				if keptOpen && !open || open && !keptOpen && !through && !heldCornerTile(i%S, i/S) {
					t.Fatalf("%s: tile %d,%d doesn't copy the kept %d,%d", seed, tx, ty, mx, my)
				}
				if _, held := stored[[2]int{FloorDiv(mx, S), FloorDiv(my, S)}]; held {
					copied++
				}
			}
		}
		if copied < S*band {
			t.Fatalf("%s: only %d tiles copy a held edge", seed, copied)
		}
		gx, gy := gateTile()
		seen := m.reach(gx, gy)
		// New land is reached wherever it isn't against a held edge: a held
		// edge tile that was open only toward its old neighbour (along the
		// Wend's bank, say) may face a dead end now, with its copy.
		nearHeld := func(tx, ty int) bool {
			for _, d := range [][2]int{{0, 0}, {band, 0}, {-band, 0}, {0, band}, {0, -band}} {
				if _, held := stored[[2]int{FloorDiv(tx+d[0], S), FloorDiv(ty+d[1], S)}]; held {
					return true
				}
			}
			return false
		}
		m.mustReachAllBut(t, seen, nearHeld)
		for _, p := range patches {
			reached := 0
			for _, c := range p {
				for _, d := range dirs4 {
					n := [2]int{c[0] + d[0], c[1] + d[1]}
					if _, held := stored[n]; held || !insideHome(n[0], n[1]) || w.keptAt(n[0], n[1]) {
						continue
					}
					for off := 0; off < S; off++ {
						if ex, ey := edgeTile(c[0], c[1], d[0], d[1], off); seen[m.i(ex, ey)] && seen[m.i(ex+d[0], ey+d[1])] {
							reached++
						}
					}
				}
			}
			if reached == 0 {
				t.Fatalf("%s: held patch %v has no opening onto the new land reached from the gate", seed, p)
			}
		}
	}
}

// mustReachAllBut is mustReachAll given the flood from the gate (seen),
// excusing a piece left out that has a tile where excused says.
func (m *frontierMap) mustReachAllBut(t *testing.T, seen []bool, excused func(tx, ty int) bool) {
	t.Helper()
	seen = append([]bool(nil), seen...)
	for i, open := range m.walk {
		if !open || seen[i] {
			continue
		}
		piece := []int{i}
		seen[i] = true
		ok := false
		for k := 0; k < len(piece); k++ {
			j := piece[k]
			x, y := j%m.W, j/m.W
			if frontierExitTile(m.x0+x, m.y0+y) || excused(m.x0+x, m.y0+y) {
				ok = true
			}
			for _, d := range dirs4 {
				nx, ny := x+d[0], y+d[1]
				if n := ny*m.W + nx; nx >= 0 && ny >= 0 && nx < m.W && ny < m.H && m.walk[n] && !seen[n] {
					seen[n] = true
					piece = append(piece, n)
				}
			}
		}
		if !ok {
			t.Fatalf("%s %s: %d walkable tiles at %d,%d can't be reached from the gate", m.seed, m.season, len(piece), m.x0+i%m.W, m.y0+i/m.W)
		}
	}
}

// TestHeldNeighbourOnlyWhenPassed: a chunk is kept as held only when its
// stored chunk is passed, flagged; unflagged, a wick neighbour is this
// wick's own land, as before.
func TestHeldNeighbourOnlyWhenPassed(t *testing.T) {
	const seed = "v3-1"
	older, season := wickSeason(1790000000), wickSeason(1795000000)
	old := ToProto(mustV3(t, seed, older, -3, 1), epochID)
	plain := mustV3(t, seed, season, -3, 2)
	unflagged, err := GenerateV3(WickEpoch(seed, season), -3, 2, []Kept{{-3, 1, old, false}})
	if err != nil {
		t.Fatal(err)
	}
	if chunkHash(unflagged) != chunkHash(plain) {
		t.Fatal("an unflagged wick neighbour changed the chunk")
	}
	held, err := GenerateV3(WickEpoch(seed, season), -3, 2, []Kept{{-3, 1, old, true}})
	if err != nil {
		t.Fatal(err)
	}
	S := chunkSize()
	for x := range S {
		for k := range band {
			// A copy of the held edge, opened one in where the edge is open.
			want := Walkable(old, x, S-1-k) || k == 1 && Walkable(old, x, S-1)
			if held.Solid[k*S+x] == want && !heldCornerTile(x, k) {
				t.Fatalf("tile %d,%d doesn't mirror the held chunk above", x, k)
			}
		}
	}
}

// heldCornerTile: may the held-corner rule open this tile (chunk-local)? A
// corner block's, or a throat beside one.
func heldCornerTile(lx, ly int) bool {
	S := chunkSize()
	edgeX, edgeY := lx < band || lx >= S-band, ly < band || ly >= S-band
	throat := (lx == band || lx == S-1-band) && (ly == band-1 || ly == S-band)
	return edgeX && edgeY || throat
}
