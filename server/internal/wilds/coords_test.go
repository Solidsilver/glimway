package wilds

import (
	"encoding/json"
	"os"
	"testing"
)

// coordVectors is content/vectors/wilds-coords.json, the cases
// tests/wilds-coords.test.ts replays too.
type coordVectors struct {
	ChunkOf []struct {
		Tile, Chunk, Local [2]int
	}
	TileOfPixel []struct {
		Pixel [2]float64
		Tile  [2]int
	}
	Chunks []struct {
		Chunk     [2]int
		Footprint string
		Tier      int
		EpochKind string
		Inside    bool
		Ring      int
		Cell      [2]int
	}
	Border struct {
		Chunks          int
		Inside, Outside [][2]int
	}
}

func readCoordVectors(t *testing.T) coordVectors {
	t.Helper()
	raw, err := os.ReadFile("../../../content/vectors/wilds-coords.json")
	if err != nil {
		t.Fatal(err)
	}
	var v coordVectors
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestCoordVectors(t *testing.T) {
	v := readCoordVectors(t)
	for _, c := range v.ChunkOf {
		cx, cy := ChunkOf(c.Tile[0], c.Tile[1])
		lx, ly := LocalOf(c.Tile[0], c.Tile[1])
		if [2]int{cx, cy} != c.Chunk || [2]int{lx, ly} != c.Local {
			t.Errorf("tile %v: chunk %d,%d local %d,%d; want %v %v", c.Tile, cx, cy, lx, ly, c.Chunk, c.Local)
		}
	}
	for _, c := range v.TileOfPixel {
		if tx, ty := TileOfPixel(c.Pixel[0], c.Pixel[1]); [2]int{tx, ty} != c.Tile {
			t.Errorf("pixel %v: tile %d,%d; want %v", c.Pixel, tx, ty, c.Tile)
		}
	}
	for _, c := range v.Chunks {
		cx, cy := c.Chunk[0], c.Chunk[1]
		fp := ""
		if p := FootprintAt(cx, cy); p != nil {
			fp = p.GetId()
		}
		x, y := CellOf(cx, cy)
		if fp != c.Footprint || Tier(cx, cy) != c.Tier || EpochKindAt(cx, cy) != c.EpochKind || Ring(cx, cy) != c.Ring || [2]int{x, y} != c.Cell || InsideBorder(cx, cy) != c.Inside {
			t.Errorf("chunk %v: footprint %q tier %d epoch %s ring %d cell %d,%d", c.Chunk, fp, Tier(cx, cy), EpochKindAt(cx, cy), Ring(cx, cy), x, y)
		}
	}
	if v.Border.Chunks != BorderChunks() {
		t.Errorf("border %d chunks; content %d", v.Border.Chunks, BorderChunks())
	}
	for _, c := range v.Border.Inside {
		if !InsideBorder(c[0], c[1]) {
			t.Errorf("%v: past the border", c)
		}
	}
	for _, c := range v.Border.Outside {
		if InsideBorder(c[0], c[1]) {
			t.Errorf("%v: inside the border", c)
		}
	}
}

func TestFloorDiv(t *testing.T) {
	for _, c := range [][3]int{{0, 24, 0}, {23, 24, 0}, {24, 24, 1}, {-1, 24, -1}, {-24, 24, -1}, {-25, 24, -2}, {-48, 24, -2}} {
		if got := FloorDiv(c[0], c[1]); got != c[2] {
			t.Errorf("FloorDiv(%d, %d) = %d, want %d", c[0], c[1], got, c[2])
		}
	}
}

func TestFootprintCells(t *testing.T) {
	if !FootprintCell(0, 1) || !FootprintCell(-1, 1) || !FootprintCell(-1, 2) || !FootprintCell(0, 0) || !FootprintCell(0, -1) || FootprintCell(1, 0) || FootprintCell(0, -2) {
		t.Fatal("generated and authored footprints reserve their intersecting cells")
	}
	if CellPlaceID(-1, 2) != "place:-1:2" {
		t.Fatal(CellPlaceID(-1, 2))
	}
}
