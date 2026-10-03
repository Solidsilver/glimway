import test from 'node:test';
import assert from 'node:assert/strict';
import { getCombatKit } from '../src/lib/combat.ts';
import { toHabiticaProfile } from '../src/lib/habitica/mapping.ts';
import { FIXTURES_BY_KEY, gearLookupFor } from '../src/lib/habitica/fixtures.ts';
import { DEMO_CHARACTER } from '../src/content/world.ts';
import type { HabiticaProfile } from '../src/lib/habitica/types.ts';

function profileFrom(key: keyof typeof FIXTURES_BY_KEY): HabiticaProfile {
  const fixture = FIXTURES_BY_KEY[key];
  return toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
}

test('null profile yields the classless starter kit with the existing bolt', () => {
  const kit = getCombatKit(null);
  assert.equal(kit.class, null);
  assert.equal(kit.name, DEMO_CHARACTER.name);
  assert.equal(kit.signature, 'bolt');
  assert.equal(kit.manaCost, 15);
  assert.ok(kit.meleeDamage > 0);
  assert.ok(kit.signatureDamage > 0);
  assert.equal(kit.healAmount, 0);
});

test('class kits map to their signature abilities', () => {
  const cases = [
    { key: 'variedEquipment', signature: 'cleave', cls: 'warrior' },
    { key: 'highLevel', signature: 'bolt', cls: 'mage' },
    { key: 'lowLevel', signature: 'cleave', cls: 'warrior' },
  ] as const;
  for (const c of cases) {
    const kit = getCombatKit(profileFrom(c.key));
    assert.equal(kit.signature, c.signature, c.key);
    assert.equal(kit.class, c.cls, c.key);
    assert.ok(kit.basicName.length > 0);
    assert.ok(kit.signatureName.length > 0);
  }
});

test('rogue and healer kits: dash, and heal is a damaging pulse PLUS a heal', () => {
  const rogue = getCombatKit({
    ...profileFrom('lowLevel'),
    class: 'rogue',
    name: 'Sable',
    stats: { str: 15, int: 10, con: 12, per: 20 },
  });
  assert.equal(rogue.signature, 'dash');
  assert.ok(rogue.critChance > 0);

  const healer = getCombatKit({
    ...profileFrom('lowLevel'),
    class: 'healer',
    name: 'Tansy',
    stats: { str: 10, int: 20, con: 15, per: 10 },
  });
  assert.equal(healer.signature, 'heal');
  assert.ok(healer.signatureDamage > 0, 'healer signature is also a damaging pulse');
  assert.ok(healer.healAmount > 0, 'healer signature also heals');
});

test('extreme stats are bounded by diminishing returns', () => {
  const extreme = getCombatKit({
    ...profileFrom('lowLevel'),
    class: 'warrior',
    stats: { str: 100000, int: 100000, con: 100000, per: 100000 },
  });
  assert.ok(extreme.meleeDamage < 30, `meleeDamage ${extreme.meleeDamage} must stay bounded`);
  assert.ok(extreme.signatureDamage < 39, `signatureDamage ${extreme.signatureDamage} must stay bounded`);
  assert.ok(extreme.mitigation < 0.5, 'mitigation must stay under 50%');
  assert.ok(extreme.critChance < 0.5, 'crit chance must stay under 50%');
  assert.ok(extreme.healAmount === 0);
});

test('kit numbers scale with stats but never below their floors', () => {
  const weak = getCombatKit({
    ...profileFrom('lowLevel'),
    class: 'warrior',
    stats: { str: 0, int: 0, con: 0, per: 0 },
  });
  assert.equal(weak.meleeDamage, 5);
  assert.equal(weak.signatureDamage, 8);
  assert.equal(weak.mitigation, 0);
  assert.equal(weak.critChance, 0.05);

  const strong = getCombatKit({
    ...profileFrom('lowLevel'),
    class: 'warrior',
    stats: { str: 60, int: 60, con: 60, per: 60 },
  });
  assert.ok(strong.meleeDamage > weak.meleeDamage);
  assert.ok(strong.mitigation > weak.mitigation);
  assert.ok(strong.critChance > weak.critChance);
});

test('classless imported profiles fall back to the starter signature on their own stats', () => {
  const classless = getCombatKit(profileFrom('classless'));
  assert.equal(classless.class, null);
  assert.equal(classless.signature, 'bolt');
  assert.equal(classless.name, 'Wren');
  assert.equal(classless.manaCost, 15);
});
