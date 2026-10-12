import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMP_READ_EVERY_MS, CAMP_READ_TRIES, ServerCampOutcome, type CampNow } from '../src/game/wilds/camp-fights.ts';

function rig() {
  let now = 0;
  let room: boolean | undefined = undefined;
  let asks = 0;
  const outcome = new ServerCampOutcome(() => room, () => asks++, () => now);
  const camp = (over: Partial<CampNow> = {}): CampNow => ({ id: 'camp:0:0:0', epoch: 'still', cycle: 1, claimable: false, ...over });
  return {
    outcome,
    camp,
    set room(v: boolean | undefined) { room = v; },
    get asks() { return asks; },
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

test('a completion asks a bounded, spaced number of reads, and a new completion earns a new round', () => {
  const r = rig();
  r.room = true;
  for (let i = 0; i < 20; i++) { r.outcome.won(r.camp()); r.wait(CAMP_READ_EVERY_MS / 2); }
  assert.equal(r.asks, CAMP_READ_TRIES, 'never more than the bounded tries');
  r.room = false; r.outcome.won(r.camp());
  r.room = true; r.outcome.won(r.camp());
  assert.equal(r.asks, CAMP_READ_TRIES + 1, 'the room stood again and fell again');
  r.room = undefined; r.wait(CAMP_READ_EVERY_MS * 10); r.outcome.won(r.camp());
  assert.equal(r.asks, CAMP_READ_TRIES + 1, 'an absent room asks nothing');
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
