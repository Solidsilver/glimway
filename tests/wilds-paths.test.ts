import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toBinary, type JsonValue } from '@bufbuild/protobuf';
import { FakeOperations } from '../src/lib/api/operations.ts';
import { WorldChunkSchema, type WildsWay } from '../src/lib/gen/glimway/v1/wilds_pb.js';
import { epochKindAt } from '../src/lib/wilds/coords.ts';
import { TERRAIN } from '../src/lib/tile.ts';
import { loadWilds } from '../src/lib/wilds/data.ts';
import { checkClear, checkLay, checkLift, clearAction, firstFindText, foundByText, inReach, isLaid, layKinds, placeName, refusalText, turnsInText, waySignText, type PathTile } from '../src/lib/wilds/paths.ts';
import { PATH_REFUSALS } from '../src/content/open-map.ts';
import { forgetChunks } from '../src/game/wilds/chunks.ts';
import { applyPathAnswer, groundChanges, predictGround, refreshNear, resetWilds, settlePrediction, wildsMaterials, wildsView } from '../src/game/wilds/store.ts';
import { pathTileAt } from '../src/game/wilds/path-tile.ts';
import { effectiveChunk } from '../src/game/wilds/ground-view.ts';
import type { Session } from '../src/game/session.ts';
import { chunkAt } from './wilds-fixture.ts';

const land = (o: Partial<PathTile> = {}): PathTile => ({ surface: 'land', baseSolid: false, decor: [], occupied: false, change: null, changes: 0, ...o });
const has = (...actions: string[]) => (a: string) => actions.includes(a);

test('clearing: a thicket with a spade, a fallen trunk with an axe; never twice, never on a site or off the land', () => {
  const thicket = land({ baseSolid: true, decor: ['thicket'] });
  assert.equal(clearAction(['thicket']), 'dig');
  assert.equal(clearAction(['log']), 'chop');
  assert.equal(clearAction(['oak']), null, 'trees are gathered, not cleared');
  assert.deepEqual(checkClear(thicket, has('dig')), { ok: true, action: 'dig', decor: 'thicket' });
  assert.deepEqual(checkClear(land({ baseSolid: true, decor: ['log'] }), has('chop')), { ok: true, action: 'chop', decor: 'log' });
  assert.deepEqual(checkClear(thicket, has('chop')), { ok: false, code: 'wrong-tool' });
  assert.deepEqual(checkClear({ ...thicket, change: { change: 'cleared', by: 'me' } }, has('dig')), { ok: false, code: 'already-cleared' });
  assert.deepEqual(checkClear(land({ decor: ['fern'] }), has('dig')), { ok: false, code: 'not-clearable' });
  assert.deepEqual(checkClear({ ...thicket, occupied: true }, has('dig')), { ok: false, code: 'not-clearable' }, 'a site, an entity or a landmark');
  assert.deepEqual(checkClear({ ...thicket, surface: 'road' }, has('dig')), { ok: false, code: 'not-clearable' });
  assert.deepEqual(checkClear({ ...thicket, changes: loadWilds().paths.maxChanges }, has('dig')), { ok: false, code: 'not-clearable' }, 'a full chunk');
});

test('laying: stone or plank on walkable land for its material; not on water, a ford, the road, a site or a laid tile', () => {
  const plenty = { stone: 3, timber: 3 };
  assert.deepEqual(layKinds().map((l) => [l.kind, l.material, l.cost]), [['stone', 'stone', 1], ['plank', 'timber', 1]]);
  assert.deepEqual(checkLay(land(), 'stone', plenty), { ok: true, material: 'stone', cost: 1, ground: 'laid-stone' });
  assert.deepEqual(checkLay(land(), 'plank', plenty), { ok: true, material: 'timber', cost: 1, ground: 'laid-plank' });
  // A cleared thicket takes a path; an uncleared one doesn't.
  assert.equal(checkLay(land({ baseSolid: true, change: { change: 'cleared', by: 'x' } }), 'stone', plenty).ok, true);
  assert.deepEqual(checkLay(land({ baseSolid: true }), 'stone', plenty), { ok: false, code: 'cannot-lay-here' });
  assert.deepEqual(checkLay(land({ surface: 'water', baseSolid: true }), 'plank', plenty), { ok: false, code: 'not-on-water' });
  assert.deepEqual(checkLay(land({ surface: 'ford' }), 'stone', plenty), { ok: false, code: 'not-on-water' });
  assert.deepEqual(checkLay(land({ surface: 'road' }), 'stone', plenty), { ok: false, code: 'cannot-lay-here' });
  assert.deepEqual(checkLay(land({ occupied: true }), 'stone', plenty), { ok: false, code: 'cannot-lay-here' });
  assert.deepEqual(checkLay(land({ change: { change: 'stone', by: 'x' } }), 'plank', plenty), { ok: false, code: 'already-laid' });
  assert.deepEqual(checkLay(land(), 'stone', { stone: 0, timber: 9 }), { ok: false, code: 'insufficient-materials' });
  assert.deepEqual(checkLay(land(), 'gold', plenty), { ok: false, code: 'invalid-request' });
  assert.ok(isLaid('stone') && isLaid('plank') && !isLaid('cleared') && !isLaid(null));
});

