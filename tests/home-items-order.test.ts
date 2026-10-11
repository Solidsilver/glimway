import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * Late reads in the Home and Items models (step-back review F3): a read
 * asked before an action's answer, or before another read, never undoes
 * what landed after it was asked; and the Home's fresh read is asked anew,
 * never joined to a read from before a change.
 */

// The session saves through window timers; hold them so nothing writes.
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: () => 0,
  clearTimeout: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { Session } = await import('../src/game/session.ts');
const { homesteadsFor } = await import('../src/game/homestead.ts');
const { itemsFor } = await import('../src/game/items.ts');
const { createNewGame } = await import('../src/lib/state.ts');

type Call = { name: string; args: unknown[]; answer: (v: unknown) => void };

/** A link whose reads and actions wait until the test answers them, in any order. */
function deferredLink() {
  const calls: Call[] = [];
  const wait = (name: string) => (...args: unknown[]) => new Promise((answer) => calls.push({ name, args, answer }));
  const link = {
    accountId: 'me',
    worldId: 'world-1',
    status: 'online',
    attach: () => {},
    takePaper: () => {},
    api: { operations: {} },
    readCommons: wait('commons'),
    readHome: wait('home'),
    homeAction: wait('action'),
    readWith: wait('items'),
    mutate: wait('mutate'),
  };
  /** The oldest unanswered call of this kind. */
  const take = (name: string): Call => {
    const i = calls.findIndex((c) => c.name === name);
    assert.ok(i >= 0, `a ${name} call is waiting`);
    return calls.splice(i, 1)[0]!;
  };
  return { link, calls, take };
}

function session(link: unknown) {
  return new Session({ ...createNewGame(), maxHp: 50, hp: 40, maxMana: 30, mana: 20 }, undefined, link as never);
}

const settle = () => new Promise((r) => setTimeout(r, 0));

const GATE = 2;
const lane = { gates: [{ gate: GATE, homeId: 'home-1', members: [{ id: 'me', displayName: 'Me' }], tier: 0, desolate: false, shelf: false, shelfStocked: false, price: null, reclaim: false }], gateCount: 6, mine: { gate: GATE }, invites: [] };
const home = (items: string[]) => ({ id: 'home-1', gate: GATE, landSeed: 7, member: true, tier: 0, desolate: false, members: [{ id: 'me', displayName: 'Me' }], cleared: [], stumps: [], plants: [], items: items.map((id) => ({ id, itemDef: 'wooden-stool', location: 'placed', scene: 'outdoor', x: 1, y: 1, rotation: 0 })) });

/** Everything the inventory and the land show of your home. */
function homeShown(homes: ReturnType<typeof homesteadsFor>) {
  return { myGate: homes.myGate, mine: homes.mine, materials: homes.materials, status: homes.status };
}

test('a home read answered after an action can’t undo the action', async () => {
  const { link, take } = deferredLink();
  const homes = homesteadsFor(session(link));
  // Settle in: the lane, then your home.
  const first = homes.load();
  take('commons').answer({ ok: true, value: lane });
  await settle();
  take('home').answer({ ok: true, value: { gate: GATE, landSeed: 7, home: home([]), materials: { timber: 10 } } });
  await first;
  assert.deepEqual(homes.mine!.items, []);

  // A read goes out (walking through your gate); a buy is answered before it.
  const late = homes.fetchHome(GATE);
  const buy = homes.buy('wooden-stool');
  take('action').answer({ ok: true, home: home(['stool-1']), materials: { timber: 4 }, itemId: 'stool-1' });
  assert.equal((await buy).ok, true);
  const after = structuredClone(homeShown(homes));
  assert.deepEqual(after.mine!.items.map((i) => i.id), ['stool-1']);
  assert.equal(after.materials.timber, 4);
  // The earlier read lands, from before the buy.
  take('home').answer({ ok: true, value: { gate: GATE, landSeed: 7, home: home([]), materials: { timber: 10 } } });
  const got = await late;
  assert.deepEqual(homeShown(homes), after, 'the home, its goods and the materials as the buy left them');
  assert.deepEqual(got!.items.map((i) => i.id), ['stool-1'], 'the read hands back the home as held');

  // A lane read asked before you left can't put your gate back.
  const lateLane = homes.load();
  const left = homes.leave();
  take('action').answer({ ok: true, home: null, materials: { timber: 4 } });
  await settle();
  const [oldLane, freshLane] = [take('commons'), take('commons')];
  oldLane.answer({ ok: true, value: lane });
  await lateLane;
  assert.equal(homes.myGate, null, 'the old lane still named your gate: dropped');
  freshLane.answer({ ok: true, value: { ...lane, gates: [{ ...lane.gates[0]!, homeId: null, members: [] }], mine: null } });
  assert.equal((await left).ok, true);
  assert.equal(homes.myGate, null);
  assert.equal(homes.mine, null);
});

