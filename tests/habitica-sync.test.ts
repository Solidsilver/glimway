import test from 'node:test';
import assert from 'node:assert/strict';
import {
  IMPORTED_RECOVERY,
  SyncRejectedError,
  applyImportedProfile,
  isSafeBoundary,
  passiveRegenAllowed,
  resolveDefeatRecovery,
  syncProfile,
  vitalsSourceLabel,
} from '../src/lib/habitica/sync.ts';
import { toHabiticaProfile } from '../src/lib/habitica/mapping.ts';
import { FIXTURES_BY_KEY, gearLookupFor } from '../src/lib/habitica/fixtures.ts';
import { advanceQuest, createNewGame } from '../src/lib/state.ts';
import type { SyncedSave } from '../src/lib/habitica/sync.ts';
import type { HabiticaProfile } from '../src/lib/habitica/types.ts';

function profileFrom(key: keyof typeof FIXTURES_BY_KEY): HabiticaProfile {
  const fixture = FIXTURES_BY_KEY[key];
  return toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
}

function storyState() {
  return advanceQuest(advanceQuest(createNewGame(), 'accept'), 'find-clue');
}

test('applyImportedProfile: first import replaces demo vitals at the village', () => {
  const base = advanceQuest(createNewGame(), 'accept');
  const profile = profileFrom('lowHp');
  const result = applyImportedProfile(base, profile);

  assert.equal(result.vitalsSource, 'imported');
  assert.equal(result.state.hp, 3.2);
  assert.equal(result.state.maxHp, 50);
  assert.equal(result.state.mana, 22);
  assert.equal(result.state.maxMana, profile.maxMp);
  assert.equal(result.state.quest, 'accepted');
  assert.deepEqual(result.state.inventory, base.inventory);
  assert.deepEqual(result.importedProfile, profile);
});

test('applyImportedProfile clamps imported vitals into their maxima', () => {
  const profile: HabiticaProfile = { ...profileFrom('lowLevel'), hp: 999, mp: 999 };
  const result = applyImportedProfile(createNewGame(), profile);
  assert.equal(result.state.hp, profile.maxHp);
  assert.equal(result.state.mana, profile.maxMp);
});

test('applyImportedProfile outside the village rejects and leaves the save untouched', () => {
  const inRuin = { ...storyState(), area: 'ruin' as const, hp: 12 };
  const snapshot = structuredClone(inRuin);
  assert.throws(
    () => applyImportedProfile(inRuin, profileFrom('lowLevel')),
    (err: unknown) => {
      assert.ok(err instanceof SyncRejectedError);
      assert.equal(err.reason, 'not-at-safe-boundary');
      return true;
    },
  );
  assert.deepEqual(inRuin, snapshot);
});

test('syncProfile: first import at the village reports imported', () => {
  const result = syncProfile(
    { state: createNewGame(), vitalsSource: 'demo' },
    profileFrom('lowLevel'),
  );
  assert.equal(result.status, 'imported');
  assert.equal(result.save.vitalsSource, 'imported');
  assert.equal(result.save.importedProfile?.id, profileFrom('lowLevel').id);
});

test('syncProfile outside the safe boundary rejects the ENTIRE save unchanged', () => {
  const profile = profileFrom('lowHp');
  const imported = applyImportedProfile(createNewGame(), profile);
  const onTrail: SyncedSave = {
    state: { ...imported.state, area: 'ruin' as const, hp: 3.2, mana: 22 },
    vitalsSource: imported.vitalsSource,
    importedProfile: imported.importedProfile,
  };
  const snapshot = structuredClone(onTrail);
  const healed: HabiticaProfile = { ...profile, hp: 40 };

  const result = syncProfile(onTrail, healed);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'not-at-safe-boundary');
  assert.deepEqual(result.save, snapshot, 'baseline must not be consumed on rejection');
});

test('syncProfile credits external healing exactly once', () => {
  const profile = profileFrom('lowHp'); // hp 3.2, maxMp 70, mp 22
  let save = applyImportedProfile({ ...createNewGame(), hp: 3, mana: 10 }, profile);
  const healed: HabiticaProfile = { ...profile, hp: 13.2, mp: 32 };

  const first = syncProfile(save, healed);
  assert.equal(first.status, 'synced');
  // local hp 3.2 + delta (13.2 - 3.2) = 13.2
  assert.equal(first.save.state.hp, 13.2);
  // local mana 22 (import replaced demo mana) + delta (32 - 22) = 32
  assert.equal(first.save.state.mana, 32);
  save = first.save;

  // Same profile again: delta is zero — never refills.
  const second = syncProfile(save, healed);
  assert.equal(second.status, 'unchanged');
  assert.deepEqual(second.save, save);
  assert.equal(second.save.state.hp, 13.2);
});