test('lifting: only your own path; its material comes back, and once-solid ground stays cleared', () => {
  assert.deepEqual(checkLift(land({ change: { change: 'stone', by: 'me' } }), 'me'), { ok: true, kind: 'stone', material: 'stone', cost: 1, after: null });
  assert.deepEqual(checkLift(land({ baseSolid: true, change: { change: 'plank', by: 'me' } }), 'me'), { ok: true, kind: 'plank', material: 'timber', cost: 1, after: 'cleared' });
  assert.deepEqual(checkLift(land({ change: { change: 'stone', by: 'someone' } }), 'me'), { ok: false, code: 'not-your-path' });
  assert.deepEqual(checkLift(land({ change: { change: 'cleared', by: 'me' } }), 'me'), { ok: false, code: 'not-your-path' });
  assert.deepEqual(checkLift(land(), 'me'), { ok: false, code: 'not-your-path' });
});

test('reach is measured from the hero’s tile, as the server does (paths.reachTiles)', () => {
  const r = loadWilds().paths.reachTiles;
  assert.equal(r, 2);
  assert.ok(inReach({ tx: 0, ty: 0 }, { tx: 2, ty: 0 }));
  assert.ok(inReach({ tx: 0, ty: 0 }, { tx: -1, ty: -1 }));
  assert.ok(!inReach({ tx: 0, ty: 0 }, { tx: 2, ty: 1 }), 'Euclid, not Chebyshev');
  assert.ok(!inReach({ tx: -5, ty: -5 }, { tx: -8, ty: -5 }));
});

test('every refusal reads in plain words, with the tool or material named', () => {
  const say = (code: string, ctx: { action?: string; material?: string } = {}) => refusalText(code, { ...ctx, extra: PATH_REFUSALS });
  assert.equal(say('wrong-tool', { action: 'dig' }), "You'd need a spade for this.");
  assert.equal(say('wrong-tool', { action: 'chop' }), "You'd need an axe for this.");
  assert.equal(say('insufficient-materials', { material: 'timber' }), "You're out of timber.");
  assert.equal(say('not-on-water'), 'Not on water. Cross at a ford.');
  assert.equal(say('beyond-frontier'), loadWilds().words.drift);
  for (const code of ['already-cleared', 'not-clearable', 'already-laid', 'cannot-lay-here', 'not-your-path', 'too-far-away', 'offline', 'busy', 'epoch-ended', 'not-in-wilds']) {
    const text = say(code);
    assert.ok(text.length > 5 && text.length < 90, `${code}: ${text}`);
    assert.doesNotMatch(text, /[{}]|undefined/, code);
  }
  assert.equal(say('some-new-code'), PATH_REFUSALS.unknown, 'an unknown code still says something');
});

test('the confirm on turning land counts whole days, at least one', () => {
  const now = 1_000_000;
  assert.equal(turnsInText(now + 3 * 86_400, now), 'This land turns in 3 days. A path here stays if someone walks here each wick.');
  assert.equal(turnsInText(now + 2 * 86_400 + 5, now), 'This land turns in 3 days. A path here stays if someone walks here each wick.');
  assert.equal(turnsInText(now + 3600, now), 'This land turns in a day. A path here stays if someone walks here each wick.');
  assert.equal(turnsInText(now - 10, now), 'This land turns in a day. A path here stays if someone walks here each wick.');
});

