import test from 'node:test';
import assert from 'node:assert/strict';
import { avatarLayersFor, localSpriteUrl, proxiedSpriteUrl, type AvatarProfileFull } from '../src/lib/habitica/avatar.ts';
import { SpriteCache, SPRITE_CACHE, type SpriteCacheDeps } from '../src/lib/habitica/sprite-cache.ts';
import { resolveLayers } from '../src/game/avatar-render.ts';

/** A Cache Storage stand-in: one named cache of url -> Response. */
function memoryCaches(): CacheStorage & { stores: Map<string, Map<string, Response>> } {
  const stores = new Map<string, Map<string, Response>>();
  return {
    stores,
    async open(name: string) {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return {
        async match(url: string) {
          return store.get(url)?.clone();
        },
        async put(url: string, res: Response) {
          store.set(url, res);
        },
      } as unknown as Cache;
    },
  } as unknown as CacheStorage & { stores: Map<string, Map<string, Response>> };
}

function deps(over: Partial<SpriteCacheDeps> & { answer?: (url: string) => Response }) {
  const calls: { url: string; init: RequestInit }[] = [];
  let n = 0;
  const d: SpriteCacheDeps = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return over.answer ? over.answer(url) : new Response(new Uint8Array([137, 80, 78, 71]), { status: 200, headers: { 'content-type': 'image/png' } });
    },
    caches: over.caches ?? null,
    createObjectURL: () => `blob:fs/${++n}`,
    ...('fetch' in over ? { fetch: over.fetch! } : {}),
  };
  return { d, calls };
}

test('missing outfit pieces come through our own sprite proxy, with the upstream extension', () => {
  assert.equal(proxiedSpriteUrl('slim_armor_warrior_2'), '/api/sprites/slim_armor_warrior_2.png');
  assert.equal(proxiedSpriteUrl('Pet-Wolf-Cerberus'), '/api/sprites/Pet-Wolf-Cerberus.gif');
  assert.equal(proxiedSpriteUrl('weird name/1'), '/api/sprites/weird%20name%2F1.png');
});

test('a fetched piece is kept on the device: the next visit asks nobody', async () => {
  const caches = memoryCaches();
  const first = deps({ caches });
  const url = await new SpriteCache(first.d).src('head_warrior_3');
  assert.match(url ?? '', /^blob:/);
  assert.equal(first.calls.length, 1);
  assert.equal(first.calls[0].url, '/api/sprites/head_warrior_3.png');
  // Our own origin only, no extra headers: no Habitica credentials go out for art.
  assert.equal(first.calls[0].init.credentials, 'same-origin');
  assert.ok(first.calls[0].url.startsWith('/api/sprites/'));
  assert.equal(first.calls[0].init.headers, undefined);
  assert.ok(caches.stores.get(SPRITE_CACHE)?.has('/api/sprites/head_warrior_3.png'));

  // A new tab (a fresh SpriteCache) on the same device: served from Cache Storage.
  const second = deps({ caches });
  assert.match((await new SpriteCache(second.d).src('head_warrior_3')) ?? '', /^blob:/);
  assert.equal(second.calls.length, 0);
});

test('one ask per piece per tab; a piece Habitica lacks is not asked for again', async () => {
  const { d, calls } = deps({ answer: (url) => new Response('', { status: url.includes('nope') ? 404 : 200, headers: { 'content-type': 'image/png' } }) });
  const cache = new SpriteCache(d);
  const [a, b] = await Promise.all([cache.src('head_warrior_3'), cache.src('head_warrior_3')]);
  assert.equal(a, b);
  assert.equal(await cache.src('nope'), null);
  assert.equal(await cache.src('nope'), null);
  assert.deepEqual(calls.map((c) => c.url), ['/api/sprites/head_warrior_3.png', '/api/sprites/nope.png']);
});

test('no server (or a hiccup): null now, asked again next time; never a non-image', async () => {
  let up = false;
  const { d, calls } = deps({
    answer: () => (up ? new Response('x', { status: 200, headers: { 'content-type': 'image/png' } }) : new Response('<html>', { status: 502, headers: { 'content-type': 'text/html' } })),
  });
  const cache = new SpriteCache(d);
  assert.equal(await cache.src('head_warrior_3'), null);
  up = true;
  assert.match((await cache.src('head_warrior_3')) ?? '', /^blob:/);
  assert.equal(calls.length, 2);

  const html = deps({ answer: () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  assert.equal(await new SpriteCache(html.d).src('head_warrior_3'), null);
  const offline = deps({ fetch: async () => { throw new TypeError('Failed to fetch'); } });
  assert.equal(await new SpriteCache(offline.d).src('head_warrior_3'), null);
});

test('every layer resolves to same-origin art: bundled as is, the rest via the cache', async () => {
  const profile = {
    class: 'warrior',
    level: 10,
    appearance: { size: 'slim', shirt: 'blue', skin: 'f5a76e', hairColor: 'brown', hairStyle: 1 },
    equipped: { armor: 'armor_warrior_2', head: 'head_warrior_1', weapon: 'weapon_warrior_1', shield: 'shield_warrior_2' },
  } as unknown as AvatarProfileFull;
  const layers = avatarLayersFor(profile);
  const asked: string[] = [];
  const { refs, unavailable } = await resolveLayers(layers, async (name) => {
    asked.push(name);
    return name === 'shield_warrior_2' ? null : `blob:fs/${name}`;
  });
  // Bundled pieces never touch the network.
  assert.deepEqual(asked.sort(), ['shield_warrior_2', 'slim_armor_warrior_2']);
  assert.deepEqual(unavailable, ['shield_warrior_2']);
  assert.equal(refs.find((r) => r.key === 'head_0')?.url, localSpriteUrl('head_0'));
  assert.equal(refs.find((r) => r.key === 'slim_armor_warrior_2')?.url, 'blob:fs/slim_armor_warrior_2');
  // Order kept (the official stack), the missing one simply absent.
  assert.deepEqual(refs.map((r) => r.key), layers.map((l) => l.key).filter((k) => k !== 'shield_warrior_2'));
  for (const r of refs) assert.ok(!r.url.startsWith('http'), `${r.key} must be same-origin: ${r.url}`);
});
