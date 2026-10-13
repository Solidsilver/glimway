import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMP_READ_EVERY_MS, ServerCampOutcome, type CampNow } from '../src/game/wilds/camp-fights.ts';

function rig() {
  let now = 0;
  let room: boolean | undefined = undefined;
  let asks = 0;
  const pending: (() => void)[] = [];
  const outcome = new ServerCampOutcome(() => room, () => { asks++; return new Promise<void>(resolve => pending.push(resolve)); }, () => now);
  const camp = (over: Partial<CampNow> = {}): CampNow => ({ id: 'camp:0:0:0', epoch: 'still', cycle: 1, claimable: false, ...over });
  return {
    outcome,
    camp,
    set room(v: boolean | undefined) { room = v; },
    get asks() { return asks; },
    async finish(index = 0) { pending[index]!(); await Promise.resolve(); },
    wait: (ms: number) => { now += ms; },
  };
}

test('only the near read’s word for the exact cycle makes a camp claimable; dead rows alone never do', () => {
  const r = rig();
  r.room = true;
  assert.equal(r.outcome.won(r.camp()), false, 'corpse rows without the server’s word are not a claim');
  assert.equal(r.asks, 1, 'the completion asks for a fresh near read');
  assert.equal(r.outcome.won(r.camp({ claimable: true })), true, 'the read names this cycle claimable');
});

test('a completion retries slowly until it is claimable, with only one read in flight', async () => {
  const r = rig();
  r.room = true;
  r.outcome.won(r.camp());
  for (let i = 0; i < 10; i++) { r.outcome.won(r.camp()); r.wait(CAMP_READ_EVERY_MS); }
  assert.equal(r.asks, 1, 'a slow read is not duplicated while in flight');
  await r.finish(r.asks - 1);
  r.outcome.won(r.camp());
  assert.equal(r.asks, 2, 'a completed read schedules another recovery attempt');
  await r.finish(r.asks - 1);
  r.wait(CAMP_READ_EVERY_MS);
  r.outcome.won(r.camp());
  assert.equal(r.asks, 3, 'recovery continues without a four-read cutoff');
  await r.finish(r.asks - 1);
  r.outcome.won(r.camp({ claimable: true }));
  r.wait(CAMP_READ_EVERY_MS * 2); r.outcome.won(r.camp({ claimable: true }));
  assert.equal(r.asks, 3, 'durable eligibility stops recovery');
  r.room = false; r.outcome.won(r.camp());
  r.room = true; r.outcome.won(r.camp());
  assert.equal(r.asks, 4, 'the room stood again and fell again');
  r.room = undefined; r.wait(CAMP_READ_EVERY_MS * 10); r.outcome.won(r.camp());
  assert.equal(r.asks, 4, 'an absent room asks nothing');
});

test('unknown room or socket keeps the store’s word; standing rows hide it; a new cycle or epoch starts over', () => {
  const r = rig();
  r.room = undefined;
  assert.equal(r.outcome.won(r.camp({ claimable: true })), true, 'a down socket keeps the last confirmed word');
  r.room = false;
  assert.equal(r.outcome.won(r.camp({ claimable: true })), false, 'a standing row (a respawn) hides the prompt at once');
  r.room = true;
  assert.equal(r.outcome.won(r.camp({ cycle: 2 })), false, 'the previous cycle’s corpses are not the next cycle’s win');
  r.outcome.claimed(r.camp({ cycle: 2 }));
  assert.equal(r.outcome.won(r.camp({ cycle: 2, epoch: 'next', claimable: true })), true, 'another epoch is another camp');
});

test('a settled claim ends this account’s prompt for that cycle only', () => {
  const r = rig();
  r.room = true;
  r.outcome.claimed(r.camp({ claimable: true }));
  assert.equal(r.outcome.won(r.camp({ claimable: true })), false, 'claimed, before the next read says so');
  const before = r.asks;
  r.wait(CAMP_READ_EVERY_MS * 2); r.outcome.won(r.camp());
  assert.equal(r.asks, before, 'a claimed cycle asks nothing more');
  assert.equal(r.outcome.won(r.camp({ cycle: 2, claimable: true })), true, 'the next cycle is new');
});


test('unknown room gaps preserve recovery cadence and a pending read', async () => {
  const r = rig(); r.room = true; r.outcome.won(r.camp());
  r.wait(1000);
  for (let i = 0; i < 6; i++) {
    r.room = undefined; r.outcome.won(r.camp());
    r.room = true; r.outcome.won(r.camp());
  }
  assert.equal(r.asks, 1, 'room gaps cannot reopen a pending read');
  await r.finish();
  r.room = undefined; r.outcome.won(r.camp());
  r.room = true; r.outcome.won(r.camp());
  assert.equal(r.asks, 1, 'room gaps cannot reset the five-second spacing');
  r.wait(CAMP_READ_EVERY_MS - 1000); r.outcome.won(r.camp());
  assert.equal(r.asks, 2);
});

test('respawn starts fresh recovery and an old read cannot release the new fall gate', async () => {
  const r = rig(); r.room = true; r.outcome.won(r.camp());
  r.room = false; r.outcome.won(r.camp());
  r.room = true; r.outcome.won(r.camp());
  assert.equal(r.asks, 2, 'the next fall does not wait for the obsolete read');
  await r.finish(0); r.wait(CAMP_READ_EVERY_MS); r.outcome.won(r.camp());
  assert.equal(r.asks, 2, 'only the current fall read can release its gate');
  await r.finish(1); r.outcome.won(r.camp()); assert.equal(r.asks, 3);
});

test('new cycles, epochs and scene lifetimes ignore obsolete read completions', async () => {
  const r = rig(); r.room = true; r.outcome.won(r.camp());
  r.outcome.won(r.camp({ cycle: 2 }));
  await r.finish(0); r.wait(CAMP_READ_EVERY_MS); r.outcome.won(r.camp({ cycle: 2 }));
  assert.equal(r.asks, 2);
  r.outcome.won(r.camp({ cycle: 2, epoch: 'new' }));
  await r.finish(1); r.wait(CAMP_READ_EVERY_MS); r.outcome.won(r.camp({ cycle: 2, epoch: 'new' }));
  assert.equal(r.asks, 3);
  r.outcome.clear(); r.outcome.won(r.camp());
  await r.finish(2); r.wait(CAMP_READ_EVERY_MS); r.outcome.won(r.camp());
  assert.equal(r.asks, 4);
});

test('one camp read finishing leaves another camp recovery pending', async () => {
  const r = rig(); r.room = true;
  const first = r.camp(), second = r.camp({ id: 'camp:1:0:0' });
  r.outcome.won(first); r.outcome.won(second);
  assert.equal(r.asks, 2);
  await r.finish(0); r.wait(CAMP_READ_EVERY_MS);
  r.outcome.won(second); assert.equal(r.asks, 2, 'the other camp still owns its pending read');
  r.outcome.won(first); assert.equal(r.asks, 3, 'the finished camp may retry');
});

test('a rejected recovery read releases only its attempt and keeps the retry cadence', async () => {
  let now = 0, asks = 0;
  const outcome = new ServerCampOutcome(() => true, async () => { asks++; throw new Error('offline'); }, () => now);
  const camp = { id: 'camp:0:0:0', epoch: 'still', cycle: 1, claimable: false };
  outcome.won(camp); await Promise.resolve();
  now = CAMP_READ_EVERY_MS - 1; outcome.won(camp); assert.equal(asks, 1);
  now++; outcome.won(camp); assert.equal(asks, 2);
  await Promise.resolve();
});
