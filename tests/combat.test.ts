import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { craftOf, getCombatKit, levelMarkOf, newlyUnlocked, unlockLine } from '../src/lib/combat.ts';
import { ABILITIES } from '../src/lib/abilities.ts';
import { abilityIconFrame } from '../src/game/crafts-art.ts';
import { toHabiticaProfile } from '../src/lib/habitica/mapping.ts';
import { FIXTURES_BY_KEY, gearLookupFor } from '../src/lib/habitica/fixtures.ts';
import { DEMO_CHARACTER } from '../src/content/world.ts';
import type { HabiticaClass, HabiticaProfile } from '../src/lib/habitica/types.ts';

function profileFrom(key: keyof typeof FIXTURES_BY_KEY): HabiticaProfile {
  const fixture = FIXTURES_BY_KEY[key];
  return toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
}

const hero = (klass: HabiticaClass | null, level: number, stats = { str: 10, int: 20, con: 15, per: 10 }): HabiticaProfile => ({
  ...profileFrom('lowLevel'),
  class: klass,
  level,
  name: 'Tansy',
  stats,
});

test('no profile: the demo hero fights with what is in hand — a slash, no F, no ✦', () => {
  const kit = getCombatKit(null);
  assert.equal(kit.class, null);
  assert.equal(kit.name, DEMO_CHARACTER.name);
  assert.equal(kit.basicName, 'Slash');
  assert.equal(kit.signature, null);
  assert.equal(kit.move, null);
  assert.deepEqual(kit.ahead, []);
  assert.ok(kit.meleeDamage > 0);
  assert.equal(kit.signatureDamage, 0);
  assert.equal(kit.healAmount, 0);
  assert.equal(kit.basicAttackCooldown, 0.6, 'the old starter cadence: the finger-wisp fight is unchanged');
});

test('a classless imported hero has no signature, at any level', () => {
  const classless = getCombatKit(profileFrom('classless'));
  assert.equal(classless.class, null);
  assert.equal(classless.signature, null);
  assert.equal(classless.name, 'Wren');
  const veteran = getCombatKit(hero(null, 60));
  assert.equal(veteran.signature, null, 'never chose a class: no craft, however high');
  assert.equal(veteran.move, null);
});

test('class kits take their signature from the table, by its id and mana', () => {
  const cases = [
    { key: 'variedEquipment', id: 'cleave', mana: 12, cls: 'warrior' },
    { key: 'highLevel', id: 'fingersnap', mana: 15, cls: 'mage' },
  ] as const;
  for (const c of cases) {
    const p = profileFrom(c.key);
    const kit = getCombatKit({ ...p, level: Math.max(p.level, 10) });
    assert.equal(kit.class, c.cls, c.key);
    assert.equal(kit.signature?.id, c.id, c.key);
    assert.equal(kit.signature?.mana, c.mana, c.key);
    assert.equal(kit.signature?.cooldown, 1, 'a signature cools for the report budget’s 1 s');
  }
  for (const [klass, id] of [['rogue', 'shadowstep'], ['healer', 'mend']] as const) assert.equal(getCombatKit(hero(klass, 12)).signature?.id, id);
});

test('under level 10 a classed hero has the basic attack only, and sees what is ahead', () => {
  const kit = getCombatKit(hero('warrior', 2));
  assert.equal(kit.class, 'warrior');
  assert.equal(kit.signature, null);
  assert.equal(kit.move, null);
  assert.deepEqual(kit.ahead.map((m) => [m.id, m.level]), [['cleave', 10], ['stand', 20]]);
});

test('the level-20 move arrives at 20, from the table; veterans get both at once', () => {
  assert.equal(getCombatKit(hero('mage', 19)).move, null);
  const mage = getCombatKit(hero('mage', 20));
  assert.equal(mage.signature?.id, 'fingersnap');
  assert.equal(mage.move?.id, 'kindle');
  assert.deepEqual([mage.move?.mana, mage.move?.cooldown], [16, 5]);
  assert.deepEqual(mage.move?.numbers, { durationSeconds: 6, staggerSeconds: 0, radiusTiles: 1.5, slow: 0.6, reachTiles: 2, pulses: 0, pulseHealFraction: 0 });
  assert.deepEqual(mage.ahead, []);
  for (const [klass, id] of [['warrior', 'stand'], ['rogue', 'echo'], ['healer', 'ward-light']] as const) assert.equal(getCombatKit(hero(klass, 85)).move?.id, id);
});

test('the server’s level mark counts over a lower profile level', () => {
  const p = hero('warrior', 12);
  assert.equal(getCombatKit(p, { levelMark: 25 }).move?.id, 'stand');
  assert.equal(levelMarkOf(p, { levelMark: 25 }), 25);
  assert.equal(levelMarkOf(p, null), 12);
});

