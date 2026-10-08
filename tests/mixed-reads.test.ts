import test from 'node:test';
import assert from 'node:assert/strict';
import { createApiClient, mixedRead, parseOperationResult } from '../src/lib/api/client.ts';
import { createRemoteLibrary } from '../src/lib/papers/library.ts';
import { BASE } from './helpers/link-rig.ts';

/** Lane B's mixed read envelope (`{ state, result }`) through the existing domain parsers. */

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const storage = { home: null, inventory: { materials: { fiber: 4 }, items: {}, decorations: {} }, storage: null, personal: { materials: {}, items: {}, decorations: {} }, shared: 'not-a-member' };

test('domain reads find their extras under result, beside the typed state', async () => {
  const fetchImpl = (async (url: string) => {
    if (url === '/api/storage') return json({ state: BASE, result: storage });
    if (url === '/api/commons') return json({ state: BASE, result: { gateCount: 4, gates: [], invites: [], mine: null } });
    throw new Error(url);
  }) as typeof fetch;
  const api = createApiClient({ fetchImpl });
  const s = await api.storage();
  assert.equal(s.inventory.materials.fiber, 4);
  assert.equal(s.player?.version, 1, 'the state is kept for adoption');
  const c = await api.commons();
  assert.equal(c.gateCount, 4);
});

test('a bare (pre-mixed) answer passes through unchanged', () => {
  const raw = { state: BASE, items: [] };
  assert.equal(mixedRead(raw), raw);
});

test('the library shelf reads the mixed envelope too', async () => {
  const entry = { paperId: 'will-of-elias-fenn', donatedBy: 'Tansy', donatedAt: '2026-10-04T10:00:00Z' };
  const fetchImpl = (async () => json({ state: BASE, result: { shelves: [entry] } })) as unknown as typeof fetch;
  assert.deepEqual(await createRemoteLibrary({ fetchImpl }).load(), { ok: true, shelves: [entry] });
});

test('the reconciliation read: a committed operation, or none; malformed rows are bad responses', () => {
  const op = { route: '/api/story/mark', key: 'k', payload: { mark: 'seen:a' }, payloadHash: 'h', version: 1, result: { mark: 'seen:a', added: true }, resultCase: 'mark', resultType: 'glimway.v1.MarkResult' };
  assert.equal(parseOperationResult({ state: BASE, result: { operation: op } }).operation?.resultCase, 'mark');
  assert.equal(parseOperationResult({ state: BASE, result: { operation: null } }).operation, null);
  assert.throws(() => parseOperationResult({ state: BASE, result: { operation: { route: 1 } } }));
});
