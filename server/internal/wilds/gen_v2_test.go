package wilds

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"regexp"
	"slices"
	"strings"
	"testing"

	"glimway/content"
)

var updateGoldens = flag.Bool("update", false, "rewrite testdata/golden_v2.json from the generator")

// outerSeason is the Whitequiet's season for the wick containing unix.
func outerSeason(unix int64) string {
	d := content.CalendarAt(content.CalendarRules, unix)
	return fmt.Sprintf("t:%d:%d", d.StartsAt, d.NextTurning)
}

func innerEpoch(seed string) Epoch { return Epoch{seed, InnerRegion, GeneratorV2, "0"} }
func outerEpoch(seed string, unix int64) Epoch {
	return Epoch{seed, OuterRegion, GeneratorV2, outerSeason(unix)}
}

func mustRegion(t testing.TB, e Epoch) Region {
	t.Helper()
	r, err := GenerateRegion(e)
	if err != nil {
		t.Fatalf("%+v: %v", e, err)
	}
	return r
}

func chunkHash(c Chunk) string {
	b, err := json.Marshal(c)
	if err != nil {
		panic(err)
	}
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:8])
}

// goldenEpochs are the fixed epochs whose chunks are hashed whole.
func goldenEpochs() []Epoch {
	return []Epoch{
		innerEpoch("review-seed"),
		innerEpoch("oak-7"),
		innerEpoch("灰烬之路"),
		{"review-seed", OuterRegion, GeneratorV2, "t:1790812800:1792022400"},
		{"oak-7", OuterRegion, GeneratorV2, "t:1792022400:1793232000"},
	}
}

// TestGoldenChunks pins every chunk of a few fixed epochs. A change to v2's
// output is a new generator version, never an edit: regenerate only while
// v2 has no stored epochs (go test -run TestGoldenChunks -update).
func TestGoldenChunks(t *testing.T) {
	got := map[string]string{}
	for _, e := range goldenEpochs() {
		r := mustRegion(t, e)
		for _, c := range r.Chunks {
			got[fmt.Sprintf("%s/%s/%s/%d,%d", e.WorldSeed, e.RegionID, e.Season, c.CX, c.CY)] = chunkHash(c)
		}
	}
	const path = "testdata/golden_v2.json"
	if *updateGoldens {
		b, _ := json.MarshalIndent(got, "", "  ")
		if err := os.MkdirAll("testdata", 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, append(b, '\n'), 0o644); err != nil {
			t.Fatal(err)
		}
		return
	}
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var want map[string]string
	if err := json.Unmarshal(b, &want); err != nil {
		t.Fatal(err)
	}
	if len(want) != len(got) {
		t.Fatalf("golden has %d chunks, generated %d", len(want), len(got))
	}
	for k, h := range want {
		if got[k] != h {
			t.Errorf("chunk %s: hash %s, golden %s", k, got[k], h)
		}
	}
}

func TestDeterministicAndStableIDs(t *testing.T) {
	e := outerEpoch("oak-7", 1795000000)
	a, b := mustRegion(t, e), mustRegion(t, e)
	for i := range a.Chunks {
		if chunkHash(a.Chunks[i]) != chunkHash(b.Chunks[i]) {
			t.Fatalf("chunk %d differs between runs", i)
		}
	}
	// One chunk alone comes out exactly as it does inside the region.
	alone, err := GenerateChunk(e, 2, 1)
	if err != nil {
		t.Fatal(err)
	}
	if chunkHash(alone) != chunkHash(*a.Chunk(2, 1)) {
		t.Fatal("GenerateChunk differs from GenerateRegion")
	}
	// Another wick turns the Whitequiet; the Tangle stays.
	other := mustRegion(t, outerEpoch("oak-7", 1795000000+86400*15))
	if chunkHash(other.Chunks[0]) == chunkHash(a.Chunks[0]) {
		t.Fatal("a new season left the chunk unchanged")
	}
	if chunkHash(mustRegion(t, innerEpoch("oak-7")).Chunks[4]) != chunkHash(mustRegion(t, innerEpoch("oak-7")).Chunks[4]) {
		t.Fatal("the Tangle is not permanent")
	}
	if chunkHash(mustRegion(t, innerEpoch("oak-8")).Chunks[4]) == chunkHash(mustRegion(t, innerEpoch("oak-7")).Chunks[4]) {
		t.Fatal("the world seed did not change the Tangle")
	}
}

