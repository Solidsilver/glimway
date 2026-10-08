import test from 'node:test';
import assert from 'node:assert/strict';
import roomVectors from '../content/vectors/rooms.json' with { type: 'json' };
import questVectors from '../content/vectors/quests.json' with { type: 'json' };
import clockVectors from '../content/vectors/clock.json' with { type: 'json' };
import libraryVectors from '../content/vectors/library.json' with { type: 'json' };
import roomRaw from '../content/rooms.json' with { type: 'json' };
import residentRaw from '../content/residents.json' with { type: 'json' };
import { ROOMS, validateRooms, roomParent, rootArea, knownRoom, roomFootprints, roomFor } from '../src/lib/rooms.ts';
import { validateResidents, residentAt, residentById, residentSpotFits } from '../src/lib/residents.ts';
import { cycleAt, cycleSpotsNear } from '../src/lib/clock.ts';
import { validateQuests } from '../src/lib/story-tables.ts';
interface Edit { path: (string | number)[]; value: unknown }
function edited(base: unknown, edits: Edit[]): unknown {
  const value = structuredClone(base);
  for (const e of edits) { let target = value as any; for (const key of e.path.slice(0,-1)) target = target[key]; target[e.path.at(-1)!] = e.value; }
  return value;
}
for (const [kind, base, vectors, validate] of [
  ['rooms', roomRaw, roomVectors.rooms, validateRooms],
  ['residents', residentRaw, roomVectors.residents, validateResidents],
  ['quests', questVectors.base, questVectors.cases, validateQuests]
] as const) {
  for (const v of vectors) test(`shared ${kind} loader: ${v.name}`, () => {
    const value = edited(base, v.edits);
    if (v.valid) assert.doesNotThrow(() => validate(value)); else assert.throws(() => validate(value));
  });
}
test('shared room parent, root and known-id vectors', () => {
  for (const v of roomVectors.parents) { assert.equal(roomParent(v.area),v.parent,v.area); assert.equal(rootArea(v.area),v.root,v.area); assert.equal(knownRoom(v.area),v.known,v.area); }
});
test('prop footprints preserve separate rectangular sack piles', () => {
  // A fixture: the loft's sacks are dressing since the round-2 art.
  const piles = { ...roomFor('in:village:mill:2')!, map: ['##########', '#.ff..ff.#', '#.ff..ff.#', '##########'] };
  assert.deepEqual(roomFootprints(piles,'f'), [{ char:'f',tx:2,ty:1,tw:2,th:2 },{ char:'f',tx:6,ty:1,tw:2,th:2 }]);
  assert.equal(ROOMS.rooms.length,4);
});
test('shared resident cycle phase and grace vectors', () => {
  for (const v of clockVectors.cycles) { assert.deepEqual(cycleAt(v.resident,v.now),v.expected); assert.deepEqual(cycleSpotsNear(v.resident,v.now,v.graceSeconds),v.near); }
  assert.deepEqual(residentAt('finn',2700), { area:'in:village:mill:2',tx:7,ty:5 });
  assert.deepEqual(residentAt('elara',0), { area:'commons',tx:26,ty:5 });
  assert.deepEqual(residentAt('elara',600), { area:'in:village:library',tx:9,ty:4,seated:true });
  assert.deepEqual(residentAt('elara',2400), { area:'commons',tx:26,ty:5 });
  assert.equal(residentAt('missing',0),null); assert.equal(residentById('missing'),null);
});

test('revised library accepts solid boundary shelves, refuses open ones', () => {
  const doc = structuredClone(roomRaw);
  doc.rooms[doc.rooms.findIndex(r => r.id === libraryVectors.room.id)] = libraryVectors.room;
  assert.doesNotThrow(() => validateRooms(doc));
  const open = structuredClone(doc);
  open.rooms.find(r => r.id === libraryVectors.room.id)!.props[0]!.solid = false;
  assert.throws(() => validateRooms(open));
});
for (const v of libraryVectors.seats) test(`shared resident seat: ${v.name}`, () => {
  assert.equal(residentSpotFits(libraryVectors.room, v.spot), v.valid);
});

test('shared quest wait boundaries', async () => {
  const { default: vectors } = await import('../content/vectors/quest-waits.json', { with: { type: 'json' } });
  const { questWaitReady } = await import('../src/lib/clock.ts');
  for (const v of vectors) assert.equal(questWaitReady(v.wait, v.since, v.now), v.ready, v.name);
});

test('shared resident seller schema', async () => {
  const { default: vectors } = await import('../content/vectors/sellers.json', { with: { type: 'json' } });
  const { default: raw } = await import('../content/items.json', { with: { type: 'json' } });
  const { validateItems, sellerFor } = await import('../src/lib/items.ts');
  for (const v of vectors) {
    const value = edited(raw, v.edits);
    if (v.valid) assert.doesNotThrow(() => validateItems(value), v.name);
    else assert.throws(() => validateItems(value), undefined, v.name);
  }
  assert.equal(sellerFor('hazels-kitchen', 0)?.area, 'in:village:bakery');
  assert.equal(sellerFor('hazels-kitchen', 3000)?.area, 'village');
  assert.equal(sellerFor('finns-mill-door', 3000)?.area, 'in:village:mill:2');
});
