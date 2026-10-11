import test from 'node:test';
import assert from 'node:assert/strict';
import { getCombatKit } from '../src/lib/combat.ts';
import {
  combatFormula, fightCritRoll, fightCrit, fightDamage, fightReach, fightBoltSpawn, fightTickAt, fightTickDiff,
  fightWindupTicks, fightAimLocked, fightLaunched, fightFacingFromStep, type FightCampKind,
} from '../src/lib/fight-math.ts';
import { COMBAT_TUNING, validateCombat } from '../src/lib/combat-timing.ts';
import { ENEMY_TUNING, KNOCK, validateEnemies } from '../src/lib/enemies.ts';
import { FIXTURES_BY_KEY, gearLookupFor } from '../src/lib/habitica/fixtures.ts';
import { toHabiticaProfile } from '../src/lib/habitica/mapping.ts';
import type { HabiticaClass } from '../src/lib/habitica/types.ts';
import vectors from '../content/vectors/fights.json' with { type: 'json' };
import combatRaw from '../content/combat.json' with { type: 'json' };
import enemiesRaw from '../content/enemies.json' with { type: 'json' };
import combatLoader from '../content/vectors/combat-loader.json' with { type: 'json' };
import enemiesLoader from '../content/vectors/enemies-loader.json' with { type: 'json' };
import { refusalMatchesRule } from './helpers/vector-rule.ts';

const fixture = FIXTURES_BY_KEY.lowLevel;
const profile = toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
for (const v of vectors.kit) test(`fight kit: ${v.name}`, () => {
  const kit = getCombatKit({ ...profile, class: v.craft as HabiticaClass | null, level: v.level, stats: v.stats });
  for (const key of Object.keys(v.expected) as (keyof typeof v.expected)[]) assert.equal(kit[key], v.expected[key], key);
  assert.equal(kit.meleeDamage, combatFormula(v.stats.str, COMBAT_TUNING.melee));
});
test('shared crit rolls and strict chance boundaries', () => {
  for (const v of vectors.crit) {
    assert.equal(fightCritRoll(v.seed, v.swingCounter), v.roll);
    assert.equal(fightCrit(v.seed, v.swingCounter, v.chance), v.crit);
  }
});
test('shared damage preserves tool rounding, crit and stunned vulnerability', () => {
  for (const v of vectors.damage) assert.equal(fightDamage(v.base, v.crit, v.stunnedMultiplier, v.tool), v.damage);
});
test('shared reach uses directional slash offsets, bolt centres and open radius boundaries', () => {
  for (const v of vectors.reach) assert.equal(fightReach(v.kind as 'slash' | 'bolt', v.x, v.y, v.facingX, v.facingY, v.enemyX, v.enemyY), v.hit);
});
test('shared bolt spawn, world tick grid and wrap-aware tick difference', () => {
  for (const v of vectors.boltSpawn) assert.deepEqual(fightBoltSpawn(v.x, v.y, v.facingX), { x: v.spawnX, y: v.spawnY });
  for (const v of vectors.ticks) assert.deepEqual(fightTickAt(v.unixMs), { tick: v.tick, offsetMs: v.offsetMs });
  for (const v of vectors.tickDiff) assert.equal(fightTickDiff(v.a, v.b), v.diff);
});
test('facing steps read back within half a step of the facing the sim quantised', () => {
  for (const v of vectors.facing) {
    const back = fightFacingFromStep(v.step);
    assert.ok(Math.abs(Math.hypot(back.x, back.y) - 1) < 1e-12);
    if (v.x === 0 && v.y === 0) continue;
    const turn = Math.atan2(back.y, back.x) - Math.atan2(v.y, v.x);
    const off = Math.abs(Math.atan2(Math.sin(turn), Math.cos(turn)));
    assert.ok(off <= Math.PI / 256 + 1e-12, `step ${v.step}`);
  }
});
test('enemy tuning and tick-based aim-lock/launch edges match shared vectors', () => {
  for (const v of vectors.windup) {
    const kind = v.kind as FightCampKind;
    assert.deepEqual(fightWindupTicks(kind), { lock: v.lockTick, launch: v.launchTick });
    // Today's telegraph windows survive the 10 Hz grid.
    assert.ok((v.launchTick - v.lockTick) / 10 >= ENEMY_TUNING[kind].lock);
    assert.ok(v.launchTick / 10 >= ENEMY_TUNING[kind].windup);
  }
  for (const v of vectors.timing) {
    assert.equal(fightAimLocked(v.kind as FightCampKind, v.elapsedTicks), v.locked, `${v.kind} ${v.elapsedTicks}`);
    assert.equal(fightLaunched(v.kind as FightCampKind, v.elapsedTicks), v.launched, `${v.kind} ${v.elapsedTicks}`);
  }
  assert.equal(KNOCK.time, enemiesRaw.knock.time);
  for (const kind of ['wisp', 'beetle', 'guardian'] as const) {
    const { $typeName, ...numbers } = ENEMY_TUNING[kind];
    assert.deepEqual(numbers, enemiesRaw[kind]);
  }
});
for (const [family, raw, fixtures, validate] of [
  ['combat', combatRaw, combatLoader, validateCombat],
  ['enemies', enemiesRaw, enemiesLoader, validateEnemies],
] as const) {
  for (const v of fixtures.loader) test(`shared ${family} loader: ${v.name}`, () => {
    const value: any = structuredClone(raw);
    for (const edit of v.edits) {
      let target = value;
      for (const key of edit.path.slice(0, -1)) target = target[key];
      const e = edit as { path: string[]; remove?: boolean; value?: unknown };
      if (e.remove) delete target[e.path.at(-1)!]; else target[e.path.at(-1)!] = e.value;
    }
    if (v.valid) assert.doesNotThrow(() => validate(value));
    else assert.throws(() => validate(value), (e: Error) => refusalMatchesRule(e, (v as {rule?: string}).rule ?? ''));
  });
}