func TestEpochRefusals(t *testing.T) {
	if _, err := GenerateRegion(Epoch{"s", InnerRegion, 1, "0"}); !errors.Is(err, ErrGeneratorUnavailable) {
		t.Fatalf("v1 epoch: %v", err)
	}
	if _, err := GenerateRegion(Epoch{"s", "nope", GeneratorV2, "0"}); err == nil {
		t.Fatal("unknown region accepted")
	}
	for _, season := range []string{"", "7", "t:5", "t:9:3", "t:a:b"} {
		if _, err := GenerateRegion(Epoch{"s", OuterRegion, GeneratorV2, season}); err == nil {
			t.Fatalf("season %q accepted", season)
		}
	}
	for _, xy := range [][2]int{{-1, 0}, {0, -1}, {3, 0}, {0, 3}} {
		if _, err := GenerateChunk(innerEpoch("s"), xy[0], xy[1]); err == nil {
			t.Fatalf("chunk %v accepted", xy)
		}
	}
}

func TestOuterMark(t *testing.T) {
	r := mustRegion(t, outerEpoch("s", 1795000000))
	want := content.CalendarAt(content.CalendarRules, 1795000000).Mark
	for _, c := range r.Chunks {
		if c.Look != "outer" || c.Mark != want {
			t.Fatalf("outer chunk look %q mark %q, want outer %q", c.Look, c.Mark, want)
		}
	}
	for _, c := range mustRegion(t, innerEpoch("s")).Chunks {
		if c.Look != "tangle" || c.Mark != "" {
			t.Fatalf("tangle chunk look %q mark %q", c.Look, c.Mark)
		}
	}
}

func TestLootFromStoredEntity(t *testing.T) {
	e := innerEpoch("oak-7")
	r := mustRegion(t, e)
	changed := false
	for _, c := range r.Chunks {
		for _, ent := range c.Entities {
			if _, ok := content.WildsRules.LootTables[LootTable(ent)]; !ok {
				t.Fatalf("%s has no loot table %s", ent.ID, LootTable(ent))
			}
			a, err := RollEntityLoot(e, ent, 0)
			if err != nil {
				t.Fatal(err)
			}
			b, _ := RollEntityLoot(e, ent, 0)
			c1, _ := RollEntityLoot(e, ent, 1)
			ja, _ := json.Marshal(a)
			jb, _ := json.Marshal(b)
			jc, _ := json.Marshal(c1)
			if string(ja) != string(jb) {
				t.Fatalf("%s: loot not deterministic", ent.ID)
			}
			changed = changed || string(ja) != string(jc)
		}
	}
	if !changed {
		t.Fatal("no loot changed across cycles")
	}
	if _, err := RollEntityLoot(e, r.Chunks[0].Entities[0], -1); err == nil {
		t.Fatal("negative cycle accepted")
	}
}

// ---------------------------------------------------------------- invariants

// invariantEpochs: enough seeds and wicks to shake out rare layouts.
func invariantEpochs() []Epoch {
	var out []Epoch
	for i := range 40 {
		seed := fmt.Sprintf("inv-%d", i)
		out = append(out, innerEpoch(seed), outerEpoch(seed, 1790000000+int64(i)*86400*9))
	}
	return out
}

func TestInvariants(t *testing.T) {
	regions := map[Epoch]Region{}
	for _, e := range invariantEpochs() {
		regions[e] = mustRegion(t, e)
	}
	for e, r := range regions {
		for i := range r.Chunks {
			checkChunk(t, e, &r.Chunks[i])
		}
		checkNeighbours(t, e, r)
		checkSites(t, e, r)
	}
	// The crossing, both ways, between any Tangle and any Whitequiet wick.
	for i := range 40 {
		seed := fmt.Sprintf("inv-%d", i)
		checkCrossing(t, regions[innerEpoch(seed)], regions[outerEpoch(seed, 1790000000+int64(i)*86400*9)])
		checkCrossing(t, regions[innerEpoch(seed)], regions[outerEpoch(fmt.Sprintf("inv-%d", (i+1)%40), 1790000000+int64((i+1)%40)*86400*9)])
	}
}

var entityID = regexp.MustCompile(`^(camp|node|chest|poi):(\d+):(\d+):(\d+)$`)

