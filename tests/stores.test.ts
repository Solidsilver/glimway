import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The client stores (session, items, papers, residents, the held tool and
 * the guide pin). They are Phaser-free, so they load here; these tests
 * listen on the real bus. A session without a link is only ever the
 * title's `null` — the link-less tests below cover the store fallbacks
 * until C2 makes `link` non-null.
 */

// The session saves through window timers; hold them so nothing writes.
const timers: (() => void)[] = [];
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void) => timers.push(fn),
  clearTimeout: () => {},
  addEventListener: () => {},
  removeEventListener: () => {},
};

const { bus, EV } = await import('../src/game/events.ts');
const { Session } = await import('../src/game/session.ts');
const { Link } = await import('../src/game/link.ts');
const { memoryOutboxStore } = await import('../src/lib/api/outbox.ts');
const { fakeServer, player, S } = await import('./helpers/link-rig.ts');
const { grantPaper } = await import('../src/game/papers.ts');
const { itemsFor } = await import('../src/game/items.ts');
const { emitResidents } = await import('../src/game/residents.ts');
const { setHeld, held } = await import('../src/game/held.ts');
const { pinned, setPinned } = await import('../src/game/guide-pin.ts');
const { createNewGame } = await import('../src/lib/state.ts');
const { PAPERS } = await import('../src/content/papers.ts');

type Heard = { name: string; payload: unknown }[];

/** Record what the bus carries for `names` while `fn` runs. */
async function hear(names: string[], fn: () => unknown): Promise<Heard> {
  const heard: Heard = [];
  const fns = names.map((name) => {
    const f = (payload: unknown) => heard.push({ name, payload });
    (bus.on as unknown as (n: string, f: (p: unknown) => void) => void)(name, f);
    return [name, f] as const;
  });
  try {
    await fn();
  } finally {
    for (const [name, f] of fns) (bus.off as unknown as (n: string, f: (p: unknown) => void) => void)(name, f);
  }
  return heard;
}

const freshState = () => ({ ...createNewGame(), maxHp: 50, hp: 40, maxMana: 30, mana: 20 });
const guest = () => new Session(freshState());

test('setVitals clamps to the maxima, tells the HUD once, and saves on a loss', async () => {
  const s = guest();
  timers.length = 0;
  const heard = await hear([EV.stats], () => {
    s.setVitals(80, -5);
    s.setVitals(50, 0);
  });
  assert.equal(s.state.hp, 50);
  assert.equal(s.state.mana, 0);
  assert.equal(heard.length, 1, 'no change, no second emit');
  assert.deepEqual(heard[0].payload, { hp: 50, maxHp: 50, mana: 0, maxMana: 30, glims: s.state.glims });
  assert.equal(timers.length, 1, 'the mana loss is saved soon');
});

test('glims are earned with a toast; a discovery is recorded once', async () => {
  const s = guest();
  const before = s.state.glims;
  const heard = await hear([EV.stats, EV.toast, EV.discovery], () => {
    s.addGlims(3, 'Warm.');
    assert.equal(s.recordDiscovery('well', 'The old well'), true);
    assert.equal(s.recordDiscovery('well', 'The old well'), false);
  });
  assert.equal(s.state.glims, before + 3);
  assert.deepEqual(
    heard.map((h) => h.name),
    [EV.stats, EV.toast, EV.discovery]
  );
  assert.deepEqual(heard[2].payload, { id: 'well', label: 'The old well' });
});

test('a found paper is flagged once and announced to the journal', async () => {
  const s = guest();
  const paper = PAPERS.find((p) => p.source.kind === 'placed')!;
  const heard = await hear([EV.toast, EV.paperFound, EV.papersSync], () => {
    assert.equal(grantPaper(s, paper.id), true);
    assert.equal(grantPaper(s, paper.id), false);
  });
  assert.deepEqual(
    heard.map((h) => h.name),
    [EV.toast, EV.paperFound, EV.papersSync]
  );
  assert.deepEqual(heard[1].payload, { id: paper.id });
  assert.ok((heard[2].payload as { found: string[] }).found.includes(paper.id));
});

test('the residents journal hears only the flags it writes entries from', async () => {
  const s = guest();
  s.state.flags = ['met:hazel@1', 'heirloom:x', 'quest-started', 'warden-sliver:found'];
  const heard = await hear([EV.residentsMet], () => emitResidents(s));
  assert.deepEqual(heard[0].payload, { journalFlags: ['met:hazel@1', 'heirloom:x', 'warden-sliver:found'] });
});

test('a linked session reads its own world, and stores are separate', async () => {
  const link = new Link({
    api: fakeServer().api,
    clientId: 'c1',
    accountId: 'a1',
    device: 'd1',
    name: 'Tansy',
    state: player(S()),
    status: 'offline',
    emit: () => {},
    store: memoryOutboxStore(),
    locks: null,
    channel: null
  })
  const s = new Session(freshState(), undefined, link)
  const items = itemsFor(s)
  assert.equal(items.status, 'idle')
  const heard = await hear([EV.toast], () => bus.emit(EV.gift, { fromName: 'Pip', kind: 'item', itemDef: 'timber', qty: 2 }));
  assert.equal(heard.length, 1, 'only the current store answers');
  assert.match((heard[0].payload as { text: string }).text, /^Pip gave you /);
  assert.notEqual(itemsFor(guest()), items, 'a new session gets its own store');
  s.destroy(true);
  link.stop();
});

test('the held tool and the pinned guide tell the HUD when they change', async () => {
  const heard = await hear([EV.held, EV.guidePin], () => {
    setHeld('chop');
    setPinned('guide:lanterns');
    setPinned('guide:lanterns');
    setPinned(null);
  });
  assert.equal(held.kind, 'chop');
  assert.equal(pinned.slot, null);
  assert.deepEqual(
    heard.map((h) => h.name),
    [EV.held, EV.guidePin, EV.guidePin]
  );
  // A guest's belt holds only the weapon, so the weapon stays in hand.
  assert.deepEqual((heard[0].payload as { kind: string }).kind, 'weapon');
});
