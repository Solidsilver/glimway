import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import vectors from '../content/vectors/location.json' with { type: 'json' };
import loaderVectors from '../content/vectors/places-loader.json' with { type: 'json' };
import placesRaw from '../content/places.json' with { type: 'json' };
import { anchor, at, onGrid, resolve, sourceOf, OUTDOORS } from '../src/lib/location.ts';
import { PLACES, gateCapacity, validatePlaces, type Places } from '../src/lib/places.ts';
import { chunkOf } from '../src/lib/wilds/coords.ts';
import { buildCommons, gateSlot, type CommonsWorld } from '../src/game/commons.ts';
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts';
import { refusalMatchesRule } from './helpers/vector-rule.ts';

const contentDir = new URL('../content/', import.meta.url);

test('at: the place a position is in (shared vectors)', () => {
  for (const v of vectors.at) assert.deepEqual(at(v.space, v.x, v.y), v.place, v.name);
});

test('at: zones laid over the Commons, first holding zone wins (shared vectors)', () => {
  const zoned = structuredClone(placesRaw) as { fixed: { zones: unknown }[] };
  zoned.fixed[0]!.zones = vectors.zones.zones;
  const places = validatePlaces(zoned);
  for (const v of vectors.zones.at) assert.deepEqual(at(v.space, v.x, v.y, places), v.place, v.name);
});

type Lookups = Pick<typeof vectors, 'sourceOf' | 'onGrid' | 'anchors' | 'resolve'>;

/** Replays the sourceOf, onGrid, anchor and resolve rows. */
function checkLookups(doc: Lookups, places: Places = PLACES): void {
  for (const v of doc.sourceOf) assert.deepEqual(sourceOf(v.chunk[0]!, v.chunk[1]!, places), v.source, `chunk ${v.chunk}`);
  for (const v of doc.onGrid) assert.equal(onGrid(v.chunk[0]!, v.chunk[1]!, places), v.onGrid, `chunk ${v.chunk}`);
  for (const v of doc.anchors) {
    assert.deepEqual(anchor(v.id, places), v.ok ? { space: v.space, x: v.at[0], y: v.at[1] } : null, v.id);
  }
  for (const v of doc.resolve) {
    assert.deepEqual(resolve(v.area, v.tile[0]!, v.tile[1]!, places), { space: v.space, tx: v.at[0], ty: v.at[1] }, `${v.area} ${v.tile}`);
  }
}

test('sourceOf, onGrid, anchors and resolve (shared vectors)', () => {
  checkLookups(vectors);
});

test('every lookup beside two places at the schema bounds (shared vectors)', () => {
  const edited = structuredClone(placesRaw) as { fixed: unknown[] };
  edited.fixed.push(...vectors.bounds.fixed);
  const places = validatePlaces(edited);
  for (const v of vectors.bounds.at) assert.deepEqual(at(v.space, v.x, v.y, places), v.place, v.name);
  checkLookups(vectors.bounds, places);
});

for (const v of loaderVectors.loader) test(`shared places loader: ${v.name}`, () => {
  const value: any = structuredClone(placesRaw);
  for (const edit of v.edits) {
    let target = value;
    for (const key of edit.path.slice(0, -1)) target = target[key];
    const e = edit as { path: (string | number)[]; remove?: boolean; value?: unknown };
    if (e.remove) delete target[e.path.at(-1)!]; else target[e.path.at(-1)!] = e.value;
  }
  if (v.valid) assert.doesNotThrow(() => validatePlaces(value));
  else assert.throws(() => validatePlaces(value), (e: Error) => refusalMatchesRule(e, (v as { rule?: string }).rule ?? ''));
});

/**
 * Positions in Commons tiles across content/*.json: an object whose `area`
 * (or a door's `to`) is "commons" holding tx/ty itself or in a child
 * object, and a {tx, ty} object keyed "commons" (the story's boards). The
 * walk is the Go test's, word for word (server/internal/location).
 */
function commonsPositions(): string[] {
  const out: string[] = [];
  const tile = (v: unknown): boolean => typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { tx?: unknown }).tx === 'number' && typeof (v as { ty?: unknown }).ty === 'number';
  const walk = (path: string, v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        const id = (item as { id?: unknown } | null)?.id;
        walk(`${path}.${typeof id === 'string' && id !== '' ? id : i}`, item);
      });
      return;
    }
    if (typeof v !== 'object' || v === null) return;
    const obj = v as Record<string, unknown>;
    const own = obj.area === 'commons' || obj.to === 'commons';
    if (own && tile(obj)) out.push(path);
    for (const k of Object.keys(obj).sort()) {
      if (tile(obj[k]) && (own || k === 'commons')) out.push(`${path}.${k}`);
      else walk(`${path}.${k}`, obj[k]);
    }
  };
  for (const f of readdirSync(contentDir).filter((f) => f.endsWith('.json') && f !== 'places.json').sort()) {
    walk(f.slice(0, -'.json'.length), JSON.parse(readFileSync(new URL(f, contentDir), 'utf8')));
  }
  return out.sort();
}

