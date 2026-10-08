import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/lib/api/queue.ts';
import { ApiError, errorFromResponse, isUnreachable, parseRetryAfter, SERVER_ERROR_CODES } from '../src/lib/api/errors.ts';
import { claimClientId, createApiClient, inviteCodeParts, newKey, normalizeInviteCode } from '../src/lib/api/client.ts';
import { createNewGame, type GameState } from '../src/lib/state.ts';
import { parseItemsAction, parseWildsClaim } from '../src/lib/api/parse.ts';
import type { Progress } from '../src/lib/api/types.ts';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function snapshot(over: Partial<Record<string, unknown>> = {}) {
  return {
    state: createNewGame(),
    version: 3,
    vitalsSource: 'imported',
    accountId: 'hab-1',
    habiticaPartyId: null,
    worldId: 'w',
    saveOrigin: 'fresh',
    pending: 0,
    verifiedXp: 45,
    flagged: false,
    ...over,
  };
}

// ---------------------------------------------------------------- queue

test('queue: tasks run one at a time, in order', async () => {
  const q = createQueue();
  const log: string[] = [];
  let running = 0;
  const task = (name: string, ms: number) => () =>
    new Promise<string>((resolve) => {
      running += 1;
      assert.equal(running, 1, 'never two at once');
      log.push(`start ${name}`);
      setTimeout(() => {
        log.push(`end ${name}`);
        running -= 1;
        resolve(name);
      }, ms);
    });
  const results = await Promise.all([q.run(task('a', 20)), q.run(task('b', 1)), q.run(task('c', 5))]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
  assert.equal(q.size, 0);
});

test('Wilds claim parser preserves and validates rare warden sliver finds', () => {
  const raw = {
    ...snapshot(),
    result: {
      epoch: 'epoch-1',
      entity: { id: 'node-1', kind: 'node', tx: 1, ty: 1, tier: 0, cycle: 1, state: 'harvested', available_at: 0, by: null, at: null },
      loot: { materials: [], trinket: null },
      materials: {},
      wardenSliverFound: true,
    },
  };
  assert.equal(parseWildsClaim(raw).result.wardenSliverFound, true);
  assert.throws(() => parseWildsClaim({ ...raw, result: { ...raw.result, wardenSliverFound: 'yes' } }));
  // The storm-grade drop rides the same claim answer (the toast reads it).
  assert.equal(parseWildsClaim({ ...raw, result: { ...raw.result, stormDropFound: true } }).result.stormDropFound, true);
  assert.equal(parseWildsClaim(raw).result.stormDropFound, undefined);
  assert.throws(() => parseWildsClaim({ ...raw, result: { ...raw.result, stormDropFound: 'yes' } }));
});

test('items parser keeps what a seller handed over (/api/items/buy)', () => {
  const items = { stacks: [{ itemDef: 'tallow', qty: 1, maker: null }], instances: [], pockets: [], offHand: { open: false, class: null, itemDef: null, instance: null }, pickedUp: [], thanks: [] };
  const raw = { ...snapshot(), result: { items, bought: { seller: 'hazels-kitchen', itemDef: 'tallow', qty: 1, embers: 1 } } };
  assert.deepEqual(parseItemsAction(raw).result.bought, { seller: 'hazels-kitchen', itemDef: 'tallow', qty: 1, embers: 1 });
  assert.equal(parseItemsAction({ ...raw, result: { items } }).result.bought, undefined);
});

test('queue: a failure goes to its own caller and the queue keeps going', async () => {
  const q = createQueue();
  const failed = q.run(async () => {
    throw new Error('boom');
  });
  const next = q.run(async () => 'ok');
  await assert.rejects(failed, /boom/);
  assert.equal(await next, 'ok');
});

test('queue: idle waits for everything queued so far', async () => {
  const q = createQueue();
  let done = false;
  void q.run(() => new Promise((r) => setTimeout(() => ((done = true), r(undefined)), 10)));
  assert.equal(q.size, 1);
  await q.idle();
  assert.equal(done, true);
});

test('client: run builds each request when it starts, after earlier calls settle', async () => {
  const seen: number[] = [];
  let rev = 3;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    seen.push(body.baseRev);
    rev += 1;
    return json(200, { ...snapshot({ version: rev }), status: 'current' });
  }) as typeof fetch;
  const api = createApiClient({ fetchImpl });
  let current = 3;
  const doc: Progress = { version: 1, area: 'village', position: { x: 1, y: 1 }, quest: 'new', hp: 1, mana: 1, inventory: [], discoveries: [], defeatedEnemies: [], flags: [], playSeconds: 0 };
  const upload = () =>
    api.run(async (raw) => {
      const res = await raw.progress({ lease: 'L', baseRev: current, doc: { ...doc } });
      current = res.rev;
      return res;
    });
  await Promise.all([upload(), upload(), upload()]);
  assert.deepEqual(seen, [3, 4, 5]);
});

