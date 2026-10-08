/**
 * The server's own land for client tests: tests/fixtures/home-land.json is
 * written (and checked current) by server/internal/land TestClientFixture.
 */
import { readFileSync } from 'node:fs';
import { landFromCells, rememberLand, type Land } from '../src/lib/homestead-land.ts';

export const FIXTURE_LAND: Land = landFromCells(JSON.parse(readFileSync(new URL('./fixtures/home-land.json', import.meta.url), 'utf8')));

/** Serve the fixture land for every gate a test visits in a world. */
export function serveFixtureLand(world: string, gates = 64): void {
  for (let g = 0; g < gates; g++) rememberLand(world, g, FIXTURE_LAND);
}
