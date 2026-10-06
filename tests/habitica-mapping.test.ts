import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_HEALTH,
  MAX_LEVEL,
  effectiveStatsFor,
  toHabiticaProfile,
  validateHabiticaProfile,
  InvalidHabiticaUserError,
} from '../src/lib/habitica/mapping.ts';
import { FIXTURES, FIXTURES_BY_KEY, gearLookupFor } from '../src/lib/habitica/fixtures.ts';
import type { HabiticaUserJson } from '../src/lib/habitica/types.ts';

test('every fixture maps to its hand-computed expected profile', () => {
  assert.ok(FIXTURES.length >= 5);
  for (const fixture of FIXTURES) {
    const profile = toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
    assert.equal(profile.class, fixture.expected.class, `${fixture.key} class`);
    assert.equal(profile.level, fixture.expected.level, `${fixture.key} level`);
    assert.equal(profile.hp, fixture.expected.hp, `${fixture.key} hp`);
    assert.equal(profile.maxHp, fixture.expected.maxHp, `${fixture.key} maxHp`);
    assert.equal(profile.mp, fixture.expected.mp, `${fixture.key} mp`);
    assert.equal(profile.maxMp, fixture.expected.maxMp, `${fixture.key} maxMp`);
    assert.deepEqual(profile.stats, fixture.expected.stats, `${fixture.key} stats`);
  }
});

test('fixture profile carries id, name, gear keys, pets, mounts, appearance', () => {
  const fixture = FIXTURES_BY_KEY.lowLevel;
  const profile = toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
  assert.equal(profile.id, 'fixture-low-level-000000000000000001');
  assert.equal(profile.name, 'Tansy');
  assert.equal(profile.equipped.weapon, 'weapon_warrior_1');
  assert.deepEqual(profile.pets, ['Cactus-Base', 'Wolf-Base']);
  assert.deepEqual(profile.mounts, []);
  assert.equal(profile.appearance.size, 'slim');
  assert.equal(profile.appearance.hairColor, 'brown');
  assert.equal(profile.appearance.hairStyle, 1);
});

test('accepts id as _id or id', () => {
  const fixture = FIXTURES_BY_KEY.lowLevel;
  const user = structuredClone(fixture.user) as HabiticaUserJson & { _id?: string };
  delete user._id;
  user.id = 'alt-id-shape';
  const profile = toHabiticaProfile(user, gearLookupFor(fixture.gearStats));
  assert.equal(profile.id, 'alt-id-shape');
});

test('level bonus is capped at MAX_LEVEL', () => {
  assert.equal(MAX_LEVEL, 100);
  const base = { str: 0, int: 0, con: 0, per: 0 };
  const buffs = { str: 0, int: 0, con: 0, per: 0 };
  const atCap = effectiveStatsFor(base, buffs, 150, {}, null);
  const at100 = effectiveStatsFor(base, buffs, 100, {}, null);
  assert.deepEqual(atCap, at100);
  assert.equal(atCap.str, 50);
});

test('class gear counts twice, non-matching gear once, unknown gear zero', () => {
  const stats = effectiveStatsFor(
    { str: 1, int: 0, con: 0, per: 0 },
    { str: 0, int: 0, con: 0, per: 0 },
    1, // level bonus 0
    { weapon: 'axe', shield: 'buckler', hat: 'mystery' },
    'warrior',
    (key) =>
      ({
        axe: { str: 3, klass: 'warrior' },
        buckler: { str: 3, klass: 'rogue' },
      })[key],
  );
  // base 1 + gear (3+3) + class 3 = 10; mystery contributes 0
  assert.equal(stats.str, 10);
});

test('specialClass matches like klass in the class bonus', () => {
  const stats = effectiveStatsFor(
    { str: 0, int: 0, con: 0, per: 0 },
    { str: 0, int: 0, con: 0, per: 0 },
    0,
    { armor: 'special' },
    'warrior',
    () => ({ con: 8, specialClass: 'warrior' }),
  );
  assert.equal(stats.con, 16);
});

