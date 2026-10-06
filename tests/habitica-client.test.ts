import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HabiticaApiError,
  USER_FIELDS,
  createHabiticaClient,
} from '../src/lib/habitica/client.ts';
import { toHabiticaProfile } from '../src/lib/habitica/mapping.ts';
import { FIXTURES_BY_KEY, gearLookupFor } from '../src/lib/habitica/fixtures.ts';
import type { HabiticaCredentials } from '../src/lib/habitica/types.ts';

const CREDENTIALS: HabiticaCredentials = {
  userId: 'user-id-abc123',
  apiToken: 'api-token-secret-xyz789',
  clientTag: 'user-id-abc123-fingersnap',
};

function okBody() {
  const fixture = FIXTURES_BY_KEY.lowLevel;
  return new Response(
    JSON.stringify({ success: true, data: fixture.user }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function clientWith(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return createHabiticaClient({
    credentials: CREDENTIALS,
    gearStats: gearLookupFor(FIXTURES_BY_KEY.lowLevel.gearStats),
    fetchImpl,
    ...extra,
  });
}

test('client exposes fetchProfile only — no write surface', () => {
  const client = clientWith((() => Promise.resolve(okBody())) as typeof fetch);
  assert.deepEqual(Object.keys(client), ['fetchProfile']);
});

test('fetchProfile sends the minimal projection and required headers', async () => {
  let seenUrl = '';
  let seenInit: RequestInit | undefined;
  const client = clientWith((async (input, init) => {
    seenUrl = String(input);
    seenInit = init;
    return okBody();
  }) as typeof fetch);

  const profile = await client.fetchProfile();
  assert.equal(profile.name, 'Tansy');
  assert.ok(seenUrl.startsWith('https://habitica.com/api/v3/user?userFields='));
  assert.ok(seenUrl.includes(encodeURIComponent(USER_FIELDS)));
  assert.ok(!seenUrl.includes(CREDENTIALS.apiToken), 'token must never appear in the URL');
  assert.ok(!seenUrl.includes(CREDENTIALS.userId), 'user id travels in headers, not the URL');

  const headers = seenInit?.headers as Record<string, string>;
  assert.equal(headers['x-api-user'], CREDENTIALS.userId);
  assert.equal(headers['x-api-key'], CREDENTIALS.apiToken);
  assert.equal(headers['x-client'], CREDENTIALS.clientTag);
  assert.equal(seenInit?.method, 'GET');
  assert.ok(seenInit?.signal, 'request must be abortable (timeout)');
});

test('401 becomes a typed auth error that never echoes credentials', async () => {
  const client = clientWith((async () =>
    new Response('{"success":false}', { status: 401 })) as typeof fetch);
  await assert.rejects(client.fetchProfile(), (err: unknown) => {
    assert.ok(err instanceof HabiticaApiError);
    assert.equal(err.kind, 'auth');
    assert.equal(err.status, 401);
    assert.ok(!err.message.includes(CREDENTIALS.apiToken));
    assert.ok(!err.message.includes(CREDENTIALS.userId));
    return true;
  });
});

test('403 is also an auth error', async () => {
  const client = clientWith((async () =>
    new Response('', { status: 403 })) as typeof fetch);
  await assert.rejects(client.fetchProfile(), (err: unknown) => {
    assert.ok(err instanceof HabiticaApiError);
    assert.equal(err.kind, 'auth');
    return true;
  });
});

test('429 backs off by Retry-After then retries and succeeds', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const client = clientWith((async () => {
    calls += 1;
    if (calls === 1) {
      return new Response('', { status: 429, headers: { 'retry-after': '2' } });
    }
    return okBody();
  }) as typeof fetch, {
    sleep: async (ms: number) => {
      sleeps.push(ms as number);
    },
  });

  const profile = await client.fetchProfile();
  assert.equal(profile.name, 'Tansy');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [2000]);
});

test('429 without Retry-After uses the default backoff', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const client = clientWith((async () => {
    calls += 1;
    return calls === 1
      ? new Response('', { status: 429 })
      : okBody();
  }) as typeof fetch, {
    sleep: async (ms: number) => {
      sleeps.push(ms as number);
    },
  });
  await client.fetchProfile();
  assert.deepEqual(sleeps, [1000]);
});

test('persistent 429 gives up after maxRateLimitRetries with typed error', async () => {
  const sleeps: number[] = [];
  let calls = 0;
  const client = clientWith((async () => {
    calls += 1;
    return new Response('', { status: 429, headers: { 'retry-after': '1' } });
  }) as typeof fetch, {
    maxRateLimitRetries: 2,
    sleep: async (ms: number) => {
      sleeps.push(ms as number);
    },
  });
  await assert.rejects(client.fetchProfile(), (err: unknown) => {
    assert.ok(err instanceof HabiticaApiError);
    assert.equal(err.kind, 'rate-limited');
    assert.equal(err.status, 429);
    assert.equal(err.retryAfterMs, 1000);
    return true;
  });
  assert.equal(calls, 3); // initial + 2 retries
  assert.deepEqual(sleeps, [1000, 1000]);
});