func checkChunk(t *testing.T, e Epoch, c *Chunk) {
	t.Helper()
	where := fmt.Sprintf("%s %s %s %d,%d", e.WorldSeed, e.RegionID, e.Season, c.CX, c.CY)
	S := c.Size
	if len(c.Ground) != S*S || len(c.Solid) != S*S {
		t.Fatalf("%s: grid sizes %d/%d", where, len(c.Ground), len(c.Solid))
	}
	palette := map[Ground]bool{}
	for i, g := range c.Ground {
		palette[g] = true
		if g == GroundWater && !c.Solid[i] {
			t.Fatalf("%s: walkable water at %d", where, i)
		}
	}
	if len(palette) > 16 {
		t.Fatalf("%s: palette of %d", where, len(palette))
	}
	onExit := func(x, y int) bool {
		return slices.ContainsFunc(c.Exits, func(x2 Exit) bool { return x2.contains(x, y) })
	}
	// The edge is a wall except for the doorways.
	for i := range S {
		for _, p := range [][2]int{{i, 0}, {i, S - 1}, {0, i}, {S - 1, i}} {
			if c.Walkable(p[0], p[1]) && !onExit(p[0], p[1]) {
				t.Fatalf("%s: open edge tile %v", where, p)
			}
		}
	}

	// Everything that matters is reachable on foot from the spawn.
	reach := map[Tile]bool{}
	if !c.Walkable(c.Spawn.TX, c.Spawn.TY) {
		t.Fatalf("%s: spawn %v is solid", where, c.Spawn)
	}
	queue := []Tile{c.Spawn}
	reach[c.Spawn] = true
	for len(queue) > 0 {
		p := queue[0]
		queue = queue[1:]
		for _, d := range dirs4 {
			n := Tile{p.TX + d[0], p.TY + d[1]}
			if c.Walkable(n.TX, n.TY) && !reach[n] {
				reach[n] = true
				queue = append(queue, n)
			}
		}
	}
	for _, x := range c.Exits {
		for y := x.TY; y < x.TY+x.TH; y++ {
			for xx := x.TX; xx < x.TX+x.TW; xx++ {
				if !reach[Tile{xx, y}] {
					t.Fatalf("%s: exit %s tile %d,%d unreachable", where, x.To, xx, y)
				}
			}
		}
	}

	// Entities: rule counts, stable ids, on open ground, reachable.
	perKind := map[string]int{}
	for _, en := range c.Entities {
		m := entityID.FindStringSubmatch(en.ID)
		if m == nil || m[1] != en.Kind || m[2] != fmt.Sprint(c.CX) || m[3] != fmt.Sprint(c.CY) || m[4] != fmt.Sprint(perKind[en.Kind]) {
			t.Fatalf("%s: bad id %s", where, en.ID)
		}
		perKind[en.Kind]++
		if !reach[Tile{en.TX, en.TY}] || c.Ground[en.TY*S+en.TX] == GroundWater {
			t.Fatalf("%s: entity %s at %d,%d is walled off or on water", where, en.ID, en.TX, en.TY)
		}
		switch en.Kind {
		case kindCamp:
			if len(en.Enemies) == 0 {
				t.Fatalf("%s: empty camp", where)
			}
		case kindNode:
			if !slices.Contains(content.WildsRules.Materials, en.Material) {
				t.Fatalf("%s: node material %q", where, en.Material)
			}
		case kindChest:
			if en.Tier < 1 || en.Tier > 3 {
				t.Fatalf("%s: chest tier %d", where, en.Tier)
			}
		case kindPOI:
			if !slices.Contains(content.WildsRules.POIIds, en.POI) {
				t.Fatalf("%s: poi %q", where, en.POI)
			}
		}
	}
	for _, rule := range content.WildsRules.EntityKinds {
		if n := perKind[rule.Kind]; n < rule.Min || n > rule.Max {
			t.Fatalf("%s: %d %s, rule %d–%d", where, n, rule.Kind, rule.Min, rule.Max)
		}
	}

	// Sites: on open ground, reachable, clear of the doorways.
	for _, s := range c.Sites {
		if s.CX != c.CX || s.CY != c.CY {
			t.Fatalf("%s: site %s names chunk %d,%d", where, s.ID, s.CX, s.CY)
		}
		if !reach[Tile{s.TX, s.TY}] || c.Ground[s.TY*S+s.TX] == GroundWater {
			t.Fatalf("%s: site %s at %d,%d is walled off or on water", where, s.ID, s.TX, s.TY)
		}
		for _, x := range c.Exits {
			if x.near(s.TX, s.TY, 3) {
				t.Fatalf("%s: site %s crowds exit %s", where, s.ID, x.To)
			}
		}
		if s.Kind == SiteReeds {
			for y := s.TY - 2; y <= s.TY-1; y++ {
				for x := s.TX - 1; x <= s.TX+1; x++ {
					if c.Ground[y*S+x] != GroundWater {
						t.Fatalf("%s: reed site without its pool at %d,%d", where, x, y)
					}
				}
			}
		}
	}

	// Decor: inside the chunk, blocking pieces only on solid tiles.
	for _, d := range c.Decor {
		if int(d.Kind) >= len(DecorKinds) || d.TX < 0 || d.TY < 0 || d.TX >= S || d.TY >= S || d.Variant < 0 || d.Variant > 7 {
			t.Fatalf("%s: bad decor %+v", where, d)
		}
		art := DecorArts[d.Kind]
		if art.Blocking && c.Walkable(d.TX, d.TY) {
			t.Fatalf("%s: blocking %s on walkable %d,%d", where, d.Kind, d.TX, d.TY)
		}
		if d.Overhang && !art.Blocking {
			t.Fatalf("%s: overhang on %s", where, d.Kind)
		}
	}
	// The spawn and the doorways' throats stay bare of blocking pieces.
	for _, d := range c.Decor {
		if DecorArts[d.Kind].Blocking && cheb(d.TX-c.Spawn.TX, d.TY-c.Spawn.TY) <= 1 && c.Walkable(d.TX, d.TY) {
			t.Fatalf("%s: blocking piece on the spawn", where)
		}
	}
}