test('syncProfile after combat damage never refills from an unchanged profile', () => {
  const profile = profileFrom('lowLevel');
  let save = applyImportedProfile(createNewGame(), profile);
  // combat happened: hp 41 -> 5
  save = { ...save, state: { ...save.state, hp: 5 } };
  const result = syncProfile(save, profile);
  assert.equal(result.status, 'unchanged');
  assert.equal(result.save.state.hp, 5);
});

test('syncProfile clamps down when external HP/MP fell', () => {
  const profile = profileFrom('lowLevel'); // hp 41, mp 30
  let save = applyImportedProfile(createNewGame(), profile);
  save = { ...save, state: { ...save.state, hp: 35, mana: 25 } };
  const dropped: HabiticaProfile = { ...profile, hp: 12, mp: 18 };

  const result = syncProfile(save, dropped);
  assert.equal(result.status, 'synced');
  assert.equal(result.save.state.hp, 12);
  assert.equal(result.save.state.mana, 18);
  assert.equal(result.save.importedProfile?.hp, 12);
});

test('syncProfile level-up raises maxima without refilling current vitals', () => {
  const profile = profileFrom('lowLevel'); // maxMp 36
  let save = applyImportedProfile(createNewGame(), profile);
  save = { ...save, state: { ...save.state, hp: 10, mana: 4 } };
  const leveled: HabiticaProfile = {
    ...profile,
    level: profile.level + 2,
    maxMp: profile.maxMp + 20,
    mp: profile.mp,
    hp: profile.hp,
  };

  const result = syncProfile(save, leveled);
  assert.equal(result.status, 'synced');
  assert.equal(result.save.state.maxMana, 56);
  assert.equal(result.save.state.mana, 4, 'level-up must not refill mana');
  assert.equal(result.save.state.hp, 10, 'level-up must not refill HP');
});

test('syncProfile rejects an account switch — a new journey is required', () => {
  const save = applyImportedProfile(createNewGame(), profileFrom('lowLevel'));
  const otherAccount = { ...profileFrom('highLevel'), id: 'a-different-account' };
  const snapshot = structuredClone(save);

  const result = syncProfile(save, otherAccount);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'account-switch');
  assert.deepEqual(result.save, snapshot);
});

test('syncProfile is idempotent across reloads (baseline travels with the save)', () => {
  const profile = profileFrom('lowHp');
  let save = applyImportedProfile(createNewGame(), profile);
  const reloaded: SyncedSave = structuredClone(save); // baseline survives reload

  const healed: HabiticaProfile = { ...profile, hp: 8.2 };
  const first = syncProfile(reloaded, healed);
  assert.equal(first.save.state.hp, 8.2);

  // reload again mid-campaign, sync with same profile: nothing refills
  const second = syncProfile(structuredClone(first.save), healed);
  assert.equal(second.status, 'unchanged');
  assert.equal(second.save.state.hp, 8.2);
});

test('capped delta still advances the baseline (no double credit after damage)', () => {
  const profile = profileFrom('lowLevel'); // hp 41, maxHp 50
  let save: SyncedSave = {
    state: { ...createNewGame(), hp: 50, maxHp: 50, mana: 20, maxMana: 36 },
    vitalsSource: 'imported',
    importedProfile: { ...profile, hp: 40 },
  };
  const fuller: HabiticaProfile = { ...profile, hp: 50 };

  const first = syncProfile(save, fuller);
  assert.equal(first.status, 'synced');
  assert.equal(first.save.state.hp, 50, 'positive delta caps at maxHp');
  assert.equal(first.save.importedProfile?.hp, 50, 'baseline must advance even when capped');
  save = first.save;

  // Damage, then an identical sync must NOT grant the +10 again.
  save = { ...save, state: { ...save.state, hp: 20 } };
  const second = syncProfile(save, fuller);
  assert.equal(second.status, 'unchanged');
  assert.equal(second.save.state.hp, 20);
});

test('appearance/stat/gear-only changes update the stored profile without moving vitals', () => {
  const profile = profileFrom('lowLevel');
  let save = applyImportedProfile(createNewGame(), profile);
  save = { ...save, state: { ...save.state, hp: 12 } };

  const renamed: HabiticaProfile = {
    ...profile,
    name: 'Renamed Hero',
    stats: { ...profile.stats, str: profile.stats.str + 5 },
    selectedPet: 'Cactus-Base',
    useCostume: true,
    costume: { ...profile.costume, head: 'head_special_1' },
  };
  const result = syncProfile(save, renamed);
  assert.equal(result.status, 'synced');
  assert.equal(result.save.state.hp, 12, 'vitals untouched');
  assert.equal(result.save.importedProfile?.name, 'Renamed Hero');
  assert.equal(result.save.importedProfile?.stats.str, profile.stats.str + 5);
  assert.equal(result.save.importedProfile?.selectedPet, 'Cactus-Base');
  assert.equal(result.save.importedProfile?.useCostume, true);
});

