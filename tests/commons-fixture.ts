/**
 * The Commons as the server serves it, for client tests: tests/fixtures/
 * commons-<cx>-<cy>.bin are the six fixed chunks of content/layouts/
 * commons.json, written and checked current by server/internal/chunks
 * TestFixedChunkBytesPerRevision (UPDATE_CLIENT_FIXTURES=1).
 */
import { readFileSync } from 'node:fs';
import { decodeChunk } from '../src/lib/api/chunks.ts';
import type { WorldChunk } from '../src/lib/gen/glimway/v1/wilds_pb.js';
import { assembleCommons, commonsChunkKeys, serveCommonsChunks, type CommonsDay, type CommonsWorld } from '../src/game/commons-served.ts';

export function commonsFixtureBytes(cx: number, cy: number): Uint8Array {
  return new Uint8Array(readFileSync(new URL(`./fixtures/commons-${cx}-${cy}.bin`, import.meta.url)));
}

/** The six chunks, decoded and validated as the client does, row-major. */
export function commonsFixtureChunks(): WorldChunk[] {
  return commonsChunkKeys().map(({ cx, cy }) => decodeChunk(commonsFixtureBytes(cx, cy)));
}

/** The Commons area (buildArea('commons')) draws from the fixture, as if the server had served it. */
export function serveFixtureCommons(): void {
  serveCommonsChunks(commonsFixtureChunks());
}

/** The served Commons on a day with nothing out (or `day`'s festival and wick). */
export function servedCommonsFixture(day: CommonsDay = { festival: null, wick: 'Quiet' }): CommonsWorld {
  return assembleCommons(commonsFixtureChunks(), day);
}