test('a way’s sign, a finder and a first find in words', () => {
  assert.equal(placeName('tangle', null), 'the Tangle');
  assert.equal(placeName('place:1:-1', 'camp-glade'), 'the camp glade');
  assert.equal(placeName('place:1:-1', 'outcrop'), 'the outcrop');
  assert.equal(placeName('place:9:9', null), 'a place');
  assert.equal(waySignText("Tansy's way", 'the Tangle', 'the camp glade'), "Tansy's way. From the Tangle to the camp glade.");
  assert.equal(foundByText('Tansy'), 'Found by Tansy');
  assert.equal(firstFindText('2 stone and 1 amber'), "Nobody's been here yet this wick. You find 2 stone and 1 amber.");
  // No stand-ins left for the words lane.
  assert.deepEqual(loadWilds().words.standIn, []);
  assert.equal(loadWilds().rumour.standIn, false);
});

// ------------------------------------------------------------ predicted on the client, confirmed by the server

const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { case: string; json: JsonValue }[];
const NEAR = fixtures.find((f) => f.case === 'valid-near')!.json as Record<string, any>;

/** A session on the open map with the fixture's near read around (-2, -4) loaded. */
async function loaded(): Promise<Session> {
  forgetChunks();
  resetWilds();
  const ops = new FakeOperations();
  const link = { api: { operations: ops.api }, lease: 'lease-1', status: 'online', busy: false, accountId: 'me' };
  const session = { link, state: { area: 'outdoors', position: { x: 0, y: 0 }, flags: [] } } as unknown as Session;
  ops.responses.set('/api/wilds/near/-2/-4', [NEAR as JsonValue]);
  for (let y = -6; y <= -2; y++)
    for (let x = -4; x <= 0; x++) {
      const still = epochKindAt(x, y) === 'still';
      const m = chunkAt(still ? 'tangle' : 'whitequiet-0-4', x, y);
      m.epochId = still ? NEAR.still.id : NEAR.wick.id;
      ops.responses.set(`/api/wilds/chunk/${m.epochId}/0/${x}/${y}`, [toBinary(WorldChunkSchema, m)]);
    }
  assert.equal(await refreshNear(session, -2, -4), true);
  return session;
}

/** A world tile in chunk (-2, -4) that matches `pick`. */
function tileWhere(pick: (t: PathTile) => boolean): { tx: number; ty: number } {
  for (let ly = 0; ly < 24; ly++)
    for (let lx = 0; lx < 24; lx++) {
      const t = pathTileAt(-48 + lx, -96 + ly);
      if (t && pick(t)) return { tx: -48 + lx, ty: -96 + ly };
    }
  throw new Error('no such tile in the fixture');
}

test('a tile reads its generated land and the near read’s change', async () => {
  await loaded();
  // The fixture's changes in chunk (-2, -4): (3,4) cleared, (4,4) stone, both by the fixture's account.
  assert.deepEqual(pathTileAt(-48 + 4, -96 + 4)!.change, { change: 'stone', by: 'fixture-account' });
  assert.deepEqual(pathTileAt(-48 + 3, -96 + 4)!.change, { change: 'cleared', by: 'fixture-account' });
  assert.equal(pathTileAt(-48 + 4, -96 + 4)!.changes, 2);
  assert.equal(pathTileAt(100, 100), null, 'past the frontier: nothing');
  const thicket = tileWhere((t) => t.decor.includes('thicket') && !t.change && !t.occupied && t.surface === 'land');
  assert.equal(pathTileAt(thicket.tx, thicket.ty)!.baseSolid, true);
});

test('a predicted lay shows at once (ground, walkability, the stone taken) and its answer replaces it', async () => {
  await loaded();
  const open = tileWhere((t) => !t.baseSolid && !t.change && !t.occupied && t.surface === 'land' && t.decor.length === 0);
  const lx = open.tx + 48;
  const ly = open.ty + 96;
  const stoneBefore = wildsMaterials()!.stone!;
  const before = groundChanges(-2, -4);
  const token = predictGround(-2, -4, lx, ly, { tx: lx, ty: ly, change: 'stone', by: 'me', at: 1 } as never, { id: 'stone', delta: -1 });
  assert.equal(wildsMaterials()!.stone, stoneBefore - 1, 'the stone leaves the pack at once');
  assert.deepEqual(pathTileAt(open.tx, open.ty)!.change, { change: 'stone', by: 'me' });
  assert.equal(groundChanges(-2, -4), groundChanges(-2, -4), 'the same list until something changes (the ground view caches by it)');
  assert.equal(effectiveChunk(-2, -4)!.ground[ly]![lx], TERRAIN.stone_a, 'laid stone underfoot');
  assert.equal(view().ground.get('-2,-4'), before, 'the server’s list itself is untouched');
  // The answer: the chunk's changes now and the balances; the prediction goes.
  settlePrediction(token);
  applyPathAnswer(
    { $typeName: 'glimway.v1.ChunkGroundChanges', chunk: { $typeName: 'glimway.v1.WildsChunkKey', realm: 'hearthwick', layer: 0, cx: -2, cy: -4 }, epoch: NEAR.wick.id, changes: { $typeName: 'glimway.v1.GroundChanges', changes: [...before, { $typeName: 'glimway.v1.GroundChange', tx: lx, ty: ly, change: 'stone', by: 'me', at: 2 }] } },
    { stone: stoneBefore - 1 },
  );
  assert.deepEqual(pathTileAt(open.tx, open.ty)!.change, { change: 'stone', by: 'me' });
  assert.equal(wildsMaterials()!.stone, stoneBefore - 1);
});