// ---------------------------------------------------------------- errors

test('errors: every documented code maps to itself with its status', () => {
  assert.equal(new Set(SERVER_ERROR_CODES).size, SERVER_ERROR_CODES.length, 'no duplicate codes');
  for (const code of SERVER_ERROR_CODES) {
    const err = errorFromResponse(409, { error: { code } });
    assert.equal(err.code, code);
    assert.equal(err.status, 409);
  }
});

test('client: crafting refusals survive the real hearth, desk and woodpile methods', async () => {
  const envelope = { lease: 'L', baseRev: 3, key: 'craft-refused' };
  const cases = [
    { code: 'recipe-unknown', status: 409, path: '/api/hearth/craft', call: (api: ReturnType<typeof createApiClient>) => api.hearthCraft({ ...envelope, recipeId: 'herb-broth', qty: 1 }) },
    { code: 'desk-required', status: 409, path: '/api/desk/copy', call: (api: ReturnType<typeof createApiClient>) => api.deskCopy({ ...envelope, pageId: 'recipe-page', qty: 1 }) },
    { code: 'invalid-page', status: 400, path: '/api/desk/copy', call: (api: ReturnType<typeof createApiClient>) => api.deskCopy({ ...envelope, pageId: 'timber', qty: 1 }) },
    { code: 'page-not-held', status: 409, path: '/api/desk/copy', call: (api: ReturnType<typeof createApiClient>) => api.deskCopy({ ...envelope, pageId: 'recipe-page', qty: 1 }) },
    { code: 'woodpile-required', status: 409, path: '/api/homestead/woodpile', call: (api: ReturnType<typeof createApiClient>) => api.woodpile() },
    { code: 'nothing-ready', status: 409, path: '/api/homestead/woodpile', call: (api: ReturnType<typeof createApiClient>) => api.woodpileAction({ ...envelope, action: 'collect' }) },
    { code: 'invalid-action', status: 400, path: '/api/homestead/woodpile', call: (api: ReturnType<typeof createApiClient>) => api.woodpileAction({ ...envelope, action: 'stack', qty: 1 }) },
  ];
  for (const c of cases) {
    const api = createApiClient({ fetchImpl: (async (url: string) => {
      assert.equal(url, c.path);
      return json(c.status, { error: { code: c.code } });
    }) as typeof fetch });
    await assert.rejects(c.call(api), (e: unknown) => e instanceof ApiError && e.code === c.code && e.status === c.status, c.code);
  }
});

test('errors: messages are static and never echo the body', () => {
  const secret = 'token-secret-123';
  const err = errorFromResponse(400, { error: { code: 'invalid-credentials', detail: secret } });
  assert.ok(!err.message.includes(secret));
  const weird = errorFromResponse(400, { error: { code: secret } });
  assert.equal(weird.code, 'unknown');
  assert.ok(!weird.message.includes(secret));
});

test('errors: a body without the server shape means no Glimway server', () => {
  assert.equal(errorFromResponse(404, undefined).code, 'unavailable');
  assert.equal(errorFromResponse(502, { message: 'bad gateway' }).code, 'unavailable');
  assert.equal(isUnreachable(errorFromResponse(404, undefined)), true);
  assert.equal(isUnreachable(new ApiError('superseded')), false);
});

test('errors: 429s carry Retry-After (seconds or a date), capped at a minute', () => {
  assert.equal(errorFromResponse(429, { error: { code: 'login-rate-limited' } }, '7').retryAfterMs, 7000);
  assert.equal(errorFromResponse(429, { error: { code: 'login-busy' } }, null).retryAfterMs, 1000);
  assert.equal(parseRetryAfter('600'), 60_000);
  const now = Date.parse('2026-10-04T00:00:00Z');
  assert.equal(parseRetryAfter('Sun, 04 Oct 2026 00:00:05 GMT', now), 5000);
});

