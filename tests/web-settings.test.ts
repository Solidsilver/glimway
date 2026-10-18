import test from 'node:test';
import assert from 'node:assert/strict';
import { loadWebSettings, onWebSettings, parseWebSettings, webSettings } from '../src/lib/web-settings.ts';
import { DEV_TOOLS, devTools } from '../src/lib/dev-tools.ts';

/** The web client's settings (GET /api/web-settings; docs/design/server-settings.md). */

test('the answer is read strictly: only true turns a tool on', () => {
  assert.deepEqual(parseWebSettings({ dev: null }), { dev: null });
  assert.deepEqual(parseWebSettings(null), { dev: null });
  assert.deepEqual(parseWebSettings({ dev: { grant: true, hooks: 'yes', clock: 1, fight_fall: true } }), {
    dev: { grant: true, hooks: false, clock: false, fight_fall: true },
  });
});

test('loading tells listeners, and no route or no answer is no settings', async () => {
  const seen: unknown[] = [];
  const off = onWebSettings((s) => seen.push(s));
  const answer = (status: number, body: unknown) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
  await loadWebSettings(answer(200, { dev: { grant: true, hooks: true, clock: false, fight_fall: false } }));
  assert.equal(webSettings().dev?.grant, true);
  await loadWebSettings(answer(404, { error: { code: 'not-found' } }));
  assert.equal(webSettings().dev, null);
  await loadWebSettings((async () => {
    throw new Error('offline');
  }) as typeof fetch);
  assert.equal(webSettings().dev, null);
  off();
  assert.equal(seen.length, 3);
});

test('a build without dev tools shows none, whatever the server says', async () => {
  assert.equal(DEV_TOOLS, false); // Node: no Vite define
  await loadWebSettings((async () => new Response(JSON.stringify({ dev: { grant: true, hooks: true, clock: true, fight_fall: true } }))) as typeof fetch);
  assert.equal(devTools(), null);
});
