package chunks

import (
	"fmt"
	"glimway/content"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/land"
	"google.golang.org/protobuf/proto"
	"strconv"
	"strings"
)

// PlotRevision changes only with a deliberately versioned plot-byte format.
const PlotRevision = 2

// InsideLot excludes the public lane and fence bands; the gate row belongs inside.
func InsideLot(x, y int) bool {
	return x >= 3 && x <= 20 && (y >= 2 && y <= 18 || y == 19 && x >= 11 && x <= 12)
}

// Lot origins and epoch identity keep immutable land separate from home overlays.
func LotAt(cx, cy int) int {
	if cx < -3 || cx > -2 || cy < 1 || cy > 4 {
		return -1
	}
	return (cy-1)*2 + cx + 3
}
func LotOrigin(gate int) (int, int) { return -72 + (gate%2)*24, 24 + (gate/2)*24 }
func PlotEpoch(world string, gate int) string {
	return fmt.Sprintf("plot:%s:%d@%d", world, gate, PlotRevision)
}
func PlotIdentity(epoch string) (string, int, bool) {
	rest, ok := strings.CutPrefix(epoch, "plot:")
	if !ok {
		return "", 0, false
	}
	rest, ok = strings.CutSuffix(rest, fmt.Sprintf("@%d", PlotRevision))
	if !ok {
		return "", 0, false
	}
	i := strings.LastIndex(rest, ":")
	if i < 1 {
		return "", 0, false
	}
	g, err := strconv.Atoi(rest[i+1:])
	return rest[:i], g, err == nil && g >= 0 && g < 8 && strconv.Itoa(g) == rest[i+1:]
}

// Plot composes only the private interior over the authored public lanes and mouths.
// The seed is world/lot/generator-specific; no mutable home state enters its bytes.
func Plot(world string, gate int) *contract.WorldChunk {
	if world == "" || gate < 0 || gate >= 8 {
		return nil
	}
	x0, y0 := LotOrigin(gate)
	cx, cy := int32(x0/24), int32(y0/24)
	base := Fixed(FixedEpoch("homestead-lots", PlotRevision), cx, cy)
	if base == nil {
		return nil
	}
	c := proto.Clone(base).(*contract.WorldChunk)
	c.EpochId = PlotEpoch(world, gate)
	c.Look = "tangle"
	l := land.Generate(land.Seed(world, gate, content.HomeRules.GetLand()), content.HomeRules.GetLand())
	// These names are the curated equivalents of the Tangle's grass, moss and water.
	for _, p := range []string{"grass_a", "grass_b", "dirt", "water_a"} {
		found := false
		for _, v := range c.Palette {
			if v == p {
				found = true
			}
		}
		if !found {
			c.Palette = append(c.Palette, p)
		}
	}
	index := func(p string) byte {
		for i, v := range c.Palette {
			if v == p {
				return byte(i)
			}
		}
		panic(p)
	}
	for y := 1; y <= 18; y++ {
		for x := 3; x <= 20; x++ {
			// The outer two bands are the generator's authoritative closed seam.
			if cy == 1 && y == 1 {
				continue
			}
			k := l.At(x, y)
			p := "grass_a"
			blocked := !land.Buildable(k) && k != land.Ford
			switch k {
			case land.Tree, land.Edge:
				p = "grass_b"
			case land.Stump, land.Boulder, land.Slope:
				p = "dirt"
			case land.Water:
				p = "water_a"
			case land.Path, land.Ford:
				p = "dirt"
			}
			i := y*24 + x
			shift := uint(4 * (i % 2))
			c.Ground[i/2] = (c.Ground[i/2] &^ (15 << shift)) | index(p)<<shift
			c.Solid[i/8] &^= 1 << uint(i%8)
			if blocked {
				c.Solid[i/8] |= 1 << uint(i%8)
			}
			if land.Clearable(k) {
				target, frame := "tree", "oak-0"
				if k == land.Boulder {
					target, frame = "boulder", "boulder-0"
				}
				if k == land.Stump {
					target, frame = "stump", "stump-0"
				}
				c.Objects = append(c.Objects, &contract.Placed{Id: fmt.Sprintf("land:%d,%d", x, y), Kind: "gather", Variant: "tangle-decor", Frame: frame, Tx: uint32(x), Ty: uint32(y), Target: target, Label: "Work the " + target, Art: &contract.PlacedArt{Ox: 8, Oy: 16, DepthY: true, Tile: true}})
			}
		}
	}
	return c
}