test('a refused prediction takes everything back: the tile and the material', async () => {
  await loaded();
  const thicket = tileWhere((t) => t.decor.includes('thicket') && !t.change && !t.occupied && t.surface === 'land');
  const lx = thicket.tx + 48;
  const ly = thicket.ty + 96;
  const version = view().version;
  const token = predictGround(-2, -4, lx, ly, { tx: lx, ty: ly, change: 'cleared', by: 'me', at: 1 } as never);
  assert.ok(view().version > version, 'the scene redraws');
  assert.equal(effectiveChunk(-2, -4)!.solid[ly]![lx], false, 'cleared: walkable at once');
  settlePrediction(token);
  assert.equal(pathTileAt(thicket.tx, thicket.ty)!.change, null);
  assert.equal(effectiveChunk(-2, -4)!.solid[ly]![lx], true, 'solid again');
  // A lift's prediction drops the tile's change and gives the stone back until the answer.
  const stone = wildsMaterials()!.stone!;
  const lift = predictGround(-2, -4, 4, 4, null, { id: 'stone', delta: 1 }, 'fixture-account');
  assert.equal(pathTileAt(-44, -92)!.change, null);
  assert.equal(wildsMaterials()!.stone, stone + 1);
  settlePrediction(lift);
  assert.deepEqual(pathTileAt(-44, -92)!.change, { change: 'stone', by: 'fixture-account' });
  assert.equal(wildsMaterials()!.stone, stone);
});

test('a predicted change survives a near read that lands before its answer', async () => {
  const session = await loaded();
  const thicket = tileWhere((t) => t.decor.includes('thicket') && !t.change && !t.occupied && t.surface === 'land');
  predictGround(-2, -4, thicket.tx + 48, thicket.ty + 96, { tx: thicket.tx + 48, ty: thicket.ty + 96, change: 'cleared', by: 'me', at: 1 } as never);
  // Another read of the same window (its chunks are cached now).
  const fake = new FakeOperations();
  fake.responses.set('/api/wilds/near/-2/-4', [NEAR as JsonValue]);
  const again = { ...session, link: { ...session.link!, api: { operations: fake.api } } } as unknown as Session;
  assert.equal(await refreshNear(again, -2, -4), true);
  assert.deepEqual(pathTileAt(thicket.tx, thicket.ty)!.change, { change: 'cleared', by: 'me' });
});

test('a lay’s answer names the ways it made; a lift’s, the ways it broke and rerouted', async () => {
  await loaded();
  const way = (id: string, name: string): WildsWay => ({ $typeName: 'glimway.v1.WildsWay', id, a: 'place:0:-2', b: id.split(':').slice(-2).join(':'), name, by: 'me', tiles: 70, epoch: NEAR.wick.id, at: 1, path: [], signA: undefined, signB: undefined }) as WildsWay;
  assert.equal(view().ways.size, 1);
  applyPathAnswer(undefined, { stone: 1 }, { made: [way('way:place:0:-2:place:2:-2', "Me's way")] });
  assert.equal(view().ways.size, 2);
  applyPathAnswer(undefined, { stone: 2 }, { broken: ['way:place:0:-2:place:1:-1'], rerouted: [way('way:place:0:-2:place:2:-2', "Me's way")] });
  assert.deepEqual([...view().ways.keys()], ['way:place:0:-2:place:2:-2']);
  assert.equal(wildsMaterials()!.stone, 2);
});

function view() {
  return wildsView()!;
}
