import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fromJson, type JsonValue } from '@bufbuild/protobuf';

/**
 * The carried materials are one balance with two mirrors, Home's and the
 * Wilds' (materials-order.ts). Their reads and answers are ordered against
 * each other: re-publishing a mirror is no newer word than a read in flight,
 * a Home action's balance is newer than a near read asked before it, and a
 * Wilds answer is still newer than a Home read asked before it.
 */

// The session saves through window timers; hold them so nothing writes.
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { WildsNearResultSchema } = await import('../src/lib/gen/glimway/v1/wilds_pb.js');
const store = await import('../src/game/wilds/store.ts');
const { Session } = await import('../src/game/session.ts');
const { homesteadsFor } = await import('../src/game/homestead.ts');
const { villageFor } = await import('../src/game/village.ts');
const { createNewGame } = await import('../src/lib/state.ts');

const fixtures = JSON.parse(readFileSync(new URL('../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { case: string; json: JsonValue }[];
const NEAR = fixtures.find((f) => f.case === 'valid-near')!.json as Record<string, any>;
const near = (stone: number) => {
  const j = structuredClone(NEAR);
  j.materials = { stone };
  j.ground = [];
  return fromJson(WildsNearResultSchema, j as JsonValue);
};

type Call = { name: string; answer: (v: unknown) => void };

/** Home's link, its reads and actions answered when the test says. */
function homeWorld() {
  const calls: Call[] = [];
  const wait = (name: string) => () => new Promise((answer) => calls.push({ name, answer }));
  const link = { accountId: 'me', worldId: 'world-1', status: 'online', attach: () => {}, takePaper: () => {}, api: { operations: {} }, readCommons: wait('commons'), readHome: wait('home'), homeAction: wait('action'), readWith: wait('read'), mutate: wait('mutate') };
  const take = (name: string): Call => {
    const i = calls.findIndex((c) => c.name === name);
    assert.ok(i >= 0, `a ${name} call is waiting`);
    return calls.splice(i, 1)[0]!;
  };
  const session = new Session({ ...createNewGame(), maxHp: 50, hp: 40, maxMana: 30, mana: 20 }, undefined, link as never);
  return { homes: homesteadsFor(session), village: villageFor(session), take, link };
}

/** A session whose Home side isn't made yet (resuming in the Wilds: the near read comes first). */
function laterHome(accountId = 'me') {
  const calls: Call[] = [];
  const wait = (name: string) => () => new Promise((answer) => calls.push({ name, answer }));
  const link = { accountId, worldId: 'world-1', status: 'online', attach: () => {}, takePaper: () => {}, api: { operations: {} }, readCommons: wait('commons'), readHome: wait('home') };
  const session = new Session({ ...createNewGame(), maxHp: 50, hp: 40, maxMana: 30, mana: 20 }, undefined, link as never);
  const take = (name: string): Call => calls.splice(calls.findIndex((c) => c.name === name), 1)[0]!;
  return { link, session, take };
}

const GATE = 2;
const homeRead = (stone: number) => ({ ok: true, value: { gate: GATE, landSeed: 7, home: null, materials: { stone } } });

/** Both mirrors' stone. */
const stone = (homes: ReturnType<typeof homesteadsFor>) => ({ home: homes.materials.stone, wilds: store.wildsMaterials()!.stone });

/** The Wilds settle something that moves no balance (a lay's ground with no material, its answer): a bump. */
function bumpWilds(): void {
  store.settlePrediction(store.predictGround(-2, -4, 5, 5, null));
}

test('re-publishing the Wilds mirror is no newer word than a Home read in flight', async () => {
  store.resetWilds({ quiet: true });
  const { homes, take, link } = homeWorld();
  store.applyNear(near(4), store.readMark(), link);
  assert.deepEqual(stone(homes), { home: 4, wilds: 4 });
  // A fresh home read goes out; the account gained stone elsewhere meanwhile.
  const read = homes.fetchHome(GATE);
  bumpWilds();
  bumpWilds();
  take('home').answer(homeRead(9));
  await read;
  assert.deepEqual(stone(homes), { home: 9, wilds: 9 }, 'the read’s balance, in both mirrors');
});

test('a Home action’s balance is newer than a near read asked before it, in both mirrors', async () => {
  store.resetWilds({ quiet: true });
  const { homes, take, link } = homeWorld();
  store.applyNear(near(4), store.readMark(), link);
  // A near read goes out carrying four stone; a buy spends three and is answered first.
  const since = store.readMark();
  const buy = homes.buy('lantern-post');
  take('action').answer({ ok: true, home: null, materials: { stone: 1 } });
  assert.equal((await buy).ok, true);
  assert.deepEqual(stone(homes), { home: 1, wilds: 1 });
  // The delayed near read lands, and the Wilds publish (refreshNear bumps after applying).
  store.applyNear(near(4), since, link);
  bumpWilds();
  assert.deepEqual(stone(homes), { home: 1, wilds: 1 }, 'the spend stands');
  // A near read asked after the buy is the newer word.
  store.applyNear(near(2), store.readMark(), link);
  assert.deepEqual(stone(homes), { home: 2, wilds: 2 });
});

test('a Wilds answer is still newer than a Home read asked before it', async () => {
  store.resetWilds({ quiet: true });
  const { homes, take, link } = homeWorld();
  store.applyNear(near(4), store.readMark(), link);
  const read = homes.fetchHome(GATE);
  // A path answer lands with the account's balance after the lay.
  assert.equal(store.applyPathAnswer(undefined, { stone: 3 }), true);
  assert.deepEqual(stone(homes), { home: 3, wilds: 3 });
  take('home').answer(homeRead(4));
  await read;
  assert.deepEqual(stone(homes), { home: 3, wilds: 3 }, 'the older Home read doesn’t undo the lay');
  // Neither mirror's publishing feeds the other a newer mark: a Home read asked now is adopted.
  bumpWilds();
  const next = homes.fetchHome(GATE);
  take('home').answer(homeRead(6));
  await next;
  assert.deepEqual(stone(homes), { home: 6, wilds: 6 });
});

test('the village’s answers and reads carry the same balance, in the same order', async () => {
  store.resetWilds({ quiet: true });
  const { homes, village, take, link } = homeWorld();
  store.applyNear(near(4), store.readMark(), link);
  const counts = (stone: number) => ({ materials: { stone }, items: {}, decorations: {} });
  const workshop = (stone: number) => ({ inventory: counts(stone), storage: counts(0), personal: counts(0), shared: counts(0), home: null });
  // A craft at the bench spends two: the Wilds mirror follows the answer.
  const craft = village.craft('bench-stool', 1);
  take('mutate').answer({ ok: true, res: { result: { ...workshop(2), output: { kind: 'item', itemDef: 'bench-stool', qty: 1 } } } });
  assert.equal((await craft).ok, true);
  assert.deepEqual(stone(homes), { home: 2, wilds: 2 });
  // A storage read asked before a Wilds answer lands after it: the answer’s balance stays.
  const read = village.loadStorage();
  assert.equal(store.applyPathAnswer(undefined, { stone: 5 }), true);
  take('read').answer({ ok: true, value: workshop(2) });
  assert.equal((await read).ok, true);
  assert.deepEqual(stone(homes), { home: 5, wilds: 5 });
  assert.equal(village.inventory!.materials.stone, 5, 'the village’s own counts too');
});

test('a Home side made after the near read starts from the balance the read held: no deed, no Home read, a bump', async () => {
  store.resetWilds({ quiet: true });
  const w = laterHome();
  store.applyNear(near(9), store.readMark(), w.link);
  const homes = homesteadsFor(w.session);
  assert.deepEqual(stone(homes), { home: 9, wilds: 9 }, 'seeded from the held balance');
  // The lane says no deed: no home read, so nothing else would set it.
  const lane = homes.fresh();
  w.take('commons').answer({ ok: true, value: { gates: [], gateCount: 6, mine: null, invites: [] } });
  await lane;
  bumpWilds();
  assert.deepEqual(stone(homes), { home: 9, wilds: 9 });
  // Seeding took no mark: a Home read asked after it is the newer word.
  const read = homes.fetchHome(GATE);
  w.take('home').answer(homeRead(11));
  await read;
  assert.deepEqual(stone(homes), { home: 11, wilds: 11 });
});

test('another account’s session is never seeded with the balance the last one held', () => {
  store.resetWilds({ quiet: true });
  const before = laterHome('me');
  store.applyNear(near(9), store.readMark(), before.link);
  store.resetWilds({ quiet: true });
  const next = laterHome('someone-else');
  const homes = homesteadsFor(next.session);
  assert.equal(homes.materials.stone, undefined, 'their own balance comes with their own reads');
});

test('an answer that shows only some counts (the Yard’s items answer) re-stamps only those', async () => {
  store.resetWilds({ quiet: true });
  const { homes, take, link } = homeWorld();
  store.applyNear(near(4), store.readMark(), link);
  // A Home read goes out; a timber bundle's answer lands first, showing the pack's timber only.
  const read = homes.fetchHome(GATE);
  homes.adoptMaterialCounts({ timber: 5 });
  take('home').answer({ ok: true, value: { gate: GATE, landSeed: 7, home: null, materials: { stone: 9, timber: 2 } } });
  await read;
  assert.deepEqual({ stone: homes.materials.stone, timber: homes.materials.timber }, { stone: 9, timber: 5 }, 'the read’s stone (nothing newer told it), the answer’s timber');
  assert.equal(store.wildsMaterials()!.stone, 9);
});
