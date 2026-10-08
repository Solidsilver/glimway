package wilds

import "testing"

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
