/**
 * The server's own chunks for client tests: tests/fixtures/wilds-*.bin are
 * written (and checked current) by server/internal/wilds TestClientFixtures.
 */
import { readFileSync } from 'node:fs';
import { decodeChunk } from '../src/lib/api/chunks.ts';
import type { WildsChunk } from '../src/lib/gen/glimway/v1/wilds_pb.js';
import { terrainOf, type ChunkTerrain } from '../src/game/wilds/terrain.ts';

export function fixtureBytes(region: 'inner-1' | 'outer-1'): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/wilds-${region === 'inner-1' ? 'inner' : 'outer'}-1-1.bin`, import.meta.url)));
}

export function fixtureChunk(region: 'inner-1' | 'outer-1'): WildsChunk {
  return decodeChunk(fixtureBytes(region));
}

export function fixtureTerrain(region: 'inner-1' | 'outer-1'): ChunkTerrain {
  return terrainOf(fixtureChunk(region));
}