test('every content position in Commons tiles has a resolve vector', () => {
  const sources = vectors.resolve.filter((v) => v.source).map((v) => v.source).sort();
  assert.deepEqual(commonsPositions(), sources);
});

// Today's Commons at the frozen capacity (eight gates, one per gate anchor): what
// blocks a walker, and what a walker reaches from the village path.
const gates = gateCapacity(PLACES.fixed.find((f) => f.id === 'commons')!);
const commons = buildCommons(8);
type Tile = { tx: number; ty: number };
const key = (t: Tile) => `${t.tx},${t.ty}`;
function blocked(w: CommonsWorld): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) if (w.solid[y]![x]) out.add(key({ tx: x, ty: y }));
  for (const s of [...w.trees, ...w.bushes, ...w.rocks, ...w.props]) out.add(key(s));
  return out;
}
const solid = blocked(commons);
const reached = (() => {
  const from = commons.spawn;
  const seen = new Set([key(from)]);
  const q: Tile[] = [from];
  while (q.length) {
    const t = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const n = { tx: t.tx + dx, ty: t.ty + dy };
      if (n.tx < 0 || n.ty < 0 || n.tx >= commons.width || n.ty >= commons.height || seen.has(key(n)) || solid.has(key(n))) continue;
      seen.add(key(n));
      q.push(n);
    }
  }
  return seen;
})();

test('the frozen Commons fits its footprint, and its gate anchors are the lane tiles by the gates', () => {
  const f = PLACES.fixed.find((f) => f.id === 'commons')!;
  // Owner decision (location-seam §0 10, §7 1): eight gates, two chunk rows.
  assert.equal(gates, 8);
  assert.ok(gates >= HOMESTEAD_DATA.commons.spareGates);
  const S = 24;
  const [x0, y0] = [f.cx * S - f.origin.tx, f.cy * S - f.origin.ty];
  const [x1, y1] = [x0 + f.width * S - 1, y0 + f.height * S - 1];
  assert.ok(x0 <= 0 && y0 <= 0 && commons.width - 1 <= x1 && commons.height - 1 <= y1, `Commons ${commons.width}x${commons.height} in layout tiles ${x0},${y0}..${x1},${y1}`);
  for (let g = 0; g < gates; g++) {
    const a = f.anchors.find((a) => a.id === `gate:${g}`);
    assert.deepEqual(a && { tx: a.tx, ty: a.ty }, gateSlot(g).entry, `gate:${g}`);
  }
});

test('every anchor and content position in Commons tiles lands on the grid, on open ground in the Commons', () => {
  const onCommonsGround = (what: string, space: string, tx: number, ty: number) => {
    const { cx, cy } = chunkOf(tx, ty);
    assert.equal(space, OUTDOORS, what);
    assert.ok(onGrid(cx, cy), `${what}: chunk ${cx},${cy} is off the grid`);
    assert.equal(at(space, tx * 16 + 8, ty * 16 + 8).id, 'commons', what);
  };
  const f = PLACES.fixed.find((f) => f.id === 'commons')!;
  for (const a of f.anchors) {
    const got = anchor(`commons:${a.id}`)!;
    onCommonsGround(a.id, got.space, Math.floor(got.x / 16), Math.floor(got.y / 16));
    assert.ok(reached.has(key(a)), `anchor ${a.id} (${key(a)}) is not open ground reached from the village path`);
  }
  for (const v of vectors.resolve.filter((v) => v.source)) {
    const r = resolve(v.area, v.tile[0]!, v.tile[1]!);
    onCommonsGround(v.source, r.space, r.tx, r.ty);
    const t = { tx: v.tile[0]!, ty: v.tile[1]! };
    if (v.kind === 'stand') assert.ok(reached.has(key(t)), `${v.source} (${key(t)}) is not open ground reached from the village path`);
    else {
      assert.equal(v.kind, 'target', v.source);
      const beside = [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => reached.has(key({ tx: t.tx + dx!, ty: t.ty + dy! })));
      assert.ok(beside, `${v.source} (${key(t)}) has no open ground beside it`);
    }
  }
});
