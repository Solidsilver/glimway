import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import vectors from '../content/vectors/location.json' with { type: 'json' };
import loaderVectors from '../content/vectors/places-loader.json' with { type: 'json' };
import placesRaw from '../content/places.json' with { type: 'json' };
import { anchor, at, onGrid, contentSpace, contentPosition, sourceOf } from '../src/lib/location.ts';
import { PLACES, gateCapacity, validatePlaces, type Places } from '../src/lib/places.ts';
import { refusalMatchesRule } from './helpers/vector-rule.ts';
import { townReachability } from './town-reachability.ts';

test('at: town, on-foot streets, lots and seam boundaries (shared vectors)', () => {
  for (const v of vectors.at) assert.deepEqual(at(v.space, v.x, v.y), v.place, v.name);
});
test('at: first holding zone wins (shared vectors)', () => {
  const zoned = structuredClone(placesRaw) as { fixed: { zones: unknown }[] };
  zoned.fixed[0]!.zones = vectors.zones.zones;
  const places = validatePlaces(zoned);
  for (const v of vectors.zones.at) assert.deepEqual(at(v.space, v.x, v.y, places), v.place, v.name);
});
type Lookups = Pick<typeof vectors, 'sourceOf' | 'onGrid' | 'anchors'>;
function checkLookups(doc: Lookups, places: Places = PLACES): void {
  for (const v of doc.sourceOf) assert.deepEqual(sourceOf(v.chunk[0]!, v.chunk[1]!, places), v.source, `chunk ${v.chunk}`);
  for (const v of doc.onGrid) assert.equal(onGrid(v.chunk[0]!, v.chunk[1]!, places), v.onGrid, `chunk ${v.chunk}`);
  for (const v of doc.anchors) assert.deepEqual(anchor(v.id, places), v.ok ? { space: v.space, x: v.at[0], y: v.at[1] } : null, v.id);
}
test('sourceOf, onGrid and anchors (shared vectors)', () => checkLookups(vectors));
test('arithmetic at schema bounds (shared vectors)', () => {
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
/** Content positions, including inherited area ownership (fishing banks).
 * This is the same walk as Go's location test. Vectors cannot omit a tile.
 */
function townPositions(): { source: string; tile: number[] }[] {
  const out: { source: string; tile: number[] }[] = [];
  const tile = (v: any): boolean => v && !Array.isArray(v) && typeof v.tx === 'number' && typeof v.ty === 'number';
  const add = (source: string, v: any) => out.push({ source, tile: [v.tx, v.ty] });
  const walk = (path: string, v: any, inherited = false): void => {
    if (Array.isArray(v)) { v.forEach((x, i) => walk(`${path}.${x?.id ?? i}`, x, inherited)); return; }
    if (!v || typeof v !== 'object') return;
    const own = 'area' in v || 'to' in v ? v.area === 'hearthwick' || v.to === 'hearthwick' : inherited;
    if (own && tile(v)) add(path, v);
    for (const k of Object.keys(v).sort()) {
      if (tile(v[k]) && (own || k === 'hearthwick')) add(`${path}.${k}`, v[k]);
      else walk(`${path}.${k}`, v[k], own);
    }
  };
  const dir = new URL('../content/', import.meta.url);
  for (const f of readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'places.json')) walk(f.slice(0,-5), JSON.parse(readFileSync(new URL(f,dir),'utf8')));
  return out.sort((a,b) => a.source.localeCompare(b.source));
}
test('every content tile has a matching world-coordinate vector', () => {
  const fromJSON = vectors.positions.filter(v => !v.source.startsWith('layout.') && !/^papers\.-?\d+,/.test(v.source) && !v.source.endsWith('.outside.window'));
  assert.deepEqual(townPositions(), fromJSON.map(({ source, tile }) => ({ source, tile })).sort((a,b) => a.source.localeCompare(b.source)));
  for (const v of vectors.positions) {
    assert.deepEqual(contentPosition(v.area, v.tile[0]!, v.tile[1]!), { space: 'outdoors', tx: v.tile[0], ty: v.tile[1] });
    assert.equal(at(contentSpace(v.area), v.tile[0]! * 16 + 8, v.tile[1]! * 16 + 8).id, 'hearthwick', v.source);
  }
});
test('eight lot anchors and cottage approaches belong to their numbered lots', () => {
  assert.equal(gateCapacity(PLACES.fixed[0]!), 8);
  for (let g=0;g<8;g++) {
    const a=anchor(`hearthwick:lot:${g}`)!;
    assert.equal(at(a.space,a.x,a.y).id,`lot:${g}`);
    assert.deepEqual([Math.floor(a.x/16), Math.floor(a.y/16)],[-60+24*(g%2),44+24*Math.floor(g/2)]);
  }
});
test('every door, anchor, NPC, repair, pickup, paper and bank is reachable from spawn and all four gates', townReachability);
