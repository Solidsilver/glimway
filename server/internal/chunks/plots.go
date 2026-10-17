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
const PlotRevision = 5

// InsideLot includes the private ground and two front gate cells; the back lantern line stays public.
func InsideLot(x, y, gate int) bool {
	front := 23
	if gate%2 == 1 {
		front = 0
	}
	return x >= 1 && x <= 22 && y >= 2 && y <= 21 || x == front && y >= 11 && y <= 12
}

// Backland (hearthwick-2.md 6): the generated chunk behind each lot, held
// while the lot's lantern burns. West lots look onto cx -3, east onto cx 3.
func BacklandAt(cx, cy int) int {
	switch cx {
	case -3:
		return LotAt(-2, cy)
	case 3:
		return LotAt(2, cy)
	}
	return -1
}
func BacklandChunk(gate int) (int, int) {
	x, y := LotOrigin(gate)
	if gate%2 == 1 {
		return x/24 + 1, y / 24
	}
	return x/24 - 1, y / 24
}

// InBackland: a lot-local tile in the backland, stored past the lot (west
// x -24..-1, east x 24..47).
func InBackland(x, y, gate int) bool {
	x0 := -24
	if gate%2 == 1 {
		x0 = 24
	}
	return x >= x0 && x < x0+24 && y >= 0 && y < 24
}

// LanternStake is the lot-local tile of the stake that carries the lot's
// lantern, on the back line.
func LanternStake(gate int) (int, int) {
	x := 0
	if gate%2 == 1 {
		x = 23
	}
	return x, int(content.HomeRules.GetLotLantern().GetStakeY())
}

// Lot origins and epoch identity keep immutable land separate from home overlays.
func LotAt(cx, cy int) int {
	if (cx != -2 && cx != 2) || cy < 1 || cy > 4 {
		return -1
	}
	side := 0
	if cx == 2 {
		side = 1
	}
	return (cy-1)*2 + side
}
func LotOrigin(gate int) (int, int) {
	x := -48
	if gate%2 == 1 {
		x = 48
	}
	return x, 24 + (gate/2)*24
}
func LotLayout(gate int) string {
	if gate%2 == 1 {
		return "lots-east"
	}
	return "lots-west"
}
func IsLotLayout(id string) bool { return id == "lots-west" || id == "lots-east" }
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
	base := Fixed(FixedEpoch(LotLayout(gate), PlotRevision), cx, cy)
	if base == nil {
		return nil
	}
	c := proto.Clone(base).(*contract.WorldChunk)
	c.EpochId = PlotEpoch(world, gate)
	c.Look = "tangle"
	l := land.GenerateLot(land.Seed(world, gate, content.HomeRules.GetLand()), content.HomeRules.GetLand(), gate)
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
	for y := 2; y <= 21; y++ {
		for x := 1; x <= 22; x++ {
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

// HomeEntrance stands on Lot Row, outside the front gate.
func HomeEntrance(gate int) (int, int) {
	_, y := LotOrigin(gate)
	x := -23
	if gate%2 == 1 {
		x = 46
	}
	return x, y + 11
}
func HomeDoorstep(gate int) (int, int) { x, y := LotOrigin(gate); return x + 11, y + 8 }