test('a hanging request times out with a typed error', async () => {
  const client = clientWith((() => new Promise<Response>(() => {})) as typeof fetch, {
    timeoutMs: 5,
  });
  await assert.rejects(client.fetchProfile(), (err: unknown) => {
    assert.ok(err instanceof HabiticaApiError);
    assert.equal(err.kind, 'timeout');
    assert.ok(!err.message.includes(CREDENTIALS.apiToken));
    return true;
  });
});

test('network failures map to a typed network error', async () => {
  const client = clientWith((async () => {
    throw new TypeError('fetch failed');
  }) as typeof fetch);
  await assert.rejects(client.fetchProfile(), (err: unknown) => {
    assert.ok(err instanceof HabiticaApiError);
    assert.equal(err.kind, 'network');
    return true;
  });
});

test('other HTTP failures map to http errors with the status', async () => {
  const client = clientWith((async () =>
    new Response('', { status: 500 })) as typeof fetch);
  await assert.rejects(client.fetchProfile(), (err: unknown) => {
    assert.ok(err instanceof HabiticaApiError);
    assert.equal(err.kind, 'http');
    assert.equal(err.status, 500);
    return true;
  });
});

test('unreadable or empty bodies map to invalid-response', async () => {
  const badJson = clientWith((async () =>
    new Response('<html>', { status: 200 })) as typeof fetch);
  await assert.rejects(badJson.fetchProfile(), (err: unknown) => {
    assert.ok(err instanceof HabiticaApiError);
    assert.equal(err.kind, 'invalid-response');
    return true;
  });

  const noData = clientWith((async () =>
    new Response(JSON.stringify({ success: true }), { status: 200 })) as typeof fetch);
  await assert.rejects(noData.fetchProfile(), (err: unknown) => {
    assert.ok(err instanceof HabiticaApiError);
    assert.equal(err.kind, 'invalid-response');
    return true;
  });
});

test('profile payloads are validated — invalid user data is invalid-response', async () => {
  const client = clientWith((async () =>
    new Response(JSON.stringify({ success: true, data: { stats: {} } }), {
      status: 200,
    })) as typeof fetch);
  await assert.rejects(client.fetchProfile(), (err: unknown) => {
    assert.ok(err instanceof HabiticaApiError);
    assert.equal(err.kind, 'invalid-response');
    return true;
  });
});

test('USER_FIELDS projects companions and costume for real imports', () => {
  assert.ok(USER_FIELDS.includes('items.currentPet'));
  assert.ok(USER_FIELDS.includes('items.currentMount'));
  assert.ok(USER_FIELDS.includes('items.gear.costume'));
  assert.ok(USER_FIELDS.includes('items.gear.equipped'));
  assert.ok(USER_FIELDS.includes('flags.classSelected'));
  // The party id, which a world sign-in tells the server to expect.
  assert.ok(USER_FIELDS.split(',').includes('party._id'));
});

test('default client uses the real gear catalog (actual gear stats)', async () => {
  // No gearStats override: defaults to gearStatsFor from the bundled catalog.
  let seenUrl = '';
  const client = createHabiticaClient({
    credentials: CREDENTIALS,
    fetchImpl: (async (input) => {
      seenUrl = String(input);
      return okBody();
    }) as typeof fetch,
  });
  const profile = await client.fetchProfile();
  assert.ok(seenUrl.includes(encodeURIComponent(USER_FIELDS)));
  // Tansy (lowLevel) wears weapon_warrior_1 + armor_warrior_1 (class warrior):
  // the real catalog must add to the gear-less baseline (base + level only).
  const withoutGear = toHabiticaProfile(FIXTURES_BY_KEY.lowLevel.user);
  assert.ok(profile.stats.str > withoutGear.stats.str, 'real weapon stats must reach effective STR');
  assert.ok(profile.stats.con > withoutGear.stats.con, 'real armor stats must reach effective CON');
  assert.equal(profile.maxHp, 50);
});

test('explicit gearStats override replaces the catalog lookup', async () => {
  const calls: string[] = [];
  const client = createHabiticaClient({
    credentials: CREDENTIALS,
    gearStats: (key) => {
      calls.push(key);
      return { str: 100 };
    },
    fetchImpl: (async () => okBody()) as typeof fetch,
  });
  const profile = await client.fetchProfile();
  assert.ok(calls.length > 0, 'override lookup must be consulted');
  assert.ok(profile.stats.str >= 100);
});
