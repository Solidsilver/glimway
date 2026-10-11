package api

import (
	"testing"

	contract "glimway/server/internal/gen/glimway/v1"
)

// checkWayPath asserts a way's geometry: it runs from a tile touching a to
// one touching b over laid tiles, each tile 4-adjacent to the last, with no
// repeats; it is as short as want (when want > 0); and each sign stands on
// a walkable, unlaid tile beside its own end, off the path.
func checkWayPath(t *testing.T, path [][2]int, signA, signB [2]int, a, b wayPlace, laid, spot func(x, y int) bool, want int) {
	t.Helper()
	if len(path) == 0 || !a.touches(path[0][0], path[0][1]) || !b.touches(path[len(path)-1][0], path[len(path)-1][1]) {
		t.Fatalf("ends %v..%v don't touch their places", path[0], path[len(path)-1])
	}
	if want > 0 && len(path) != want {
		t.Fatalf("path of %d tiles, want %d: %v", len(path), want, path)
	}
	seen := map[[2]int]bool{}
	for i, p := range path {
		if seen[p] || !laid(p[0], p[1]) {
			t.Fatalf("tile %v repeated or not laid", p)
		}
		seen[p] = true
		if i > 0 && intAbs(p[0]-path[i-1][0])+intAbs(p[1]-path[i-1][1]) != 1 {
			t.Fatalf("gap between %v and %v", path[i-1], p)
		}
	}
	beside := func(s, end [2]int) bool { return intAbs(s[0]-end[0])+intAbs(s[1]-end[1]) == 1 }
	if !beside(signA, path[0]) || !beside(signB, path[len(path)-1]) || seen[signA] || seen[signB] || !spot(signA[0], signA[1]) || !spot(signB[0], signB[1]) {
		t.Fatalf("signs %v %v for ends %v %v", signA, signB, path[0], path[len(path)-1])
	}
}

// checkWay is checkWayPath on a stored way.
func checkWay(t *testing.T, way *contract.WildsWay, a, b wayPlace, laid, spot func(x, y int) bool, want int) {
	t.Helper()
	path := make([][2]int, len(way.Path))
	for i, p := range way.Path {
		path[i] = [2]int{int(p.X), int(p.Y)}
	}
	checkWayPath(t, path, [2]int{int(way.SignA.X), int(way.SignA.Y)}, [2]int{int(way.SignB.X), int(way.SignB.Y)}, a, b, laid, spot, want)
}

// Review 1, finding 3: a candidate end that can't take its sign must not
// leak into the next candidate's path. A row is laid from (74,-45) to
// (81,-45); A touches only (74,-45); B (radius 1 around (80,-45)) is first
// reached at (79,-45), whose north and south are solid and east and west
// laid, so no sign fits there. The way is the seven tiles to (80,-45), with
// its signs beside its own ends. Then the same after a lift reroutes it.
func TestWayPathSkipsAnEndWithoutASign(t *testing.T) {
	laidSet := map[[2]int]bool{}
	for x := 74; x <= 81; x++ {
		laidSet[[2]int{x, -45}] = true
	}
	solid := map[[2]int]bool{{79, -46}: true, {79, -44}: true}
	laid := func(x, y int) bool { return laidSet[[2]int{x, y}] }
	spot := func(x, y int) bool { return !solid[[2]int{x, y}] && !laidSet[[2]int{x, y}] }
	a := wayPlace{id: "place:a", x: 71, y: -45, radius: 3}
	b := wayPlace{id: "place:b", x: 80, y: -45, radius: 1}

	path, signA, signB, ok := wayPath(a, b, laid, spot, 600)
	if !ok {
		t.Fatal("no way")
	}
	checkWayPath(t, path, signA, signB, a, b, laid, spot, 7)
	if path[6] != [2]int{80, -45} || signA != [2]int{74, -46} || signB != [2]int{80, -46} {
		t.Fatalf("made %v signs %v %v", path, signA, signB)
	}

	// The reroute: (77,-45) is lifted; a detour north (76..78, -46) stands.
	delete(laidSet, [2]int{77, -45})
	for x := 76; x <= 78; x++ {
		laidSet[[2]int{x, -46}] = true
	}
	path, signA, signB, ok = wayPath(a, b, laid, spot, 600)
	if !ok {
		t.Fatal("no reroute")
	}
	checkWayPath(t, path, signA, signB, a, b, laid, spot, 9)
	if path[len(path)-1] != [2]int{80, -45} {
		t.Fatalf("rerouted %v", path)
	}

	// No end can take a sign: no way, and nothing half-made.
	solid[[2]int{80, -46}], solid[[2]int{80, -44}], solid[[2]int{81, -46}], solid[[2]int{81, -44}], solid[[2]int{82, -45}] = true, true, true, true, true
	if path, _, _, ok = wayPath(a, b, laid, spot, 600); ok || path != nil {
		t.Fatalf("a way with no sign spot: %v", path)
	}
}
