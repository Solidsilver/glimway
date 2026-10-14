package chunks_test

import (
	"testing"

	"glimway/server/internal/chunks"
	"glimway/server/internal/chunks/fakegen"
	"glimway/server/internal/frontier"
	contract "glimway/server/internal/gen/glimway/v1"
	"glimway/server/internal/wilds"

	"google.golang.org/protobuf/proto"
)

func fakeEpoch(kind string) *contract.WildsEpoch {
	season := "0"
	if kind == "wick" {
		season = "t:100:200"
	}
	return &contract.WildsEpoch{Id: "e-" + kind, WorldSeed: "seed", Kind: kind, GeneratorVersion: 3, Season: season}
}

// Every chunk of the 0.8 frontier, made by the test generator in the epoch
// its coordinates call for, passes the open map's validator.
func TestOpenMapChunksValidateAtSignedCoordinates(t *testing.T) {
	g := fakegen.New()
	x0, y0, x1, y1 := frontier.Rect("")
	n := 0
	for cy := y0; cy <= y1; cy++ {
		for cx := x0; cx <= x1; cx++ {
			m, err := g.Chunk(fakeEpoch(wilds.EpochKindAt(cx, cy)), int32(cx), int32(cy), nil)
			if err != nil {
				t.Fatal(cx, cy, err)
			}
			if err = chunks.Validate(m); err != nil {
				t.Fatal(cx, cy, err)
			}
			n++
		}
	}
	if n != 81 {
		t.Fatalf("made %d chunks", n)
	}
	if _, err := g.Chunk(fakeEpoch("still"), 0, -5, nil); err == nil {
		t.Fatal("a Whitequiet chunk was made in the still epoch")
	}
}

func TestOpenMapValidatorRefusals(t *testing.T) {
	good, err := fakegen.New().Chunk(fakeEpoch("wick"), -3, -7, nil)
	if err != nil {
		t.Fatal(err)
	}
	for name, change := range map[string]func(*contract.WorldChunk){
		"version":    func(c *contract.WorldChunk) { c.GeneratorVersion = 1 },
		"realm":      func(c *contract.WorldChunk) { c.Realm = "elsewhere" },
		"layer":      func(c *contract.WorldChunk) { c.Layer = 1 },
		"tier":       func(c *contract.WorldChunk) { c.Tier = 4 },
		"land":       func(c *contract.WorldChunk) { c.Land = "lake" },
		"palette":    func(c *contract.WorldChunk) { c.Palette[0] = "lava" },
		"decor kind": func(c *contract.WorldChunk) { c.Decor.Kinds[0] = "statue" },
		"packing":    func(c *contract.WorldChunk) { c.Solid = c.Solid[1:] },
		"site kind":  func(c *contract.WorldChunk) { c.Sites = append(c.Sites, &contract.StorySite{Id: "x", Kind: 99}) },
		"place kind": func(c *contract.WorldChunk) {
			c.Places = []*contract.WildsPlaceMark{{Id: "place:1:-2", Kind: "castle"}}
		},
		"place id": func(c *contract.WorldChunk) { c.Places = []*contract.WildsPlaceMark{{Id: "place:a", Kind: "ruin"}} },
		"place tile": func(c *contract.WorldChunk) {
			c.Places = []*contract.WildsPlaceMark{{Id: "place:1:-2", Kind: "ruin", Tx: 24}}
		},
		"duplicate ids": func(c *contract.WorldChunk) { c.Entities[1].Id = c.Entities[0].Id },
		"chest tier":    func(c *contract.WorldChunk) { c.Entities[2].Tier = 9 },
	} {
		c := proto.Clone(good).(*contract.WorldChunk)
		change(c)
		if chunks.Validate(c) == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	rumour := proto.Clone(good).(*contract.WorldChunk)
	rumour.Sites = append(rumour.Sites, &contract.StorySite{Id: "rumour:-3:-7", Kind: contract.SiteKind_SITE_KIND_RUMOUR, Tx: 1, Ty: 1}, &contract.StorySite{Id: "lamp-stone:-3:-7", Kind: contract.SiteKind_SITE_KIND_LAMP_STONE, Tx: 2, Ty: 1})
	if err := chunks.Validate(rumour); err != nil {
		t.Fatal("the new site kinds:", err)
	}
}

// Cleared tiles open, laid tiles carry their ground, and the generated tile
// shows through elsewhere.
func TestEffectiveAppliesGroundChanges(t *testing.T) {
	m, err := fakegen.New().Chunk(fakeEpoch("wick"), 2, -3, nil)
	if err != nil {
		t.Fatal(err)
	}
	th, fe := fakegen.Thicket, fakegen.Fern
	plain := chunks.NewEffective(m, nil)
	if plain.Walkable(th[0], th[1]) || !plain.Walkable(fe[0], fe[1]) || plain.Walkable(-1, 0) || plain.Walkable(24, 0) {
		t.Fatal("generated solidity")
	}
	if plain.Ground(fakegen.Water[0], fakegen.Water[1]).GetSurface() != "water" || plain.Ground(fakegen.Ford[0], fakegen.Ford[1]).GetSurface() != "ford" || plain.Ground(0, 0).GetSurface() != "land" {
		t.Fatal("generated grounds")
	}
	e := chunks.NewEffective(m, &contract.GroundChanges{Changes: []*contract.GroundChange{
		{Tx: uint32(th[0]), Ty: uint32(th[1]), Change: "cleared", By: "a"},
		{Tx: uint32(fe[0]), Ty: uint32(fe[1]), Change: "stone", By: "a"},
		{Tx: 0, Ty: 0, Change: "plank", By: "b"},
	}})
	if !e.Walkable(th[0], th[1]) || e.Laid(th[0], th[1]) || e.Ground(th[0], th[1]).GetId() != "woods" || !e.BaseSolid(th[0], th[1]) {
		t.Fatal("cleared tile")
	}
	if !e.Laid(fe[0], fe[1]) || e.Ground(fe[0], fe[1]).GetId() != "laid-stone" || e.Ground(0, 0).GetId() != "laid-plank" || e.BaseGround(0, 0).GetId() != "woods" {
		t.Fatal("laid tiles")
	}
	if e.Change(fe[0], fe[1]).GetBy() != "a" || e.Change(1, 0) != nil {
		t.Fatal("changes by tile")
	}
}

// The test generator's rumour is one of the place cells' places, and its
// find stands in the chunk it names.
func TestFakeRumourIsAPlace(t *testing.T) {
	g := fakegen.New()
	e := fakeEpoch("wick")
	r, ok, err := g.Rumour(e)
	if err != nil || !ok {
		t.Fatal(ok, err)
	}
	m, err := g.Chunk(e, r.CX, r.CY, nil)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, s := range m.Sites {
		found = found || s.Id == r.Site && s.Kind == contract.SiteKind_SITE_KIND_RUMOUR
	}
	if !found || len(m.Places) != 1 || m.Places[0].Id != r.Place {
		t.Fatal("rumour find", m.Sites, m.Places, r)
	}
	if _, ok, _ := g.Rumour(fakeEpoch("still")); ok {
		t.Fatal("the still epoch has a rumour")
	}
	if len(fakegen.Cells()) != 7 {
		t.Fatal("place cells", fakegen.Cells())
	}
}