test("Habitica's wizard class imports as the internal mage with the wizard-gear bonus", () => {
  // Real Habitica payloads spell the mage class `wizard` and label wizard
  // gear `klass: 'wizard'` (content/habitica-gear.json). The highLevel
  // fixture carries those real values and must import as a mage WITH the
  // class bonus from its wizard gear.
  const fixture = FIXTURES_BY_KEY.highLevel;
  assert.equal((fixture.user.stats as { class?: string }).class, 'wizard');
  const profile = toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
  assert.equal(profile.class, 'mage');
  assert.deepEqual(profile.stats, fixture.expected.stats);
});

test('the raw mage spelling keeps importing as mage', () => {
  const fixture = structuredClone(FIXTURES_BY_KEY.highLevel) as typeof FIXTURES_BY_KEY.highLevel;
  (fixture.user.stats as { class?: string }).class = 'mage';
  for (const table of Object.values(fixture.gearStats)) {
    if (table.klass === 'wizard') table.klass = 'mage';
  }
  const profile = toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
  assert.equal(profile.class, 'mage');
  assert.deepEqual(profile.stats, fixture.expected.stats);
});

test('gear klass wizard matches the internal mage class in the bonus', () => {
  const stats = effectiveStatsFor(
    { str: 0, int: 0, con: 0, per: 0 },
    { str: 0, int: 0, con: 0, per: 0 },
    0,
    { weapon: 'weapon_wizard_1' },
    'mage',
    (key) => (key === 'weapon_wizard_1' ? { int: 6, klass: 'wizard' } : undefined),
  );
  // gear 6 + class bonus 6
  assert.equal(stats.int, 12);
});

test('specialClass wizard matches the internal mage class too', () => {
  const stats = effectiveStatsFor(
    { str: 0, int: 0, con: 0, per: 0 },
    { str: 0, int: 0, con: 0, per: 0 },
    0,
    { shield: 'shield_special_summer2019Mage' },
    'mage',
    () => ({ per: 7, klass: 'special', specialClass: 'wizard' }),
  );
  assert.equal(stats.per, 14);
});

test('wizard gear never matches a non-mage class', () => {
  const stats = effectiveStatsFor(
    { str: 0, int: 0, con: 0, per: 0 },
    { str: 0, int: 0, con: 0, per: 0 },
    0,
    { weapon: 'weapon_wizard_1' },
    'warrior',
    (key) => (key === 'weapon_wizard_1' ? { int: 6, klass: 'wizard' } : undefined),
  );
  assert.equal(stats.int, 6);
});

test('toHabiticaProfile rejects malformed payloads with field paths', () => {
  assert.throws(() => toHabiticaProfile(null), InvalidHabiticaUserError);
  assert.throws(() => toHabiticaProfile({}), (err: unknown) => {
    assert.ok(err instanceof InvalidHabiticaUserError);
    assert.equal(err.path, 'stats');
    return true;
  });
  const fixture = FIXTURES_BY_KEY.lowLevel;
  const noName = structuredClone(fixture.user) as HabiticaUserJson;
  (noName as { profile?: unknown }).profile = {};
  assert.throws(() => toHabiticaProfile(noName), /profile\.name/);
  const badClass = structuredClone(fixture.user) as HabiticaUserJson;
  (badClass.stats as { class?: string }).class = 'bard';
  assert.throws(() => toHabiticaProfile(badClass), /stats\.class/);
  const noId = structuredClone(fixture.user) as HabiticaUserJson;
  delete noId._id;
  assert.throws(() => toHabiticaProfile(noId), /_id or id/);
});

