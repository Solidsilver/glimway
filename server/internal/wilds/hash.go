// Package wilds generates the Wilds. Generator v1 (gen_v1.go) is the Go port
// of the TypeScript generator's server-reproducible parts (entities and
// loot), matched exactly through content/vectors/wilds.json. Generator v2
// (gen_v2.go, woods_v2.go) makes whole chunks on the server, terrain
// included, and has its own goldens instead of parity.
//
// Integer-only hash and PRNG spec (mirrors src/lib/hash.ts):
//
//	fnv1a32(utf8 bytes): h = 0x811C9DC5; h = (h XOR b) * 0x01000193 per byte
//	mix(h, v): h = h XOR v; h *= 0x01000193; h ^= h >> 15; h *= 0x85EBCA6B; h ^= h >> 13
//	hash(parts...): fold of mix over UTF-8 strings and signed 32-bit ints,
//	  starting from 0x811C9DC5
//	Rng (mulberry32, integer output):
//	  next(): state += 0x6D2B79F5; t = state; t = (t ^ (t >> 15)) * (t | 1);
//	          t = (t + ((t ^ (t >> 7)) * (t | 61))) ^ t; return t ^ (t >> 14)
//	  nextInt(n): next() % n
package wilds

const (
	fnvOffset = 0x811c9dc5
	fnvPrime  = 0x01000193
	mixPrime  = 0x85ebca6b
	rngStep   = 0x6d2b79f5
)

// Fnv1a32 hashes the UTF-8 bytes of s (Go strings are UTF-8).
func Fnv1a32(s string) uint32 {
	h := uint32(fnvOffset)
	for i := 0; i < len(s); i++ {
		h = (h ^ uint32(s[i])) * fnvPrime
	}
	return h
}

// Mix folds v into h with the shared avalanche steps.
func Mix(h, v uint32) uint32 {
	x := h ^ v
	x *= fnvPrime
	x ^= x >> 15
	x *= mixPrime
	x ^= x >> 13
	return x
}

// Hash folds parts (strings as UTF-8, ints as signed 32-bit) into a uint32.
func Hash(parts ...any) uint32 {
	h := uint32(fnvOffset)
	for _, p := range parts {
		switch v := p.(type) {
		case string:
			h = Mix(h, Fnv1a32(v))
		case int:
			h = Mix(h, uint32(int32(v)))
		default:
			panic("wilds: hash parts must be string or int")
		}
	}
	return h
}

// Rng is the 32-bit PRNG (mulberry32 with integer output).
type Rng struct {
	state uint32
}

func NewRng(seed uint32) *Rng { return &Rng{state: seed} }

// Next returns the next raw 32-bit value.
func (r *Rng) Next() uint32 {
	r.state += rngStep
	t := r.state
	t = (t ^ (t >> 15)) * (t | 1)
	t = (t + ((t ^ (t >> 7)) * (t | 61))) ^ t
	return t ^ (t >> 14)
}

// NextInt returns an integer in [0, n); n must be > 0.
func (r *Rng) NextInt(n int) int {
	return int(r.Next() % uint32(n))
}

// Epoch is a region's frozen generation parameters.
type Epoch struct {
	WorldSeed        string `json:"worldSeed"`
	RegionID         string `json:"regionId"`
	GeneratorVersion int    `json:"generatorVersion"`
	Season           string `json:"season"`
}

// ChunkSeed is hash(worldSeed, regionId, generatorVersion, season, cx, cy).
func ChunkSeed(e Epoch, cx, cy int) uint32 {
	return Hash(e.WorldSeed, e.RegionID, e.GeneratorVersion, e.Season, cx, cy)
}

// LootSeed is hash(worldSeed, regionId, generatorVersion, season, entityId, cycle).
func LootSeed(e Epoch, entityID string, cycle int) uint32 {
	return Hash(e.WorldSeed, e.RegionID, e.GeneratorVersion, e.Season, entityID, cycle)
}
