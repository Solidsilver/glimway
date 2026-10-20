import test from 'node:test';
import assert from 'node:assert/strict';
import { covers, jsonBreak, jsonProblem, plan, rectChunks, tileAt, viewOf, visibleChunks, zoomAround, ZOOM_MAX, type Limits } from '../src/ui/dev/world-lab/lab-view.ts';
import { labRender, renderBody } from '../src/ui/dev/world-lab/lab-api.ts';

/** The world lab's camera and requests (src/ui/dev/world-lab; server/internal/worldlab). */

const LIMITS: Limits = { atlasChunks: 1_000_000, tiles: 2_400_000, pixels: 16_000_000, scale: 8, coordinate: 100_000 };
const S = 24;
const pane = { w: 1200, h: 800 };

test('auto picks the atlas far out and the region close in', () => {
  assert.equal(viewOf('auto', 0.1), 'atlas');
  assert.equal(viewOf('auto', 2), 'region');
  assert.equal(viewOf('chunk', 0.1), 'chunk');
});

test('a tap and a zoom keep the tile under the pointer', () => {
  const cam = { x: 100, y: -50, zoom: 4 };
  assert.deepEqual(tileAt(cam, pane, 600, 400), { tx: 100, ty: -50 });
  assert.deepEqual(tileAt(cam, pane, 0, 0), { tx: -50, ty: -150 });
  const z = zoomAround(cam, pane, 200, 100, 2);
  assert.deepEqual(tileAt(z, pane, 200, 100), tileAt(cam, pane, 200, 100));
  assert.equal(zoomAround(cam, pane, 0, 0, 1e9).zoom, ZOOM_MAX);
});

test('plans stay inside the server’s limits, cover the view, and fall back to the atlas', () => {
  for (const zoom of [1 / 48, 0.05, 0.3, 1, 1.5, 3, 8, 30]) {
    for (const mode of ['auto', 'atlas', 'region'] as const) {
      const cam = { x: -3000, y: 9000, zoom };
      const p = plan(cam, pane, S, mode, LIMITS);
      const n = rectChunks(p.rect);
      assert.ok(p.scale >= 1 && p.scale <= 8);
      if (p.view === 'atlas') {
        assert.ok(n <= LIMITS.atlasChunks && n * p.scale ** 2 <= LIMITS.pixels, `atlas ${zoom} ${n}`);
      } else {
        assert.ok(n * S * S <= LIMITS.tiles && n * S * S * p.scale ** 2 <= LIMITS.pixels, `region ${zoom} ${n}`);
      }
      const vis = visibleChunks(cam, pane, S);
      if (rectChunks(vis) * (p.view === 'atlas' ? 1 : S * S) <= (p.view === 'atlas' ? LIMITS.atlasChunks : LIMITS.tiles) / 2) {
        assert.ok(p.rect[0] <= vis[0] && p.rect[1] <= vis[1] && p.rect[2] >= vis[2] && p.rect[3] >= vis[3], `${mode} ${zoom} covers`);
      }
    }
  }
  // A dense region zoomed out falls back to the atlas in auto, and is cropped when asked for.
  const far = { x: 0, y: 0, zoom: 1 };
  const tall = { w: 4000, h: 4000 };
  assert.equal(plan(far, tall, S, 'auto', LIMITS).view, 'atlas');
  const cropped = plan(far, tall, S, 'region', LIMITS);
  assert.equal(cropped.view, 'region');
  assert.ok(rectChunks(cropped.rect) * S * S <= LIMITS.tiles);
  assert.deepEqual(plan({ x: -1, y: 25, zoom: 16 }, pane, S, 'chunk', LIMITS), { view: 'chunk', rect: [-1, 1, -1, 1], scale: 8 });
});

test('a small pan reuses what is drawn; another scale or chunk doesn’t', () => {
  const cam = { x: 0, y: 0, zoom: 3 };
  const p = plan(cam, pane, S, 'auto', LIMITS);
  const moved = { ...cam, x: 20 };
  assert.ok(covers(p, plan(moved, pane, S, 'auto', LIMITS), visibleChunks(moved, pane, S)));
  const far = { ...cam, x: 5000 };
  assert.ok(!covers(p, plan(far, pane, S, 'auto', LIMITS), visibleChunks(far, pane, S)));
  const zoomed = { ...cam, zoom: 0.5 };
  assert.ok(!covers(p, plan(zoomed, pane, S, 'auto', LIMITS), visibleChunks(zoomed, pane, S)));
  const c = plan({ x: 0, y: 0, zoom: 16 }, pane, S, 'chunk', LIMITS);
  assert.ok(covers(c, plan({ x: 10, y: 10, zoom: 16 }, pane, S, 'chunk', LIMITS), [0, 0, 0, 0]));
  assert.ok(!covers(c, plan({ x: 30, y: 10, zoom: 16 }, pane, S, 'chunk', LIMITS), [1, 0, 1, 0]));
});

test('a JSON problem says where', () => {
  assert.equal(jsonProblem('{"a": 1}'), null);
  const p = jsonProblem('{\n  "a": 1,\n  "b": }');
  assert.ok(p && p.startsWith('Line 3, column 8'), p ?? '');
});

test('a render asks for both versions, and the server’s word comes back', async () => {
  const body = renderBody({ view: 'region', rect: [0, 1, 2, 3], scale: 2 }, 't:1:2', ['reach'], { seed: 'a', rules: '' }, { seed: 'b', rules: '{"x":1}' });
  assert.deepEqual(body, { view: 'region', seed: 'a', epoch: 't:1:2', rect: [0, 1, 2, 3], scale: 2, overlays: 'reach', b: { seed: 'b', rules: '{"x":1}' } });
  let sent: RequestInit | undefined;
  const fetcher = (async (_url: string, init: RequestInit) => {
    sent = init;
    return new Response(JSON.stringify({ error: 'render too large' }), { status: 400 });
  }) as unknown as typeof fetch;
  assert.deepEqual(await labRender(body, undefined, fetcher), { ok: false, status: 400, text: 'render too large' });
  assert.equal(sent?.method, 'POST');
  assert.equal((sent?.headers as Record<string, string>)['Content-Type'], 'application/json');
  const none = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
  const a = await labRender(body, undefined, none);
  assert.ok(!a.ok && a.status === 404);
});

test('the break in a JSON text is found where it is', () => {
  assert.equal(jsonBreak('{"a": [1, 2,]}'), 12);
  assert.equal(jsonBreak('{"a": tru}'), 9);
  assert.equal(jsonBreak('{"a": 1} x'), 9);
  assert.equal(jsonBreak('{"a": "x\\q"}'), 9);
  assert.equal(jsonBreak('{"a": 1'), 7);
  assert.equal(jsonBreak('[01]'), 2);
});
