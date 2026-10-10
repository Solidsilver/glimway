import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CHARM_ITEM,
  GLIM_COSTS,
  GlimSpendError,
  WELCOME_GLIMS,
  checkSpend,
  glimsBetween,
  grantWelcome,
  lifetimeXp,
  spendGlims,
  xpToNextLevel,
} from '../src/lib/glims.ts';
import { syncProfile, type SyncedSave } from '../src/lib/habitica/sync.ts';
import { toHabiticaProfile, validateHabiticaProfile } from '../src/lib/habitica/mapping.ts';
import { FIXTURES_BY_KEY, gearLookupFor } from '../src/lib/habitica/fixtures.ts';
import { createNewGame, validateSave } from '../src/lib/state.ts';
import type { HabiticaProfile } from '../src/lib/habitica/types.ts';

function profileFrom(key: keyof typeof FIXTURES_BY_KEY): HabiticaProfile {
  const fixture = FIXTURES_BY_KEY[key];
  return toHabiticaProfile(fixture.user, gearLookupFor(fixture.gearStats));
}

function importedSave(profile: HabiticaProfile, glims = 0): SyncedSave {
  const state = { ...createNewGame(), glims, hp: profile.hp, maxHp: profile.maxHp, mana: profile.mp, maxMana: profile.maxMp };
  return { state, vitalsSource: 'imported', importedProfile: profile };
}

test('the level curve matches Habitica at known points', () => {
  // statHelpers.toNextLevel: 25·L below 5, 150 at 5, then the quadratic.
  assert.equal(xpToNextLevel(1), 25);
  assert.equal(xpToNextLevel(4), 100);
  assert.equal(xpToNextLevel(5), 150);
  assert.equal(xpToNextLevel(6), 210);
  assert.equal(xpToNextLevel(10), 260);
  assert.equal(lifetimeXp(1, 40), 40);
  assert.equal(lifetimeXp(3, 5), 25 + 50 + 5);
});

test('glims come from XP gained, carry remainders, and survive level-ups', () => {
  assert.deepEqual(glimsBetween({ level: 5, exp: 20 }, { level: 5, exp: 62 }), { xp: 42, glims: 4 });
  // 8 + 8 XP: neither crosses a 10 alone, together they do — no XP is lost.
  const a = glimsBetween({ level: 5, exp: 0 }, { level: 5, exp: 8 });
  const b = glimsBetween({ level: 5, exp: 8 }, { level: 5, exp: 16 });
  assert.equal(a.glims + b.glims, 1);
  // Level-up: the rest of level 5 plus 30 into level 6.
  const toNext = xpToNextLevel(5);
  assert.deepEqual(glimsBetween({ level: 5, exp: toNext - 20 }, { level: 6, exp: 30 }), { xp: 50, glims: 5 });
});

test('losing XP or missing XP data never grants or removes glims', () => {
  assert.deepEqual(glimsBetween({ level: 6, exp: 10 }, { level: 5, exp: 100 }), { xp: 0, glims: 0 });
  assert.deepEqual(glimsBetween({ level: 6 }, { level: 6, exp: 100 }), { xp: 0, glims: 0 });
});

test('profiles carry exp from Habitica, and older saved profiles still validate', () => {
  const p = profileFrom('lowLevel');
  assert.equal(typeof p.exp, 'number');
  const { exp: _drop, ...legacy } = p;
  assert.equal(validateHabiticaProfile(legacy).exp, undefined);
  assert.equal(validateHabiticaProfile(p).exp, p.exp);
});

test('first import pays the welcome gift once, not past XP', () => {
  const profile = profileFrom('lowLevel');
  const demo: SyncedSave = { state: createNewGame(), vitalsSource: 'demo' };
  const first = syncProfile(demo, profile);
  assert.equal(first.status, 'imported');
  assert.equal(first.save.state.glims, WELCOME_GLIMS);
  assert.deepEqual(first.glims, { xp: 0, gained: WELCOME_GLIMS, welcome: WELCOME_GLIMS });

  // Disconnect (back to demo) and reconnect: the flag keeps the gift single.
  const again = syncProfile({ state: first.save.state, vitalsSource: 'demo' }, profile);
  assert.equal(again.save.state.glims, WELCOME_GLIMS);
  assert.equal(again.glims?.welcome, 0);
});