// checkNeighbours: every chunk-to-chunk doorway has its twin on the other
// side of the edge, and the arrival tiles stand open.
func checkNeighbours(t *testing.T, e Epoch, r Region) {
	t.Helper()
	opposite := map[Dir]Dir{North: South, South: North, East: West, West: East}
	for _, c := range r.Chunks {
		for _, x := range c.Exits {
			var nx, ny int
			var region string
			if _, err := fmt.Sscanf(strings.ReplaceAll(x.To, ":", " "), "chunk %s %d %d", &region, &nx, &ny); err != nil {
				if x.To != "commons" || r.RegionID != InnerRegion {
					t.Fatalf("%s %d,%d: exit to %q", e.RegionID, c.CX, c.CY, x.To)
				}
				continue
			}
			if region != r.RegionID {
				continue // the crossing: checkCrossing
			}
			if abs(nx-c.CX)+abs(ny-c.CY) != 1 {
				t.Fatalf("%s %d,%d: exit to a chunk not beside it: %s", e.RegionID, c.CX, c.CY, x.To)
			}
			n := r.Chunk(nx, ny)
			back := chunkArea(r.RegionID, c.CX, c.CY)
			i := slices.IndexFunc(n.Exits, func(y Exit) bool { return y.To == back })
			if i < 0 {
				t.Fatalf("%s %d,%d: no way back from %s", e.RegionID, c.CX, c.CY, x.To)
			}
			y := n.Exits[i]
			if y.Dir != opposite[x.Dir] {
				t.Fatalf("%s %d,%d: %s exit meets a %s exit", e.RegionID, c.CX, c.CY, x.Dir, y.Dir)
			}
			// The same span along the shared edge.
			if (x.Dir == North || x.Dir == South) && (x.TX != y.TX || x.TW != y.TW) ||
				(x.Dir == East || x.Dir == West) && (x.TY != y.TY || x.TH != y.TH) {
				t.Fatalf("%s %d,%d: %s gap %+v doesn't line up with %+v", e.RegionID, c.CX, c.CY, x.Dir, x, y)
			}
			if x.Entry != justInside(y, n.Size) || !n.Walkable(x.Entry.TX, x.Entry.TY) {
				t.Fatalf("%s %d,%d: arrival %v in %s is not just inside its gap", e.RegionID, c.CX, c.CY, x.Entry, x.To)
			}
		}
	}
}

// justInside is the middle of a doorway, one tile in from the edge.
func justInside(e Exit, S int) Tile {
	switch e.Dir {
	case North:
		return Tile{e.TX + e.TW/2, 1}
	case South:
		return Tile{e.TX + e.TW/2, S - 2}
	case West:
		return Tile{1, e.TY + e.TH/2}
	}
	return Tile{S - 2, e.TY + e.TH/2}
}

