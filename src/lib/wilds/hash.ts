/**
 * Integer-only hash and PRNG shared by the TypeScript and Go generators.
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
  let h = FNV_OFFSET;
  for (const b of encoder.encode(input)) {
    h = Math.imul(h ^ b, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

/** One mixing step: fold `v` into `h`. */
export function mix(h: number, v: number): number {
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