test('client: network failures, HTML fallbacks and timeouts are typed', async () => {
  const offline = createApiClient({ fetchImpl: (async () => { throw new TypeError('Failed to fetch'); }) as typeof fetch });
  await assert.rejects(offline.state(), (e: unknown) => e instanceof ApiError && e.code === 'network');

  const html = createApiClient({
    fetchImpl: (async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })) as typeof fetch,
  });
  await assert.rejects(html.state(), (e: unknown) => e instanceof ApiError && e.code === 'unavailable');

  const hang = createApiClient({
    timeoutMs: 10,
    fetchImpl: ((_u: string, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))) as typeof fetch,
  });
  await assert.rejects(hang.state(), (e: unknown) => e instanceof ApiError && e.code === 'network');
});

test('client: same-origin cookies, JSON bodies, lease header, invite trimmed', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createApiClient({
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return json(200, snapshot());
    }) as typeof fetch,
  });
  await api.state('LEASE');
  await api.login({ userId: 'u', token: 't', invite: '  code  ' });
  await api.login({ userId: 'u', token: 't', invite: '' });
  assert.equal(calls[0].url, '/api/state');
  assert.equal(calls[0].init.credentials, 'same-origin');
  assert.equal((calls[0].init.headers as Record<string, string>)['X-Play-Lease'], 'LEASE');
  assert.equal((calls[1].init.headers as Record<string, string>)['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { userId: 'u', token: 't', invite: 'code' });
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), { userId: 'u', token: 't' });
});

test('client: invites POST an empty JSON object and revoke by encoded id', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createApiClient({
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (init.method === 'POST') return json(200, { id: 'h', createdAt: 1, expiresAt: 2, used: false, code: 'c0de' });
      if (init.method === 'GET') return json(200, { invites: [{ id: 'h', createdAt: 1, expiresAt: 2, used: true }], remaining: 4, outstandingLimit: 3, partyWorld: false, partyAdmitted: false });
      return json(200, { ok: true });
    }) as typeof fetch,
  });
  assert.equal((await api.createInvite()).code, 'c0de');
  assert.equal(calls[0].init.body, '{}');
  assert.deepEqual(await api.listInvites(), { invites: [{ id: 'h', createdAt: 1, expiresAt: 2, used: true }], remaining: 4, outstandingLimit: 3, partyWorld: false, partyAdmitted: false });
  await api.revokeInvite('a/b');
  assert.equal(calls[2].url, '/api/invites/a%2Fb');
  assert.equal(calls[2].init.method, 'DELETE');
});

test('client: responses are validated; a bad state is a bad-response, unknown fields are dropped', async () => {
  const bad = createApiClient({ fetchImpl: (async () => json(200, snapshot({ state: { version: 9 } }))) as typeof fetch });
  await assert.rejects(bad.state(), (e: unknown) => e instanceof ApiError && e.code === 'bad-response');
  const extra = createApiClient({
    fetchImpl: (async () => json(200, snapshot({ state: { ...createNewGame(), token: 'x' }, lease: 'L' }))) as typeof fetch,
  });
  const s = await extra.state();
  assert.equal('token' in (s.state as GameState & { token?: string }), false);
});

test('state: displayName and leaseActive are kept; older servers leave them empty/undefined', async () => {
  const api = createApiClient({
    fetchImpl: (async () => json(200, { ...snapshot(), displayName: 'Lantern Keeper', leaseActive: false })) as typeof fetch,
  });
  const s = await api.state('L');
  assert.equal(s.displayName, 'Lantern Keeper');
  assert.equal(s.leaseActive, false);
  const old = createApiClient({ fetchImpl: (async () => json(200, snapshot())) as typeof fetch });
  const o = await old.state();
  assert.equal(o.displayName, '');
  assert.equal(o.leaseActive, undefined);
});

test('invites: missing current contract fields are rejected', async () => {
  const api = createApiClient({ fetchImpl: (async () => json(200, { invites: [], remaining: -1 })) as typeof fetch });
  await assert.rejects(api.listInvites(), { code: 'bad-response' });
});