// checkCrossing: the Tangle's crossing lands on open ground in the
// Whitequiet's entry chunk, and the way back lands on open ground by it.
func checkCrossing(t *testing.T, inner, outer Region) {
	t.Helper()
	ic := inner.Chunk(crossingChunk.TX, crossingChunk.TY)
	outerData, _ := regionFor(content.WildsRules, OuterRegion)
	oc := outer.Chunk(outerData.EntryX, outerData.EntryY)
	there := slices.IndexFunc(ic.Exits, func(x Exit) bool { return x.To == chunkArea(OuterRegion, oc.CX, oc.CY) })
	back := slices.IndexFunc(oc.Exits, func(x Exit) bool { return x.To == chunkArea(InnerRegion, ic.CX, ic.CY) })
	if there < 0 || back < 0 {
		t.Fatalf("crossing missing: there %d back %d", there, back)
	}
	x, y := ic.Exits[there], oc.Exits[back]
	if x.Dir != North || y.Dir != South {
		t.Fatalf("crossing dirs %s/%s", x.Dir, y.Dir)
	}
	if x.Entry != justInside(y, oc.Size) || !oc.Walkable(x.Entry.TX, x.Entry.TY) {
		t.Fatalf("the crossing lands on %v in the Whitequiet", x.Entry)
	}
	if y.Entry != justInside(x, ic.Size) || !ic.Walkable(y.Entry.TX, y.Entry.TY) {
		t.Fatalf("the way back lands on %v in the Tangle", y.Entry)
	}
	// Exactly one crossing, nowhere else.
	for _, r := range []Region{inner, outer} {
		for _, c := range r.Chunks {
			for _, e := range c.Exits {
				if strings.HasPrefix(e.To, "chunk:") && !strings.HasPrefix(e.To, "chunk:"+r.RegionID+":") &&
					!(c.CX == ic.CX && c.CY == ic.CY && r.RegionID == InnerRegion) && !(c.CX == oc.CX && c.CY == oc.CY && r.RegionID == OuterRegion) {
					t.Fatalf("%s %d,%d: stray crossing to %s", r.RegionID, c.CX, c.CY, e.To)
				}
			}
		}
	}
	// The Tangle's way home is the Commons, on its entry chunk.
	innerData, _ := regionFor(content.WildsRules, InnerRegion)
	entry := inner.Chunk(innerData.EntryX, innerData.EntryY)
	home := slices.IndexFunc(entry.Exits, func(x Exit) bool { return x.To == "commons" })
	if home < 0 || entry.Exits[home].TX != homeGapTX || entry.Exits[home].Dir != South {
		t.Fatal("the Tangle's way home is not at the south gap tx=1")
	}
	if entry.Spawn != (Tile{2, entry.Size - 2}) {
		t.Fatalf("the Tangle's spawn %v moved off the Commons arrival", entry.Spawn)
	}
}

// checkSites: the epoch's sites are where the rules say.
func checkSites(t *testing.T, e Epoch, r Region) {
	t.Helper()
	data, _ := regionFor(content.WildsRules, r.RegionID)
	ids := map[string]Site{}
	for _, s := range r.Sites {
		if _, dup := ids[s.ID]; dup {
			t.Fatalf("%s: duplicate site %s", e.WorldSeed, s.ID)
		}
		ids[s.ID] = s
	}
	if r.RegionID == InnerRegion {
		if len(r.Sites) != 1 || r.Sites[0].Kind != SitePlank || r.Sites[0].CX != crossingChunk.TX || r.Sites[0].CY != crossingChunk.TY {
			t.Fatalf("%s: tangle sites %+v", e.WorldSeed, r.Sites)
		}
		return
	}
	want := []string{"given", "echo:0", "echo:1", "echo:2", "cairn", "nest", "reeds"}
	if len(ids) != len(want) {
		t.Fatalf("%s %s: sites %+v", e.WorldSeed, e.Season, r.Sites)
	}
	for _, id := range want {
		s, ok := ids[id]
		if !ok {
			t.Fatalf("%s %s: no site %s", e.WorldSeed, e.Season, id)
		}
		entry := s.CX == data.EntryX && s.CY == data.EntryY
		if (id == "given") != entry {
			t.Fatalf("%s %s: site %s in chunk %d,%d", e.WorldSeed, e.Season, id, s.CX, s.CY)
		}
	}
	if ids["echo:0"].CX != data.GridWidth-1 {
		t.Fatalf("%s: echo:0 not in the east column", e.WorldSeed)
	}
}
