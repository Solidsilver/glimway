import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * The client stores (session, papers, residents, the held tool and the
 * guide pin). They are Phaser-free, so they load here; these tests listen
 * on the real bus. (A session without a link is what the title screen holds
 * until a sign-in plays one; C2 removes the branch.)
 */

// The session saves through window timers; hold them so nothing writes.
const timers: (() => void)[] = [];
(globalThis as unknown as { window: unknown }).window = {
  setTimeout: (fn: () => void) => timers.push(fn),
  clearTimeout: () => {},
};

const { bus, EV } = await import('../src/game/events.ts');
const { Session } = await import('../src/game/session.ts');
const { grantPaper } = await import('../src/game/papers.ts');
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

const guest = () => new Session({ ...createNewGame(), maxHp: 50, hp: 40, maxMana: 30, mana: 20 });

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
  assert.deepEqual(heard[0].payload, { hp: 50, maxHp: 50, mana: 0, maxMana: 30, embers: s.state.embers });
  assert.equal(timers.length, 1, 'the mana loss is saved soon');
});

test('embers are earned with a toast; a discovery is recorded once', async () => {
  const s = guest();
  const before = s.state.embers;
  const heard = await hear([EV.stats, EV.toast, EV.discovery], () => {
    s.addEmbers(3, 'Warm.');
    assert.equal(s.recordDiscovery('well', 'The old well'), true);
    assert.equal(s.recordDiscovery('well', 'The old well'), false);
  });
  assert.equal(s.state.embers, before + 3);
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

test('the held tool and the pinned guide tell the HUD when they change', async () => {
  const heard = await hear([EV.held, EV.guidePin], () => {
    setHeld('chop');
    setPinned('lanterns');
    setPinned('lanterns');
    setPinned(null);
  });
  assert.equal(held.kind, 'chop');
  assert.equal(pinned.id, null);
  assert.deepEqual(
    heard.map((h) => h.name),
    [EV.held, EV.guidePin, EV.guidePin]
  );
  // A guest's belt holds only the weapon, so the weapon stays in hand.
  assert.deepEqual((heard[0].payload as { kind: string }).kind, 'weapon');
});