test('invite codes: typed or pasted any way, they become the canonical form', async () => {
  assert.equal(normalizeInviteCode('  AMBER FOX river - LANTERN   moss ivy 7392  '), 'amber-fox-river-lantern-moss-ivy-7392');
  assert.equal(normalizeInviteCode('amber–fox\nriver—lantern-moss-ivy-7392'), 'amber-fox-river-lantern-moss-ivy-7392');
  assert.equal(normalizeInviteCode('   '), '');
  assert.deepEqual(inviteCodeParts('amber-fox-river-lantern-moss-ivy-7392'), { words: ['amber', 'fox', 'river', 'lantern', 'moss', 'ivy'], number: '7392' });
  assert.deepEqual(inviteCodeParts('ABCDEF0123'), { words: ['abcdef0123'], number: '' });
  // Login sends the canonical form (and nothing for a blank field).
  const bodies: unknown[] = [];
  const api = createApiClient({
    fetchImpl: (async (_u: string, init: RequestInit) => (bodies.push(JSON.parse(String(init.body))), json(200, snapshot()))) as typeof fetch,
  });
  await api.login({ userId: 'u', token: 't', invite: 'Amber Fox River Lantern Moss Ivy 7392' });
  await api.login({ userId: 'u', token: 't', invite: ' - ' });
  assert.deepEqual(bodies, [
    { userId: 'u', token: 't', invite: 'amber-fox-river-lantern-moss-ivy-7392' },
    { userId: 'u', token: 't' },
  ]);
});

test('ids: idempotency keys are unique', () => {
  assert.notEqual(newKey(), newKey());
});

function memoryStorage(initial?: string) {
  const store = new Map<string, string>();
  if (initial) store.set('fingersnap:client-id', initial);
  return { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), store };
}
let channelSeq = 0;
const freshChannel = () => `glimway-client-test-${process.pid}-${channelSeq++}`;
/** Open claims keep Node alive: close them even when an assertion fails. */
const openClaims: Array<{ close(): void }> = [];
const track = <T extends { close(): void }>(c: T): T => (openClaims.push(c), c);
test.afterEach(() => {
  for (const c of openClaims.splice(0)) c.close();
});

test('client id: a reload with no other live page keeps its stored id', async () => {
  const channelName = freshChannel();
  const storage = memoryStorage('stored-id');
  const claim = track(await claimClientId({ storage, channelName, waitMs: 30 }));
  assert.equal(claim.id, 'stored-id');
});

test('client id: a duplicated tab (same stored id, original still open) gets its own id', async () => {
  const channelName = freshChannel();
  const original = track(await claimClientId({ storage: memoryStorage('dup-id'), channelName, waitMs: 30 }));
  const copyStorage = memoryStorage('dup-id'); // "Duplicate tab" copies sessionStorage
  const duplicate = track(await claimClientId({ storage: copyStorage, channelName, waitMs: 300 }));
  assert.equal(original.id, 'dup-id');
  assert.notEqual(duplicate.id, 'dup-id');
  assert.equal(copyStorage.getItem('fingersnap:client-id'), duplicate.id, 'the duplicate remembers its new id');
  // A third page with the duplicate's new id is turned away too.
  const third = track(await claimClientId({ storage: memoryStorage(duplicate.id), channelName, waitMs: 300 }));
  assert.notEqual(third.id, duplicate.id);
});

test('client id: two pages claiming the same id at once end up different', async () => {
  const channelName = freshChannel();
  const [a, b] = (
    await Promise.all([
      claimClientId({ storage: memoryStorage('same'), channelName, waitMs: 300 }),
      claimClientId({ storage: memoryStorage('same'), channelName, waitMs: 300 }),
    ])
  ).map(track);
  assert.notEqual(a.id, b.id);
  assert.ok(a.id === 'same' || b.id === 'same', 'one of them keeps it');
});

/** A BroadcastChannel that can be "frozen": it hears nothing while frozen, like a frozen or bfcached page. */
function freezable(name: string) {
  const ch = new BroadcastChannel(name);
  const box = { frozen: false };
  let handler: ((ev: { data: unknown }) => void) | null = null;
  ch.onmessage = (ev) => {
    if (!box.frozen) handler?.(ev);
  };
  const like = {
    postMessage: (m: unknown) => ch.postMessage(m),
    get onmessage() {
      return handler;
    },
    set onmessage(h) {
      handler = h;
    },
    close: () => ch.close(),
  };
  return { like, box };
}

