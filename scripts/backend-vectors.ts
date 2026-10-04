import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createNewGame, validateSave, type GameState } from '../src/lib/state.ts';
import { syncProfile, type SyncedSave } from '../src/lib/habitica/sync.ts';
import { creditXp, lifetimeXp, xpToNextLevel, checkSpend, spendEmbers, grantWelcome, type EmberSpend } from '../src/lib/embers.ts';
import { toHabiticaProfile, validateHabiticaProfile } from '../src/lib/habitica/mapping.ts';
import { FIXTURES_BY_KEY } from '../src/lib/habitica/fixtures.ts';
import { gearStatsFor } from '../src/lib/habitica/gear.ts';
import type { HabiticaProfile } from '../src/lib/habitica/types.ts';

export function vectors() {
  const base = validateHabiticaProfile(toHabiticaProfile(FIXTURES_BY_KEY.lowLevel.user, gearStatsFor));
  const xp = [];
  for (const level of [1, 2, 4, 5, 6, 10, 50, 99, 100, 101]) {
    for (const exp of [0, 0.4, 9.9, 10, xpToNextLevel(level) - 1]) {
      const total = lifetimeXp(level, exp);
      for (const mark of [undefined, 0, total, total + 5, Math.max(0, total - 10.4)]) {
        const result = creditXp(mark, { level, exp });
        xp.push({ level, exp, mark: mark ?? null, total, next: xpToNextLevel(level), result: { ...result, mark: result.mark ?? null } });
      }
    }
  }
  xp.push({ level: 2, mark: 10, total: null, next: xpToNextLevel(2), result: { ...creditXp(10, { level: 2 }), mark: 10 } });
  const sync = [];
  const saveOf = (state: GameState, imported = true, baseline: HabiticaProfile | undefined = base): SyncedSave => ({ state: validateSave(state), vitalsSource: imported ? 'imported' : 'demo', ...(baseline ? { importedProfile: baseline } : {}) });
  for (const area of ['village', 'woodland', 'ruin'] as const) {
    for (const hp of [0, 4.5, base.hp, base.maxHp]) {
      for (const mode of ['same', 'heal', 'fall', 'max-up', 'cosmetic', 'account', 'no-exp', 'no-baseline', 'first', 'restricted']) {
        const state = { ...createNewGame(), area, hp, maxHp: base.maxHp, mana: 2, maxMana: base.maxMp, emberXp: lifetimeXp(base.level, base.exp ?? 0) };
        let profile = { ...base };
        if (mode === 'heal') profile = { ...base, hp: base.hp + 5, mp: base.mp + 7, exp: (base.exp ?? 0) + 22.6 };
        if (mode === 'fall') profile = { ...base, hp: 0, mp: 0, exp: 0 };
        if (mode === 'max-up') profile = { ...base, maxHp: base.maxHp + 10, maxMp: base.maxMp + 20 };
        if (mode === 'cosmetic') profile = { ...base, name: 'Changed', appearance: { ...base.appearance, shirt: 'changed' } };
        if (mode === 'account') profile = { ...base, id: 'other-account' };
        if (mode === 'no-exp') delete profile.exp;
        const input = saveOf(state, mode !== 'first', mode === 'no-baseline' ? undefined : base);
        if (mode === 'no-baseline') delete input.importedProfile;
        profile = validateHabiticaProfile(profile);
        const atSafe = mode !== 'restricted';
        const result = syncProfile(input, profile, { atSafeBoundary: atSafe });
        sync.push({ input, profile, atSafe, result: { status: result.status, ...(result.reason ? { reason: result.reason } : {}), save: result.save } });
      }
    }
  }
  // Sequential cases exercise the once-only baseline and monotone XP mark.
  let sequential = saveOf({ ...createNewGame(), hp: 10, maxHp: base.maxHp, maxMana: base.maxMp });
  for (const delta of [5, 5, -5, 5, 10, 10]) {
    const p = validateHabiticaProfile({ ...base, hp: base.hp + delta, exp: (base.exp ?? 0) + delta * 10 });
    const result = syncProfile(sequential, p);
    sync.push({ input: sequential, profile: p, atSafe: true, result: { status: result.status, ...(result.reason ? { reason: result.reason } : {}), save: result.save } });
    sequential = { ...result.save, state: { ...result.save.state, hp: 0 } };
  }
  const spend = [];
  const spends: EmberSpend[] = [{ kind: 'rest' }, { kind: 'road-lantern', id: 'road-1' }, { kind: 'road-lantern', id: 'road-3' }, { kind: 'chest' }];
  for (const hp of [0, 1, 40]) for (const mana of [0, 20]) for (const embers of [0, 2, 5, 10]) for (const earned of [0, 2, embers]) for (const imported of [false, true]) for (const done of [false, true]) for (const operation of spends) {
    const state = validateSave({ ...createNewGame(), hp, mana, embers, xpEmbers: earned, flags: done ? ['lit:road-1', 'opened:ashwatch-chest'] : [] });
    const check = checkSpend(state, operation, { imported });
    spend.push({ state, operation, imported, check, ...(check.ok ? { result: spendEmbers(state, operation, { imported }) } : {}) });
  }
  const welcome = [createNewGame(), { ...createNewGame(), embers: 10, xpEmbers: 5 }, { ...createNewGame(), flags: ['embers:welcome'], embers: 7 }].map(state => ({ state, result: grantWelcome(state) }));
  const mapping = Object.values(FIXTURES_BY_KEY).map(f => ({ payload: { success: true, data: f.user }, result: validateHabiticaProfile(toHabiticaProfile(f.user, gearStatsFor)) }));
  return { xp, sync, spend, welcome, mapping };
}
export const serializeVectors = () => JSON.stringify(vectors(), null, 2) + '\n';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  writeFileSync(new URL('../content/vectors/backend.json', import.meta.url), serializeVectors());
  console.log('Wrote content/vectors/backend.json');
}
