/**
 * The server's own chunks for client tests: tests/fixtures/wilds-*.bin are
 * real generator v3 chunks of one world (seed `client-fixtures`), written
 * and checked current by server/internal/wilds TestClientFixtures:
 *
 * - `tangle`: chunk (0, -1), the Tangle's middle, in the still epoch;
 * - `whitequiet-0-5`, `-1-5`, `-0-4`, `-1-4`: a 2x2 block of the Whitequiet
 *   in the wick epoch (neighbours: the seam tests read across their edges);
 * - `road`: the first chunk of the Beyond with a dark lamp stone;
 * - `ford`: the first with a ford over the Wend.
 */
import { readFileSync } from 'node:fs';
import { clone } from '@bufbuild/protobuf';
import { decodeChunk } from '../src/lib/api/chunks.ts';
import { WorldChunkSchema, type WorldChunk } from '../src/lib/gen/glimway/v1/wilds_pb.js';
import { terrainOf, type ChunkTerrain } from '../src/game/wilds/terrain.ts';

export type FixtureName = 'tangle' | 'whitequiet-0-5' | 'whitequiet-1-5' | 'whitequiet-0-4' | 'whitequiet-1-4' | 'road' | 'ford';

export function fixtureBytes(name: FixtureName): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/wilds-${name}.bin`, import.meta.url)));
}

/** A fixture, decoded and validated as the client does. */
export function fixtureChunk(name: FixtureName): WorldChunk {
  return decodeChunk(fixtureBytes(name));
}

export function fixtureTerrain(name: FixtureName): ChunkTerrain {
  return terrainOf(fixtureChunk(name));
}

/**
 * A fixture's land served as another chunk (a test world bigger than the
 * fixtures): the same body under other coordinates, its entity ids naming
 * the new chunk (`<kind>:<cx>:<cy>:<i>`).
 */
export function chunkAt(name: FixtureName, cx: number, cy: number): WorldChunk {
  const c = clone(WorldChunkSchema, fixtureChunk(name));
  c.cx = cx;
  c.cy = cy;
  c.entities.forEach((e, i) => (e.id = `${e.kind}:${cx}:${cy}:${i}`));
  return c;
}