test('rebirth: no class on Habitica, but a class mark and a level mark of 10+ keep the craft', () => {
  const reborn = hero(null, 1);
  assert.equal(craftOf(reborn, { levelMark: 40, classMark: 'healer' }), 'healer');
  const kit = getCombatKit(reborn, { levelMark: 40, classMark: 'healer' });
  assert.deepEqual([kit.signature?.id, kit.move?.id], ['mend', 'ward-light']);
  assert.equal(craftOf(reborn, { levelMark: 9, classMark: 'healer' }), null, 'under 10: no craft');
  assert.equal(craftOf(reborn, { levelMark: 40, classMark: null }), null, 'no class ever seen: none');
  assert.equal(craftOf(hero('rogue', 30), { levelMark: 40, classMark: 'healer' }), 'rogue', 'the current class wins');
});

test('the healer’s Mend is a damaging pulse PLUS a heal; a Ward-light pulse is its share of the Mend', () => {
  const healer = getCombatKit(hero('healer', 20));
  assert.ok(healer.signatureDamage > 0);
  assert.ok(healer.healAmount > 0);
  assert.equal(healer.wardPulseHeal, Math.round(healer.healAmount * 0.4 * 100) / 100);
  assert.equal(getCombatKit(hero('healer', 12)).wardPulseHeal, 0, 'no Ward-light yet: no pulse');
  assert.equal(getCombatKit(hero('rogue', 20)).healAmount, 0);
});

test('extreme stats are bounded by diminishing returns', () => {
  const extreme = getCombatKit(hero('warrior', 50, { str: 100000, int: 100000, con: 100000, per: 100000 }));
  assert.ok(extreme.meleeDamage < 30, `meleeDamage ${extreme.meleeDamage} must stay bounded`);
  assert.ok(extreme.signatureDamage < 39, `signatureDamage ${extreme.signatureDamage} must stay bounded`);
  assert.ok(extreme.mitigation < 0.5, 'mitigation must stay under 50%');
  assert.ok(extreme.critChance < 0.5, 'crit chance must stay under 50%');
  assert.equal(extreme.healAmount, 0);
});

test('kit numbers scale with stats but never below their floors', () => {
  const weak = getCombatKit(hero('warrior', 10, { str: 0, int: 0, con: 0, per: 0 }));
  assert.equal(weak.meleeDamage, 5);
  assert.equal(weak.signatureDamage, 8);
  assert.equal(weak.mitigation, 0);
  assert.equal(weak.critChance, 0.05);
  const strong = getCombatKit(hero('warrior', 10, { str: 60, int: 60, con: 60, per: 60 }));
  assert.ok(strong.meleeDamage > weak.meleeDamage);
  assert.ok(strong.mitigation > weak.mitigation);
  assert.ok(strong.critChance > weak.critChance);
});

test('the unlock notice: a level mark crossing 10 or 20 names what arrived, and where it is', () => {
  const p = hero('mage', 0);
  assert.deepEqual(newlyUnlocked(p, { levelMark: 19 }, { levelMark: 20 }).map((m) => m.id), ['kindle']);
  assert.deepEqual(newlyUnlocked(p, { levelMark: 9 }, { levelMark: 25 }).map((m) => m.id), ['fingersnap', 'kindle']);
  assert.deepEqual(newlyUnlocked(p, { levelMark: 20 }, { levelMark: 21 }), []);
  assert.deepEqual(newlyUnlocked(hero(null, 0), { levelMark: 19 }, { levelMark: 20 }), [], 'no craft: nothing to announce');
  const [kindle] = newlyUnlocked(p, { levelMark: 19 }, { levelMark: 20 });
  assert.equal(unlockLine(kindle), 'New at level 20: Kindle. It’s on R, and the second ✦ on phones.');
  const [snap] = newlyUnlocked(p, { levelMark: 9 }, { levelMark: 10 });
  assert.equal(unlockLine(snap), 'New at level 10: Fingersnap. It’s on F, and the ✦ on phones.');
});

test('every ability’s icon is in the crafts art pass (crafts.md 4.1: a test, not the loader)', () => {
  const manifest = JSON.parse(readFileSync(new URL('../assets/generated/crafts-pass/manifest.json', import.meta.url), 'utf8')) as { frames: Record<string, unknown> };
  for (const a of ABILITIES.abilities) {
    assert.equal(a.icon, `ability-${a.id}`, `${a.id}: the table names its icon by id`);
    assert.ok(manifest.frames[abilityIconFrame(a)], `${a.id}: ${abilityIconFrame(a)} delivered`);
  }
});
