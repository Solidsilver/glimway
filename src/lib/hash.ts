/**
 * The one hash and PRNG module.
 *
 * The first part is integer-only and shared by the TypeScript and Go
 * generators (server/internal/wilds/hash.go mirrors it). The last part,
 * "Client decor", is float noise used only to place and draw decor in the
 * browser; the server never reproduces it.
 *
 * Layouts and art are seed-deterministic: every formula here is kept
 * exactly, so changing one moves trees and repaints textures.
 *
 * Everything here is 32-bit unsigned integer arithmetic: trivially portable
 * to Go (`uint32`), with no floating point anywhere the server must reproduce.
 * The spec (re-implementable from this description alone):
 *
 *   fnv1a32(utf8 bytes):
 *     h = 0x811C9DC5
 *     for each byte b: h = (h XOR b) * 0x01000193        (mod 2^32)
 *
 *   mix(h, v):
 *     h = h XOR v
 *     h = h * 0x01000193                                 (mod 2^32)
 *     h = h XOR (h >>> 15)
 *     h = h * 0x85EBCA6B                                 (mod 2^32)
 *     h = h XOR (h >>> 13)
 *     return h
 *
 *   hash(parts...):   parts are UTF-8 strings or signed 32-bit ints
 *     h = 0x811C9DC5
 *     for p in parts:
 *       h = mix(h, p is string ? fnv1a32(utf8(p)) : uint32(p))
 *     return h
 *
 *   Rng(seed): mulberry32 with integer output (the classic float variant
 *   returns next() / 2^32):
 *     next():
 *       state = state + 0x6D2B79F5                        (mod 2^32)
 *       t = state
 *       t = (t XOR (t >>> 15)) * (t OR 1)                 (mod 2^32)
 *       t = (t + ((t XOR (t >>> 7)) * (t OR 61))) XOR t   (mod 2^32)
 *       return t XOR (t >>> 14)
 *     nextInt(n): next() % n                              (n > 0)
 *
 * Seeds (see the expansion design):
 *   chunkSeed = hash(worldSeed, regionId, generatorVersion, season, chunkX, chunkY)
 *   lootSeed  = hash(worldSeed, regionId, generatorVersion, season, entityId, cycle)
 */

const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const MIX_PRIME = 0x85ebca6b;
const RNG_STEP = 0x6d2b79f5;

const encoder = new TextEncoder();

/** FNV-1a 32-bit over the UTF-8 bytes of a string. */
export function fnv1a32(input: string): number {
  return fnv1a32Bytes(encoder.encode(input));
}

/** FNV-1a 32-bit over bytes (a texture's pixels, for the dev hooks' texture hashes). */
export function fnv1a32Bytes(bytes: ArrayLike<number>): number {
  let h = FNV_OFFSET;
  for (let i = 0; i < bytes.length; i++) {
    h = Math.imul(h ^ bytes[i], FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** One mixing step: fold `v` into `h`. */
function mix(h: number, v: number): number {
  let x = (h ^ v) >>> 0;
  x = Math.imul(x, FNV_PRIME) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, MIX_PRIME) >>> 0;
  x = (x ^ (x >>> 13)) >>> 0;
  return x >>> 0;
}

/** Sequential fold of strings and signed 32-bit ints into a 32-bit hash. */
export function hash(parts: readonly (string | number)[]): number {
  let h = FNV_OFFSET;
  for (const p of parts) {
    h = mix(h, typeof p === 'string' ? fnv1a32(p) : p >>> 0);
  }
  return h >>> 0;
}

/** 32-bit PRNG (mulberry32, integer output). */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Next raw 32-bit value. */
  next(): number {
    this.state = (this.state + RNG_STEP) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = ((t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t) >>> 0;
    return (t ^ (t >>> 14)) >>> 0;
  }

  /** Uniform-enough integer in [0, n); `n` must be > 0. */
  nextInt(n: number): number {
    return this.next() % n;
  }
}

export interface SeedEpoch {
  worldSeed: string;
  regionId: string;
  generatorVersion: number;
  season: string;
}

/** Seed for a chunk: hash(worldSeed, regionId, generatorVersion, season, cx, cy). */
export function chunkSeed(epoch: SeedEpoch, cx: number, cy: number): number {
  return hash([epoch.worldSeed, epoch.regionId, epoch.generatorVersion, epoch.season, cx, cy]);
}

/** Seed for one loot roll: hash(worldSeed, regionId, generatorVersion, season, entityId, cycle). */
export function lootSeed(epoch: SeedEpoch, entityId: string, cycle: number): number {
  return hash([epoch.worldSeed, epoch.regionId, epoch.generatorVersion, epoch.season, entityId, cycle]);
}

// ---------------------------------------------------------------- client decor

/** 2^32: turns a 32-bit hash into [0, 1). */
const UNIT = 4294967296;

/** A [0, 1) stream from a seed: mulberry32, the float output of `Rng`. */
export function rng01(seed: number): () => number {
  const rng = new Rng(seed);
  return () => rng.next() / UNIT;
}

/**
 * Deterministic [0, 1) for integer x, y and a salt: a spatial hash (primes
 * 73856093, 19349663, 83492791, XOR-folded) with a final avalanche. The
 * ground field and the Tangle's art speckle with it. Non-integer inputs are
 * truncated.
 */
export function hash01(x: number, y: number, s = 0): number {
  let v = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(s | 0, 83492791)) | 0;
  v = Math.imul(v ^ (v >>> 13), 1274126177);
  return ((v ^ (v >>> 16)) >>> 0) / UNIT;
}

/**
 * Deterministic [0, 1) for a tile and a seed, used to lay out the Commons
 * and a homestead's land: the primes are summed in floating point before
 * truncating, which is not the same as `hash01` for large seeds (a land
 * seed is a full 32-bit value). Kept exactly: it places the trees.
 */
export function layoutHash01(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / UNIT;
}