test('atSafeBoundary option can never permit a non-village sync', () => {
  const onTrail: SyncedSave = {
    state: { ...createNewGame(), area: 'woodland' },
    vitalsSource: 'demo',
  };
  const snapshot = structuredClone(onTrail);
  const result = syncProfile(onTrail, profileFrom('lowLevel'), { atSafeBoundary: true });
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'not-at-safe-boundary');
  assert.deepEqual(result.save, snapshot);
});

test('syncProfile without a stored baseline adopts one without crediting vitals', () => {
  const profile = profileFrom('lowLevel');
  const orphan: SyncedSave = {
    state: { ...createNewGame(), hp: 3 },
    vitalsSource: 'imported',
  };
  const result = syncProfile(orphan, profile);
  assert.equal(result.status, 'synced');
  assert.equal(result.save.state.hp, 3);
  assert.deepEqual(result.save.importedProfile, profile);
});

test('resolveDefeatRecovery: demo rule is full recovery in the village', () => {
  const hurt: SyncedSave = {
    state: { ...storyState(), area: 'ruin', position: { x: 12, y: 34 }, hp: 1, mana: 0 },
    vitalsSource: 'demo',
  };
  const result = resolveDefeatRecovery(hurt);
  assert.equal(result.vitalsSource, 'demo');
  assert.equal(result.state.area, 'village');
  assert.equal(result.state.hp, result.state.maxHp);
  assert.equal(result.state.mana, result.state.maxMana);
  assert.equal(result.state.quest, 'clue-found');
});

test('resolveDefeatRecovery: imported capped by last imported HP/MP', () => {
  const profile = profileFrom('lowLevel'); // hp 41, mp 30
  const imported = applyImportedProfile(createNewGame(), profile);
  const hurt: SyncedSave = {
    state: { ...imported.state, area: 'ruin', hp: 0, mana: 0 },
    vitalsSource: 'imported',
    importedProfile: profile,
  };

  const result = resolveDefeatRecovery(hurt);
  assert.equal(result.state.area, 'village');
  // min(last imported hp 41, ceil(50 * 0.25) = 13) = 13
  assert.equal(result.state.hp, Math.min(profile.hp, Math.ceil(50 * IMPORTED_RECOVERY.hpMaxFraction)));
  // min(last imported mp 30, ceil(36 * 0.5) = 18) = 18
  assert.equal(result.state.mana, Math.min(profile.mp, Math.ceil(profile.maxMp * IMPORTED_RECOVERY.manaMaxFraction)));
  // baseline preserved
  assert.deepEqual(result.importedProfile, profile);
});

test('resolveDefeatRecovery: low imported HP is the cap', () => {
  const profile = profileFrom('lowHp'); // hp 3.2
  const hurt: SyncedSave = {
    state: { ...createNewGame(), maxHp: 50, maxMana: 70, hp: 0, mana: 0 },
    vitalsSource: 'imported',
    importedProfile: profile,
  };
  const result = resolveDefeatRecovery(hurt);
  assert.equal(result.state.hp, 3.2, 'recovery cannot exceed the last imported HP');
});

test('resolveDefeatRecovery: zero imported HP stays zero', () => {
  const profile: HabiticaProfile = { ...profileFrom('lowLevel'), hp: 0, mp: 0 };
  const hurt: SyncedSave = {
    state: { ...createNewGame(), hp: 0, mana: 0, maxHp: 2, maxMana: 10 },
    vitalsSource: 'imported',
    importedProfile: profile,
  };
  const result = resolveDefeatRecovery(hurt);
  assert.equal(result.state.hp, 0);
  assert.equal(result.state.mana, 0);
});

test('approved health policy: no passive HP regen for imported vitals', () => {
  assert.equal(passiveRegenAllowed('demo'), true);
  assert.equal(passiveRegenAllowed('imported'), false);
  assert.equal(isSafeBoundary(createNewGame()), true);
  assert.equal(isSafeBoundary({ ...createNewGame(), area: 'woodland' }), false);
});

test('provenance labels are stable', () => {
  assert.equal(vitalsSourceLabel('demo'), 'Demo adventurer');
  assert.equal(vitalsSourceLabel('imported'), 'Imported adventurer');
});

test('sync never mutates the input save', () => {
  const save = applyImportedProfile(createNewGame(), profileFrom('lowLevel'));
  const snapshot = structuredClone(save);
  syncProfile(save, { ...profileFrom('lowLevel'), hp: 45 });
  assert.deepEqual(save, snapshot);
});