test('validateHabiticaProfile strips foreign fields (credentials cannot ride along)', () => {
  const fixture = FIXTURES_BY_KEY.variedEquipment;
  const profile = toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
  const dirty = {
    ...profile,
    apiToken: 'habitica-token-should-never-survive',
    credentials: { userId: 'x', apiToken: 'y' },
    equipped: { ...profile.equipped, weapon: 'weapon_warrior_2', extraSlot: 12345 },
    appearance: { ...profile.appearance, sessionToken: 'leak' },
  };
  const clean = validateHabiticaProfile(dirty);
  const json = JSON.stringify(clean);
  assert.ok(!json.includes('habitica-token-should-never-survive'));
  assert.ok(!json.includes('sessionToken'));
  assert.ok(!('apiToken' in clean));
  assert.ok(!('credentials' in clean));
  assert.ok(!('extraSlot' in clean.equipped));
  assert.equal(clean.equipped.weapon, 'weapon_warrior_2');
  assert.deepEqual(clean.stats, fixture.expected.stats);
});

test('validateHabiticaProfile rejects malformed profiles', () => {
  assert.throws(() => validateHabiticaProfile(null), InvalidHabiticaUserError);
  assert.throws(() => validateHabiticaProfile({ id: '' }), /id/);
  assert.throws(() => validateHabiticaProfile({ id: 'x', name: 'y', class: 'bard' }), /class/);
  assert.throws(
    () => validateHabiticaProfile({ id: 'x', name: 'y', class: null, level: 0 }),
    /level/,
  );
});

test('mapping output contains no credential-shaped fields', () => {
  for (const fixture of FIXTURES) {
    const profile = toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
    const json = JSON.stringify(profile).toLowerCase();
    assert.ok(!json.includes('token'));
    assert.ok(!json.includes('apikey'));
    assert.ok(!json.includes('x-api'));
  }
});

test('projected payloads without stats.maxHealth map to the shared maxHealth constant (F1 regression)', () => {
  const fixture = FIXTURES_BY_KEY.lowLevel;
  const user = structuredClone(fixture.user) as HabiticaUserJson;
  assert.equal((user.stats as Record<string, unknown>).maxHealth, undefined);
  const profile = toHabiticaProfile(user, gearLookupFor(fixture.gearStats));
  assert.equal(profile.maxHp, MAX_HEALTH);
  assert.equal(profile.maxHp, 50);
});

test('a legacy payload carrying stats.maxHealth still honors it', () => {
  const fixture = FIXTURES_BY_KEY.lowLevel;
  const user = structuredClone(fixture.user) as HabiticaUserJson;
  (user.stats as Record<string, unknown>).maxHealth = 60;
  const profile = toHabiticaProfile(user, gearLookupFor(fixture.gearStats));
  assert.equal(profile.maxHp, 60);
});

test('class bonus is applied exactly once per matching item', () => {
  // klass and specialClass both match — the bonus must still be one add.
  const stats = effectiveStatsFor(
    { str: 0, int: 0, con: 0, per: 0 },
    { str: 0, int: 0, con: 0, per: 0 },
    0,
    { weapon: 'oddity' },
    'warrior',
    () => ({ str: 5, klass: 'warrior', specialClass: 'warrior' }),
  );
  // gear once (5) + class bonus once (5) = 10, not 15
  assert.equal(stats.str, 10);
});

test('costume never contributes to stats; selected companions and costume map through', () => {
  const fixture = FIXTURES_BY_KEY.variedEquipment;
  const profile = toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
  // stats match the costume-free expectation
  assert.deepEqual(profile.stats, fixture.expected.stats);
  // costume is carried for visuals only
  const nonNullCostume = Object.entries(profile.costume ?? {})
    .filter(([, v]) => v !== null)
    .map(([k]) => k)
    .sort();
  assert.deepEqual(nonNullCostume, fixture.expected.costumeSlots);
  assert.equal(profile.useCostume, fixture.expected.useCostume);
  assert.equal(profile.selectedPet, fixture.expected.selectedPet);
  assert.equal(profile.selectedMount, fixture.expected.selectedMount);
});

