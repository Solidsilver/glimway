import test from 'node:test';
import assert from 'node:assert/strict';
import { FIGHT_NEAR_PX, fightingYou, type FightingEnemy } from '../src/lib/ways-home.ts';
import { ENEMY_TUNING } from '../src/lib/enemies.ts';
import { enemiesNearForSync } from '../src/game/sync-safety.ts';

/** The Tangle, just north of the Commons' mouth: open map, not safe ground. */
const hero = { x: 40, y: 100 };
const enemy = (o: Partial<FightingEnemy> & { dx: number }): FightingEnemy => ({ type: 'wisp', state: 'chase', dead: false, ...o, x: hero.x + o.dx, y: hero.y });

test('ways home: a creature by its camp, out of its aggro range, is no fight (playtest 2026-10-20)', () => {
  const idle = [enemy({ dx: ENEMY_TUNING.wisp.aggro + 10 }), enemy({ type: 'beetle', dx: -(ENEMY_TUNING.beetle.aggro + 10) })];
  assert.equal(enemiesNearForSync('outdoors', hero, idle), true, 'the sync gate still counts them');
  assert.equal(fightingYou('outdoors', hero, idle), false);
  assert.equal(fightingYou('outdoors', hero, [enemy({ dx: 12 * 16 })]), false, 'twelve tiles off');
});

test('ways home: dead, dissolving or parked creatures are no fight', () => {
  assert.equal(fightingYou('outdoors', hero, [enemy({ dx: 10, dead: true }), enemy({ dx: 10, state: 'lunge', parked: true })]), false);
});

test('ways home: a creature inside its aggro range comes for you; one winding up or attacking nearby is a fight', () => {
  assert.equal(fightingYou('outdoors', hero, [enemy({ dx: ENEMY_TUNING.wisp.aggro - 10 })]), true);
  assert.equal(fightingYou('outdoors', hero, [enemy({ type: 'beetle', dx: ENEMY_TUNING.beetle.aggro - 10 })]), true);
  for (const state of ['telegraph', 'lunge', 'recover', 'stunned']) {
    assert.equal(fightingYou('outdoors', hero, [enemy({ dx: FIGHT_NEAR_PX - 10, state })]), true, state);
    assert.equal(fightingYou('outdoors', hero, [enemy({ dx: FIGHT_NEAR_PX + 10, state })]), false, `${state}, far off`);
  }
  assert.equal(fightingYou('ruin', hero, [enemy({ type: 'guardian', dx: FIGHT_NEAR_PX - 10 })]), true, 'the warden');
});

test('ways home: safe ground is never a fight', () => {
  const commons = { x: 40, y: 24 * 16 + 20 };
  assert.equal(fightingYou('outdoors', commons, [{ type: 'wisp', state: 'telegraph', dead: false, x: commons.x + 5, y: commons.y }]), false);
});
