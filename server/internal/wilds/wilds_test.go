package wilds

import (
	"strconv"
	"testing"
)

// Golden values must match tests/wilds.test.ts — together they lock the
// hash/PRNG spec for any future re-implementation.
func TestHashGolden(t *testing.T) {
	if Fnv1a32("") != 2166136261 {
		t.Fatal("fnv1a32 empty")
	}
	if Fnv1a32("a") != 3826002220 {
		t.Fatal("fnv1a32 a")
	}
	if Fnv1a32("灰烬") != 1086804951 {
		t.Fatal("fnv1a32 utf8")
	}
	if Fnv1a32("The quick brown fox") != 2924308450 {
		t.Fatal("fnv1a32 phrase")
	}
	if Hash("oak-7", "inner-1", 1, "spring", 0, 0) != 2595774026 {
		t.Fatal("hash fold")
	}
	if Hash("oak-7", "inner-1", 1, "spring", -1, -2) != 2607182495 {
		t.Fatal("hash negative ints")
	}
	e := Epoch{WorldSeed: "oak-7", RegionID: "inner-1", GeneratorVersion: 1, Season: "spring"}
	if ChunkSeed(e, 1, 1) != 3659775552 {
		t.Fatal("chunk seed")
	}
	if LootSeed(e, "camp:1:1:0", 3) != 2481498229 {
		t.Fatal("loot seed")
	}
	r := NewRng(0)
	if a, b, c := r.Next(), r.Next(), r.Next(); a != 1144304738 || b != 1416247 || c != 958946056 {
		t.Fatalf("rng(0) = %d %d %d", a, b, c)
	}
	r2 := NewRng(2166136261)
	if v := r2.Next(); v != 2625274932 {
		t.Fatalf("rng next %d", v)
	}
	if v := r2.NextInt(1000); v != 693 {
		t.Fatalf("rng nextInt(1000) = %d", v)
	}
	if v := r2.NextInt(3); v != 0 {
		t.Fatalf("rng nextInt(3) = %d", v)
	}
	r3 := NewRng(123456789)
	if a, b, c, d := r3.Next(), r3.Next(), r3.NextInt(10), r3.NextInt(24); a != 1107202814 || b != 4169434471 || c != 8 || d != 16 {
		t.Fatalf("rng(123456789) = %d %d %d %d", a, b, c, d)
	}
}

func TestChunkEntitiesDeterministic(t *testing.T) {
	e := Epoch{WorldSeed: "oak-7", RegionID: "inner-1", GeneratorVersion: 1, Season: "spring"}
	a, err := ChunkEntities(e, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	b, err := ChunkEntities(e, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	same(t, "entities", a, b)
	if len(a) == 0 {
		t.Fatal("no entities")
	}
	seen := map[string]bool{}
	perKind := map[string]int{}
	for _, ent := range a {
		if seen[ent.ID] {
			t.Fatalf("duplicate id %s", ent.ID)
		}
		seen[ent.ID] = true
		want := ent.Kind + ":1:1:" + strconv.Itoa(perKind[ent.Kind])
		perKind[ent.Kind]++
		if ent.ID != want {
			t.Fatalf("id %s want %s", ent.ID, want)
		}
	}
	other, err := ChunkEntities(Epoch{WorldSeed: "oak-7", RegionID: "inner-1", GeneratorVersion: 1, Season: "summer"}, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	ja, _ := jsonMarshal(a)
	jb, _ := jsonMarshal(other)
	if string(ja) == string(jb) {
		t.Fatal("season did not change entities")
	}
	v7, err := ChunkEntities(Epoch{WorldSeed: "oak-7", RegionID: "inner-1", GeneratorVersion: 7, Season: "spring"}, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	jc, _ := jsonMarshal(v7)
	if string(ja) == string(jc) {
		t.Fatal("generator version did not change entities")
	}
	if _, err := ChunkEntities(Epoch{WorldSeed: "oak-7", RegionID: "nope", GeneratorVersion: 1, Season: "spring"}, 1, 1); err == nil {
		t.Fatal("unknown region accepted")
	}
}

func TestRollLootDeterministic(t *testing.T) {
	e := Epoch{WorldSeed: "灰烬之路", RegionID: "inner-1", GeneratorVersion: 1, Season: "autumn"}
	entities, err := ChunkEntities(e, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	changed := false
	for _, ent := range entities {
		a, err := RollLoot(e, ent.ID, 0)
		if err != nil {
			t.Fatal(err)
		}
		b, err := RollLoot(e, ent.ID, 0)
		if err != nil {
			t.Fatal(err)
		}
		same(t, "loot", a, b)
		c, err := RollLoot(e, ent.ID, 1)
		if err != nil {
			t.Fatal(err)
		}
		ja, _ := jsonMarshal(a)
		jc, _ := jsonMarshal(c)
		if string(ja) != string(jc) {
			changed = true
		}
		if a.Trinket != nil {
			found := false
			for _, tr := range []string{"whittled-fox", "beeswax-candle", "river-glass-bead", "spare-bootlace", "tin-whistle"} {
				if *a.Trinket == tr {
					found = true
				}
			}
			if !found {
				t.Fatalf("unknown trinket %s", *a.Trinket)
			}
		}
	}
	if !changed {
		t.Fatal("no loot roll changed across cycles")
	}
	if _, err := RollLoot(e, "camp:1:1:9", 0); err == nil {
		t.Fatal("unknown entity accepted")
	}
	if _, err := RollLoot(e, "nope:1:1:0", 0); err == nil {
		t.Fatal("bad entity id accepted")
	}
	if _, err := RollLoot(e, "camp:1:1:0", -1); err == nil {
		t.Fatal("negative cycle accepted")
	}
}