test('selected companions default to null when items.currentPet/currentMount are empty', () => {
  const profile = toHabiticaProfile(
    FIXTURES_BY_KEY.lowLevel.user,
    gearLookupFor(FIXTURES_BY_KEY.lowLevel.gearStats),
  );
  assert.equal(profile.selectedPet, null);
  assert.equal(profile.selectedMount, null);
  assert.equal(profile.useCostume, false);
});

test('optional hair slots map from preferences.hair', () => {
  const fixture = FIXTURES_BY_KEY.lowLevel;
  const user = structuredClone(fixture.user) as HabiticaUserJson;
  (user.preferences as Record<string, unknown>).hair = {
    color: 'black',
    base: 2,
    bangs: 3,
    mustache: 1,
    beard: 4,
    flower: 5,
  };
  const profile = toHabiticaProfile(user, gearLookupFor(fixture.gearStats));
  assert.equal(profile.appearance.hairColor, 'black');
  assert.equal(profile.appearance.hairStyle, 2);
  assert.equal(profile.appearance.hairBangs, 3);
  assert.equal(profile.appearance.hairMustache, 1);
  assert.equal(profile.appearance.hairBeard, 4);
  assert.equal(profile.appearance.hairFlower, 5);
});

test('legacy profiles without M3 fields validate with defaults (backward compatible)', () => {
  const fixture = FIXTURES_BY_KEY.lowLevel;
  const profile = toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
  const legacy = {
    id: profile.id,
    name: profile.name,
    class: profile.class,
    level: profile.level,
    hp: profile.hp,
    maxHp: profile.maxHp,
    mp: profile.mp,
    maxMp: profile.maxMp,
    stats: profile.stats,
    equipped: profile.equipped,
    pets: profile.pets,
    mounts: profile.mounts,
    appearance: {
      size: 'slim',
      shirt: 'blue',
      skin: 'normal',
      hairColor: 'brown',
      hairStyle: 1,
      background: 'intro',
    },
  };
  const clean = validateHabiticaProfile(legacy);
  assert.deepEqual(clean.costume, {});
  assert.equal(clean.useCostume, false);
  assert.equal(clean.selectedPet, null);
  assert.equal(clean.selectedMount, null);
  assert.equal(clean.appearance.hairBangs, 0);
  assert.equal(clean.appearance.hairFlower, 0);
});

test('validateHabiticaProfile strips credential-shaped keys from costume', () => {
  const fixture = FIXTURES_BY_KEY.variedEquipment;
  const profile = toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
  const dirty = {
    ...profile,
    costume: { ...profile.costume, apiToken: 'costume-leak' },
    selectedPet: 'Wolf-Base',
  };
  const clean = validateHabiticaProfile(dirty);
  assert.ok(!JSON.stringify(clean).includes('costume-leak'));
  assert.ok(!('apiToken' in (clean.costume ?? {})));
  assert.equal(clean.selectedPet, 'Wolf-Base');
});

test('the party id maps from party._id, survives a stored round trip, and is absent without one', () => {
  const fixture = FIXTURES_BY_KEY.lowLevel;
  const user = structuredClone(fixture.user) as HabiticaUserJson;
  (user as Record<string, unknown>).party = { _id: 'party-123' };
  const profile = toHabiticaProfile(user, gearLookupFor(fixture.gearStats));
  assert.equal(profile.partyId, 'party-123');
  assert.equal(validateHabiticaProfile(JSON.parse(JSON.stringify(profile))).partyId, 'party-123');
  for (const party of [undefined, null, { _id: null }, { _id: '' }, { _id: 7 }, { _id: 'x'.repeat(129) }]) {
    const u = structuredClone(fixture.user) as HabiticaUserJson;
    (u as Record<string, unknown>).party = party;
    assert.equal('partyId' in toHabiticaProfile(u, gearLookupFor(fixture.gearStats)), false, JSON.stringify(party));
  }
});