test('a sync credits XP since the baseline exactly once', () => {
  const before = profileFrom('lowLevel');
  const after: HabiticaProfile = { ...before, exp: (before.exp ?? 0) + 42 };
  const first = syncProfile(importedSave(before, 1), after);
  assert.equal(first.status, 'synced');
  assert.equal(first.glims?.xp, 42);
  const gained = first.glims?.gained ?? 0;
  assert.ok(gained === 4 || gained === 5, 'floor of lifetime XP / 10 either side');
  assert.equal(first.save.state.glims, 1 + gained);

  // Same profile again: nothing new to credit.
  const second = syncProfile(first.save, after);
  assert.equal(second.status, 'unchanged');
  assert.equal(second.save.state.glims, 1 + gained);
});

test('syncs outside the village credit nothing and keep the baseline', () => {
  const before = profileFrom('lowLevel');
  const after: HabiticaProfile = { ...before, exp: (before.exp ?? 0) + 100 };
  const save = importedSave(before);
  const away = syncProfile({ ...save, state: { ...save.state, area: 'woodland' } }, after);
  assert.equal(away.status, 'rejected');
  assert.equal(away.save.state.glims, 0);
  assert.equal(away.save.importedProfile, before);
});

test('grantWelcome is idempotent', () => {
  const once = grantWelcome(createNewGame());
  const twice = grantWelcome(once.state);
  assert.equal(twice.granted, 0);
  assert.equal(twice.state.glims, WELCOME_GLIMS);
});

test('a warm rest restores vitals and costs glims', () => {
  const tired = { ...createNewGame(), hp: 3, mana: 1, glims: 5 };
  const rested = spendGlims(tired, { kind: 'rest' });
  assert.equal(rested.hp, rested.maxHp);
  assert.equal(rested.mana, rested.maxMana);
  assert.equal(rested.glims, 5 - GLIM_COSTS.rest);
  assert.deepEqual(checkSpend(rested, { kind: 'rest' }), { ok: false, cost: GLIM_COSTS.rest, reason: 'full' });
});

test('road lanterns light once each', () => {
  const s = { ...createNewGame(), glims: 10 };
  const lit = spendGlims(s, { kind: 'road-lantern', id: 'road-2' });
  assert.equal(lit.glims, 10 - GLIM_COSTS.roadLantern);
  assert.ok(lit.flags.includes('lit:road-2'));
  assert.equal(checkSpend(lit, { kind: 'road-lantern', id: 'road-2' }).ok, false);
  assert.equal(checkSpend(lit, { kind: 'road-lantern', id: 'road-1' }).ok, true);
});

test('the chest gives the charm once', () => {
  const s = { ...createNewGame(), glims: GLIM_COSTS.chest };
  const opened = spendGlims(s, { kind: 'chest' });
  assert.equal(opened.glims, 0);
  assert.ok(opened.inventory.includes(CHARM_ITEM));
  assert.throws(() => spendGlims({ ...opened, glims: 99 }, { kind: 'chest' }), GlimSpendError);
});

test('spending more than you have is refused and changes nothing', () => {
  const s = validateSave({ ...createNewGame(), hp: 1, glims: 1 });
  assert.deepEqual(checkSpend(s, { kind: 'rest' }), { ok: false, cost: GLIM_COSTS.rest, reason: 'short' });
  assert.throws(() => spendGlims(s, { kind: 'rest' }), (e: unknown) => e instanceof GlimSpendError && e.reason === 'short');
  assert.equal(s.glims, 1);
});

test('glim-spot conversations offer the spend only when it can go through', async () => {
  const { glimDialogue } = await import('../src/content/world.ts');
  const poor = { ...createNewGame(), hp: 5, glims: 1 };
  const hearth = glimDialogue('hearth', poor, { connected: false });
  const rest = hearth.choices?.find((c) => c.text.startsWith('Rest'));
  assert.equal(rest?.disabled, true);
  assert.match(rest?.note ?? '', /Needs 2 glims/);
  assert.ok(hearth.lines.some((l) => /connect Habitica/.test(l)), 'explains where glims come from');

  const rich = { ...poor, glims: 9 };
  const ok = glimDialogue('hearth', rich, { connected: true }).choices?.find((c) => c.text.startsWith('Rest'));
  assert.equal(ok?.disabled, undefined);
  assert.equal(ok?.action, 'rest');

  const road = glimDialogue('road-2', rich, { connected: true });
  assert.equal(road.choices?.[0].action, 'light:road-2');
  const lit = spendGlims(rich, { kind: 'road-lantern', id: 'road-2' });
  assert.equal(glimDialogue('road-2', lit, { connected: true }).choices, undefined);

  const opened = spendGlims(rich, { kind: 'chest' });
  assert.equal(glimDialogue('chest', opened, { connected: true }).choices, undefined);
});

