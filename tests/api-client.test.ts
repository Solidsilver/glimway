import test from 'node:test';
import assert from 'node:assert/strict';
import { createQueue } from '../src/lib/api/queue.ts';
import { ApiError, errorFromResponse, isUnreachable, parseRetryAfter, SERVER_ERROR_CODES } from '../src/lib/api/errors.ts';
import { createApiClient, newKey, tabClientId } from '../src/lib/api/client.ts';
import { createNewGame, type GameState } from '../src/lib/state.ts';
import type { Progress } from '../src/lib/api/types.ts';

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function snapshot(over: Partial<Record<string, unknown>> = {}) {
  return {
    state: createNewGame(),
    rev: 3,
    vitalsSource: 'imported',
    habiticaId: 'hab-1',
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
    return json(200, { ...snapshot({ rev }), status: 'current' });
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
  for (const code of SERVER_ERROR_CODES) {
    const err = errorFromResponse(409, { error: { code } });
    assert.equal(err.code, code);
    assert.equal(err.status, 409);
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

test('errors: a body without the server shape means no Fingersnap server', () => {
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
      if (init.method === 'GET') return json(200, { invites: [{ id: 'h', createdAt: 1, expiresAt: 2, used: true }] });
      return json(200, { ok: true });
    }) as typeof fetch,
  });
  assert.equal((await api.createInvite()).code, 'c0de');
  assert.equal(calls[0].init.body, '{}');
  assert.deepEqual(await api.listInvites(), [{ id: 'h', createdAt: 1, expiresAt: 2, used: true }]);
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

test('ids: idempotency keys are unique; the tab client id survives reloads of the tab', () => {
  assert.notEqual(newKey(), newKey());
  const store = new Map<string, string>();
  const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const first = tabClientId(storage);
  assert.equal(tabClientId(storage), first);
  assert.ok(first.length > 0 && first.length <= 128);
  const blocked = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(tabClientId(blocked), tabClientId(blocked));
});