test('the fresh home read is asked anew: it never joins a read from before a change', async () => {
  const { link, calls, take } = deferredLink();
  const homes = homesteadsFor(session(link));
  // A read asked before the goods were seeded (the scene's first read): its home read is out.
  const before = homes.load();
  take('commons').answer({ ok: true, value: lane });
  await settle();
  assert.equal(homes.load(), before, 'load() joins the read in flight');
  // The server's home changes (a seeded test, a partner's signature); the fresh read asks again.
  const fresh = homes.fresh();
  assert.equal(calls.filter((c) => c.name === 'commons').length, 1, 'a lane read of its own');
  assert.equal(homes.load(), fresh, 'later loads join the fresh read');
  take('commons').answer({ ok: true, value: lane });
  await settle();
  // Answered backwards: the fresh read's home first, then the one from before the seeding.
  const [old, now] = [take('home'), take('home')];
  now.answer({ ok: true, value: { gate: GATE, landSeed: 7, home: home(['inv-a']), materials: { timber: 12 } } });
  await fresh;
  assert.deepEqual(homes.mine!.items.map((i) => i.id), ['inv-a']);
  const shown = structuredClone(homeShown(homes));
  old.answer({ ok: true, value: { gate: GATE, landSeed: 7, home: home([]), materials: { timber: 3 } } });
  await before;
  assert.deepEqual(homeShown(homes), shown, 'the stool and the balances stay');
});

const pack = (stools: number) => ({ stacks: [{ itemDef: 'wooden-stool', qty: stools }], instances: [], pockets: [], offHand: { open: false, itemDef: null }, pickedUp: [] });

test('two pack reads answered backwards leave the later read’s pack', async () => {
  const { link, take } = deferredLink();
  const items = itemsFor(session(link));
  const older = items.load();
  const newer = items.load();
  const [a, b] = [take('items'), take('items')];
  b.answer({ ok: true, value: { items: pack(2) } });
  assert.equal((await newer).ok, true);
  const shown = structuredClone({ view: items.view, status: items.status });
  a.answer({ ok: true, value: { items: pack(1) } });
  assert.equal((await older).ok, true);
  assert.deepEqual({ view: items.view, status: items.status }, shown);
  // An older read's failure doesn't take the pack offline either.
  const lost = items.load();
  const fresh = items.load();
  const [c, d] = [take('items'), take('items')];
  d.answer({ ok: true, value: { items: pack(3) } });
  await fresh;
  c.answer({ ok: false, code: 'offline' });
  await lost;
  assert.equal(items.status, 'ready');
  assert.equal(items.view!.stacks[0]!.qty, 3);
});

test('a pack read answered after an action can’t undo the action', async () => {
  const { link, take } = deferredLink();
  const items = itemsFor(session(link));
  const first = items.load();
  take('items').answer({ ok: true, value: { items: pack(1) } });
  await first;
  const late = items.load();
  const bought = items.buy('silas-yard', 'wooden-stool');
  take('mutate').answer({ ok: true, res: { result: { items: pack(2) } } });
  assert.equal((await bought).ok, true);
  const shown = structuredClone({ view: items.view, status: items.status });
  take('items').answer({ ok: true, value: { items: pack(1) } });
  await late;
  assert.deepEqual({ view: items.view, status: items.status }, shown, 'the pack as the buy left it');
  // A read asked after the answer is the newer word.
  const after = items.load();
  take('items').answer({ ok: true, value: { items: pack(5) } });
  await after;
  assert.equal(items.view!.stacks[0]!.qty, 5);
});
