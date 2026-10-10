import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ECONOMY as e } from '../src/lib/economy.ts';
import { serializeVectors } from '../scripts/backend-vectors.ts';

test('shared economy has the complete typed shape and valid values', () => {
  assert.deepEqual(Object.keys(e).filter((k) => k !== '$typeName').sort(), ['xpPerGlim', 'welcomeGlims', 'costs', 'roadLanterns', 'chestId', 'charmItem', 'syncCreditCap', 'migrationGiftCap', 'checkpointToleranceXp', 'outstandingInvites', 'syncCreditDailyGrowth', 'syncCreditMax', 'pendingCreditDays', 'lifetimeInvites', 'wildsLimits'].sort());
  for (const n of [e.syncCreditDailyGrowth, e.syncCreditMax, e.pendingCreditDays, e.lifetimeInvites, e.outstandingInvites, e.xpPerGlim, e.welcomeGlims, e.syncCreditCap, e.migrationGiftCap, e.checkpointToleranceXp, ...Object.values(e.costs).filter((v) => typeof v === 'number')]) {
    assert.ok(Number.isSafeInteger(n) && n >= 0);
  }
  assert.ok(e.xpPerGlim > 0 && e.syncCreditCap > 0);
  assert.ok(e.syncCreditMax >= e.syncCreditCap && e.lifetimeInvites >= e.outstandingInvites && e.pendingCreditDays > 0);
  assert.deepEqual(Object.keys(e.costs).filter((k) => k !== '$typeName').sort(), ['chest', 'homeRest', 'rest', 'roadLantern']);
  assert.deepEqual(e.roadLanterns, ['road-1', 'road-2', 'road-3']);
  assert.equal(e.chestId, 'ashwatch-chest');
  assert.equal(e.wildsLimits.claimsPerMinute, 20);
  assert.equal(e.wildsLimits.lanternRelightsPerDay, 3);
  assert.equal(e.wildsLimits.lanternsCreatedPerDay, 2);
  assert.equal(e.wildsLimits.lanternReward.material, 'amber');
  assert.ok(e.costs.homeRest > 0 && e.costs.homeRest < e.costs.rest);
  assert.equal(e.charmItem, 'ember-charm');
});

test('committed Go parity vectors match the real TypeScript functions', () => {
  assert.equal(readFileSync(new URL('../content/vectors/backend.json', import.meta.url), 'utf8'), serializeVectors(), 'Run npm run vectors after intentional rule changes');
});


test('shared backend vectors stay compact and below one megabyte', () => {
  const raw = readFileSync(new URL('../content/vectors/backend.json', import.meta.url), 'utf8');
  assert.ok(Buffer.byteLength(raw) < 1_000_000);
  assert.equal(raw, JSON.stringify(JSON.parse(raw)) + '\n');
});

test('the spend vectors cover every outcome, not only refusals', () => {
  // A state key the save drops (an old name) would start every case at 0 glims: all "short".
  const t = JSON.parse(readFileSync(new URL('../content/vectors/backend.json', import.meta.url), 'utf8')) as {
    stateDefaults: Record<string, unknown>;
    spend: { state: Record<string, unknown>; operation: { kind: string }; imported: boolean; check: { ok: boolean; reason?: string }; result?: Record<string, unknown> }[];
  };
  const state = (c: (typeof t.spend)[number]) => ({ ...t.stateDefaults, ...((c.state.$state as Record<string, unknown>) ?? c.state) }) as { glims: number; xpGlims: number; hp: number };
  const ok = t.spend.filter((c) => c.check.ok);
  assert.ok(t.spend.some((c) => state(c).glims > 0), 'states with glims');
  assert.ok(t.spend.some((c) => state(c).xpGlims > 0), 'states with XP-earned glims');
  assert.ok(ok.length > 0 && ok.every((c) => c.result), 'passing cases, each with its result');
  assert.ok(ok.length < t.spend.length, 'refusals too');
  for (const reason of ['short', 'done', 'full', 'needs-earned']) assert.ok(t.spend.some((c) => c.check.reason === reason), reason);
  // A 0-HP imported revive that goes through: paid from XP-earned glims.
  assert.ok(ok.some((c) => c.imported && state(c).hp === 0 && (c.operation.kind === 'rest' || c.operation.kind === 'home-rest')), 'a revive');
});