test('losing XP and earning it back never pays twice (no farming)', () => {
  const base = profileFrom('lowLevel');
  const exp0 = base.exp ?? 0;
  let save = importedSave(base);
  const gainedAt = (exp: number) => {
    const r = syncProfile(save, { ...base, exp });
    save = r.save;
    return r.glims?.gained ?? 0;
  };
  // Check a 20 XP to-do, uncheck it, re-check it — five times over.
  let total = 0;
  for (let i = 0; i < 5; i++) {
    total += gainedAt(exp0 + 20);
    total += gainedAt(exp0);
  }
  assert.equal(total, 2, 'only the first 20 XP pays');
  assert.equal(save.state.glims, 2);
  // Genuinely new XP above the high-water mark still pays.
  assert.equal(gainedAt(exp0 + 40), 2);
});

test('first import sets the XP mark so later syncs pay only new XP', () => {
  const profile = profileFrom('lowLevel');
  const first = syncProfile({ state: createNewGame(), vitalsSource: 'demo' }, profile);
  assert.equal(first.save.state.glimXp, lifetimeXp(profile.level, profile.exp ?? 0));
  const next = syncProfile(first.save, { ...profile, exp: (profile.exp ?? 0) + 30 });
  assert.equal(next.glims?.xp, 30);
});

test('saves from before the XP mark fall back to the saved profile baseline', () => {
  const before = profileFrom('lowLevel');
  const save = importedSave(before); // glimXp 0 = unknown
  const r = syncProfile(save, { ...before, exp: (before.exp ?? 0) + 20 });
  assert.equal(r.glims?.xp, 20);
  assert.ok(r.save.state.glimXp > 0);
});

test('a 0-HP imported hero can only be revived with glims earned on Habitica', () => {
  // 3 gifted glims (welcome) — enough for a rest, but not a revive.
  const down = { ...createNewGame(), hp: 0, glims: 3, xpGlims: 0 };
  assert.deepEqual(checkSpend(down, { kind: 'rest' }, { imported: true }), { ok: false, cost: GLIM_COSTS.rest, reason: 'needs-earned' });
  // Demo heroes (or imported heroes above 0 HP) may rest with any glims.
  assert.equal(checkSpend(down, { kind: 'rest' }).ok, true);
  assert.equal(checkSpend({ ...down, hp: 1 }, { kind: 'rest' }, { imported: true }).ok, true);
  // With XP-earned glims the revive goes through, paid from those.
  const earned = { ...down, glims: 5, xpGlims: 2 };
  const revived = spendGlims(earned, { kind: 'rest' }, { imported: true });
  assert.equal(revived.hp, revived.maxHp);
  assert.equal(revived.glims, 3);
  assert.equal(revived.xpGlims, 0);
});

test('ordinary spends use gifted glims first, keeping earned ones', () => {
  const s = { ...createNewGame(), glims: 5, xpGlims: 3 };
  const lit = spendGlims(s, { kind: 'road-lantern', id: 'road-1' });
  assert.equal(lit.glims, 2);
  assert.equal(lit.xpGlims, 2, '2 gifted spent, then 1 earned');
});

test('XP synced from Habitica counts as earned glims; the welcome gift does not', () => {
  const profile = profileFrom('lowLevel');
  const first = syncProfile({ state: createNewGame(), vitalsSource: 'demo' }, profile);
  assert.equal(first.save.state.xpGlims, 0);
  const next = syncProfile(first.save, { ...profile, exp: (profile.exp ?? 0) + 20 });
  assert.equal(next.save.state.xpGlims, 2);
  assert.equal(next.save.state.glims, WELCOME_GLIMS + 2);
});

test('the hearth tells a downed imported hero it needs earned glims', async () => {
  const { glimDialogue } = await import('../src/content/world.ts');
  const down = { ...createNewGame(), hp: 0, glims: 3, xpGlims: 0 };
  const rest = glimDialogue('hearth', down, { connected: true }).choices?.find((c) => c.text.startsWith('Rest'));
  assert.equal(rest?.disabled, true);
  assert.match(rest?.note ?? '', /earned on Habitica/);
});
