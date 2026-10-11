/**
 * The server's own chunks for client tests: tests/fixtures/wilds-*.bin are
 * written (and checked current) by server/internal/wilds TestClientFixtures.
 *
 * Until the generator's v3 fixtures land (lane O-B), a v2 fixture is read
 * raw and given the open map's shape: no region, exits or spawn, generator
 * version 3, its world chunk (the Tangle's middle chunk (0, -1), the
 * Whitequiet's (0, -4)), a tier and a land. The woods in it are the
 * generator's own. A fixture already in v3 passes through unchanged.
 */
import { readFileSync } from 'node:fs';
import { clone, fromBinary, toBinary } from '@bufbuild/protobuf';
import { decodeChunk } from '../src/lib/api/chunks.ts';
import { WildsChunkSchema, type WildsChunk } from '../src/lib/gen/glimway/v1/wilds_pb.js';
import { terrainOf, type ChunkTerrain } from '../src/game/wilds/terrain.ts';

export type FixtureRegion = 'inner-1' | 'outer-1';

/** Where each fixture stands on the open map. */
export const FIXTURE_AT: Record<FixtureRegion, { cx: number; cy: number; tier: number }> = {
  'inner-1': { cx: 0, cy: -1, tier: 1 },
  'outer-1': { cx: 0, cy: -4, tier: 2 },
};

function rawBytes(region: FixtureRegion): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/wilds-${region === 'inner-1' ? 'inner' : 'outer'}-1-1.bin`, import.meta.url)));
}

/** A fixture as a v3 chunk (not yet validated). */
export function openMapChunk(region: FixtureRegion, at: { cx: number; cy: number } = FIXTURE_AT[region]): WildsChunk {
  const c = clone(WildsChunkSchema, fromBinary(WildsChunkSchema, rawBytes(region)));
  if (c.generatorVersion < 3) {
    c.region = '';
    c.exits = [];
    c.spawn = undefined;
    c.generatorVersion = 3;
    c.tier = FIXTURE_AT[region].tier;
    c.land = 'woods';
    c.places = [];
  }
  c.cx = at.cx;
  c.cy = at.cy;
  // Entity ids name their chunk (`<kind>:<cx>:<cy>:<i>`).
  c.entities.forEach((e, i) => (e.id = `${e.kind}:${at.cx}:${at.cy}:${i}`));
  return c;
}

export function fixtureBytes(region: FixtureRegion): Uint8Array {
  return toBinary(WildsChunkSchema, openMapChunk(region));
}

export function fixtureChunk(region: FixtureRegion): WildsChunk {
  return decodeChunk(fixtureBytes(region));
}

export function fixtureTerrain(region: FixtureRegion): ChunkTerrain {
  return terrainOf(fixtureChunk(region));
}