test('client id: a page frozen during the duplicate\'s claim re-claims on resume and moves to a fresh id (re-review N2)', async () => {
  const channelName = freshChannel();
  const f = freezable(channelName);
  const original = track(await claimClientId({ storage: memoryStorage('shared'), channelName, waitMs: 60, makeChannel: () => f.like }));
  assert.equal(original.id, 'shared');
  f.box.frozen = true; // the original tab is frozen in the background
  const duplicate = track(await claimClientId({ storage: memoryStorage('shared'), channelName, waitMs: 100 }));
  assert.equal(duplicate.id, 'shared', 'nobody answered, so the duplicate kept it');
  f.box.frozen = false; // it resumes and checks again
  const now = await original.reclaim();
  assert.notEqual(now, 'shared');
  assert.equal(original.id, now);
  assert.equal(duplicate.id, 'shared');
  // With nobody else holding it, a re-claim keeps the id.
  assert.equal(await duplicate.reclaim(), 'shared');
});

test('client id: without BroadcastChannel or storage it still works', async () => {
  const noChannel = await claimClientId({ storage: memoryStorage('kept'), makeChannel: () => null, waitMs: 1 });
  assert.equal(noChannel.id, 'kept');
  const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  const c = await claimClientId({ storage: blocked, makeChannel: () => null, waitMs: 1 });
  assert.ok(c.id.length > 0 && c.id.length <= 128);
});

// ---------------------------------------------------------------- hearth, desk, woodpile

const workshopView = { home: null, inventory: { materials: { fiber: 4 }, items: {}, decorations: {} }, storage: null, personal: { materials: {}, items: {}, decorations: {} }, shared: 'not-a-member' };

test('hearth, desk and woodpile: endpoints, method, body and parsed shape', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const api = createApiClient({
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      const base = snapshot();
      if (calls.length === 3) return json(200, { ...base, woodpile: { homesteadId: 'h1', placed: true, stacks: [{ id: 's1', homesteadId: 'h1', accountId: 'a', qty: 10, stackedAt: 100, ready: true, remaining: 0 }], readyCount: 10, totalTimber: 10 } });
      return json(200, { ...base, result: { ...workshopView, recipeId: 'hearth-wax-seal', output: { kind: 'item', id: 'wax-seal', qty: 2 }, pageId: 'recipe-page-tea', qty: 2, woodpile: { homesteadId: 'h1', placed: true, stacks: [], readyCount: 0, totalTimber: 0 }, action: 'stack', collectedQty: undefined } });
    }) as typeof fetch,
  });
  const hearth = await api.hearthCraft({ lease: 'L', baseRev: 3, key: 'k1', recipeId: 'hearth-wax-seal', qty: 2 });
  assert.equal(calls[0].url, '/api/hearth/craft');
  assert.equal(calls[0].init.method, 'POST');
  assert.deepEqual(JSON.parse(String(calls[0].init.body)).recipeId, 'hearth-wax-seal');
  assert.equal(hearth.result.recipeId, 'hearth-wax-seal');
  assert.deepEqual(hearth.result.output, { kind: 'item', id: 'wax-seal', qty: 2 });
  const desk = await api.deskCopy({ lease: 'L', baseRev: 3, key: 'k2', pageId: 'recipe-page-tea', qty: 2 });
  assert.equal(calls[1].url, '/api/desk/copy');
  assert.equal(desk.result.pageId, 'recipe-page-tea');
  assert.equal(desk.result.qty, 2);
  const wp = await api.woodpile();
  assert.equal(calls[2].url, '/api/homestead/woodpile');
  assert.equal(calls[2].init.method, 'GET');
  assert.equal(wp.woodpile.readyCount, 10);
  assert.ok(wp.woodpile.stacks[0].ready);
  const act = await api.woodpileAction({ lease: 'L', baseRev: 3, key: 'k3', action: 'stack', qty: 10 });
  assert.equal(calls[3].url, '/api/homestead/woodpile');
  assert.equal(calls[3].init.method, 'POST');
  assert.equal(act.result.action, 'stack');
  assert.deepEqual(act.result.woodpile.stacks, []);
});
