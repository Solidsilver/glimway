package chunks

import (
	"fmt"
	"testing"

	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/wilds"
	"google.golang.org/protobuf/proto"
)

// Exercise the supplied fixed bytes, rather than the generator's authored
// fallback. Every exposed edge mirrors both bands, including closed walls.
func TestTownFixedSeams(t *testing.T) {
	const S = 24
	for seed := range 10 {
		for _, p := range content.PlacesRules.GetFixed() {
			x0, y0, x1, y1 := content.FixedChunks(p)
			for cy := y0; cy <= y1; cy++ {
				for cx := x0; cx <= x1; cx++ {
					fixed := Fixed(FixedEpoch(p.GetLayout(), p.GetRevision()), int32(cx), int32(cy))
					for _, d := range [][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}, {-1, -1}, {-1, 1}, {1, -1}, {1, 1}} {
						nx, ny := cx+d[0], cy+d[1]
						if wilds.FixedFootprintAt(nx, ny) != nil || wilds.EpochKindAt(nx, ny) != wilds.EpochWick {
							continue
						}
						// Side seams take precedence when a diagonal's corner also
						// borders fixed/still ground. Test true diagonal-only corners.
						if d[0] != 0 && d[1] != 0 {
							blocked := false
							for _, side := range [][2]int{{-1, 0}, {1, 0}, {0, -1}, {0, 1}} {
								sx, sy := nx+side[0], ny+side[1]
								if wilds.FixedFootprintAt(sx, sy) != nil || wilds.EpochKindAt(sx, sy) != wilds.EpochWick {
									blocked = true
								}
							}
							if blocked {
								continue
							}
						}
						var kept []wilds.Kept
						for dy := -1; dy <= 1; dy++ {
							for dx := -1; dx <= 1; dx++ {
								if f := wilds.FixedFootprintAt(nx+dx, ny+dy); f != nil {
									kept = append(kept, wilds.Kept{CX: nx + dx, CY: ny + dy, Chunk: Fixed(FixedEpoch(f.GetLayout(), f.GetRevision()), int32(nx+dx), int32(ny+dy))})
								}
							}
						}
						ch, err := wilds.GenerateV3(wilds.WickEpoch(fmt.Sprintf("v3-%d", seed), fmt.Sprintf("t:%d:%d", 1790000000+int64(seed)*86400*9, 1790000000+int64(seed)*86400*9+86400*7)), nx, ny, kept)
						if err != nil {
							t.Fatal(err)
						}
						limit := S
						if d[0] != 0 && d[1] != 0 {
							limit = 2
						}
						for off := 0; off < limit; off++ {
							for band := 0; band < 2; band++ {
								fx, fy, gx, gy := off, off, off, off
								if d[0] < 0 {
									fx, gx = band, S-1-band
								}
								if d[0] > 0 {
									fx, gx = S-1-band, band
								}
								if d[1] < 0 {
									fy, gy = band, S-1-band
								}
								if d[1] > 0 {
									fy, gy = S-1-band, band
								}
								if d[0] != 0 && d[1] != 0 {
									if d[1] < 0 {
										fy, gy = off, S-1-off
									} else {
										fy, gy = S-1-off, off
									}
								}
								if !ch.Solid[gy*S+gx] != wilds.Walkable(fixed, fx, fy) {
									t.Fatalf("seed %d %s edge %v at %d band %d differs", seed, p.GetId(), d, off, band)
								}
							}
						}
					}
				}
			}
		}
	}
}

// Kept bytes are authoritative; T4 supplies a world-specific plot base.
func TestTownSeamUsesSuppliedBytes(t *testing.T) {
	epoch := FixedEpoch("hearthwick", content.Layouts["hearthwick"].GetRevision())
	fixed := proto.Clone(Fixed(epoch, 0, 4)).(*contract.WorldChunk)
	// A trunk on the town's south rim.
	x := 0
	for x < 24 && wilds.Walkable(fixed, x, 23) {
		x++
	}
	if x == 24 {
		t.Fatal("no wall on the fixture's south edge")
	}
	i := 23*24 + x
	fixed.Solid[i/8] &^= 1 << uint(i%8)
	ch, err := wilds.GenerateV3(wilds.WickEpoch("stored-edge", "t:100:200"), 0, 5, []wilds.Kept{{CX: 0, CY: 4, Chunk: fixed}})
	if err != nil {
		t.Fatal(err)
	}
	if !wilds.Walkable(fixed, x, 23) || wilds.Walkable(Fixed(epoch, 0, 4), x, 23) {
		t.Fatal("supplied edit mutated shared fixed cache")
	}
	if ch.Solid[x] {
		t.Fatal("authored fallback replaced supplied fixed edge")
	}
}
