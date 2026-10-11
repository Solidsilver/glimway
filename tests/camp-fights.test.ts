import test from 'node:test';
import assert from 'node:assert/strict';
import { CampFights, type CampNow } from '../src/game/wilds/camp-fights.ts';

/**
 * Generated camps' fights follow the camp's epoch, entity and cycle, apart
 * from drawing them (step-back review F6): checked through the creatures
 * the host holds as well as the claim's eligibility.
 */

/** The enemy system as far as camps use it: creatures per camp, each alive or down. */
function host() {
  const creatures = new Map<string, boolean[]>();
  const spawned: string[] = [];
  return {
    creatures,
    spawned,
    spawn: (c: CampNow) => {
      spawned.push(`${c.id}@${c.epoch}#${c.cycle}`);
      creatures.set(c.id, [true, true, true]);
    },
    remove: (id: string) => void creatures.delete(id),
    alive: (id: string) => creatures.get(id)?.some(Boolean) ?? false,
    /** The hero downs every creature of a camp. */
    clear: (id: string) => creatures.set(id, (creatures.get(id) ?? []).map(() => false)),
    standing: (id: string) => creatures.get(id)?.filter(Boolean).length ?? 0,
  };
}

const camp = (cycle: number, available = true, epoch = 'wick-1', id = 'camp:1:2:0'): CampNow => ({ id, epoch, cycle, available });

test('cleared, depleted, then the next cycle while the chunk stays attached: a new fight, not a free claim', () => {
  const h = host();
  const fights = new CampFights(h);
  fights.reconcile([camp(1)]);
  assert.deepEqual(h.spawned, ['camp:1:2:0@wick-1#1']);
  assert.equal(fights.won(camp(1)), false, 'not claimable while its creatures stand');
  h.clear('camp:1:2:0');
  fights.reconcile([camp(1)]);
  assert.equal(fights.won(camp(1)), true, 'claimable once they are down');
  assert.equal(h.spawned.length, 1, 'no second spawn for the same cycle');
  // The claim lands: the read says depleted.
  fights.reconcile([camp(1, false)]);
  assert.equal(h.creatures.has('camp:1:2:0'), false, 'the fight’s creatures go');
  assert.equal(fights.won(camp(1)), false);
  // The next cycle comes round, chunk attached throughout.
  fights.reconcile([camp(2)]);
  assert.deepEqual(h.spawned, ['camp:1:2:0@wick-1#1', 'camp:1:2:0@wick-1#2']);
  assert.equal(h.standing('camp:1:2:0'), 3);
  assert.equal(fights.won(camp(2)), false, 'the next cycle must be fought');
  assert.equal(fights.won(camp(1)), false, 'and the old cycle’s win doesn’t count for it');
  // A cycle number moving on without a depletion read in between is also a new fight.
  h.clear('camp:1:2:0');
  fights.reconcile([camp(3)]);
  assert.equal(h.standing('camp:1:2:0'), 3);
  assert.equal(fights.won(camp(3)), false);
});

test('a depleted camp come round again under the same cycle number is fought again', () => {
  const h = host();
  const fights = new CampFights(h);
  fights.reconcile([camp(4)]);
  h.clear('camp:1:2:0');
  fights.reconcile([camp(4, false)]);
  // Its timer ran out before a read projected the next cycle.
  fights.reconcile([camp(4)]);
  assert.equal(h.spawned.length, 2);
  assert.equal(fights.won(camp(4)), false);
});

test('another player’s claim mid-fight ends it: the creatures go, nothing to claim', () => {
  const h = host();
  const fights = new CampFights(h);
  fights.reconcile([camp(1)]);
  h.creatures.set('camp:1:2:0', [false, true, true]);
  fights.reconcile([camp(1, false)]);
  assert.equal(h.creatures.has('camp:1:2:0'), false);
  assert.equal(fights.won(camp(1)), false);
  fights.reconcile([camp(1, false)]);
  assert.equal(h.spawned.length, 1, 'a depleted camp sets nothing out');
});

test('leaving and coming back: an unfinished fight is set out again, a won one stays won', () => {
  const h = host();
  const fights = new CampFights(h);
  fights.reconcile([camp(1)]);
  assert.deepEqual(fights.ids(), ['camp:1:2:0'], 'the camp is on record, for its chunk to take away');
  fights.undraw('camp:1:2:0');
  assert.equal(h.creatures.has('camp:1:2:0'), false, 'its chunk left: the creatures go');
  assert.equal(fights.won(camp(1)), false, 'taken away is not beaten');
  fights.reconcile([camp(1)]);
  assert.equal(h.standing('camp:1:2:0'), 3, 'back in the window: the fight is there again');
  h.clear('camp:1:2:0');
  fights.undraw('camp:1:2:0');
  fights.reconcile([camp(1)]);
  assert.equal(h.spawned.length, 2, 'a won fight isn’t set out again');
  assert.equal(fights.won(camp(1)), true);
});

test('a new wick reusing a camp id is another camp', () => {
  const h = host();
  const fights = new CampFights(h);
  fights.reconcile([camp(1)]);
  h.clear('camp:1:2:0');
  fights.reconcile([camp(1)]);
  assert.equal(fights.won(camp(1)), true);
  fights.reconcile([camp(1, true, 'wick-2')]);
  assert.deepEqual(h.spawned, ['camp:1:2:0@wick-1#1', 'camp:1:2:0@wick-2#1']);
  assert.equal(h.standing('camp:1:2:0'), 3);
  assert.equal(fights.won(camp(1, true, 'wick-2')), false);
  assert.equal(fights.won(camp(1)), false, 'the old wick’s win is gone with it');
});
