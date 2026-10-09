import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ECONOMY as e } from '../src/lib/economy.ts';
import { serializeVectors } from '../scripts/backend-vectors.ts';

test('shared economy has the complete typed shape and valid values', () => {
  assert.deepEqual(Object.keys(e).filter((k) => k !== '$typeName').sort(), ['xpPerEmber', 'welcomeEmbers', 'costs', 'roadLanterns', 'chestId', 'charmItem', 'syncCreditCap', 'migrationGiftCap', 'checkpointToleranceXp', 'outstandingInvites', 'syncCreditDailyGrowth', 'syncCreditMax', 'pendingCreditDays', 'lifetimeInvites', 'wildsLimits'].sort());
  for (const n of [e.syncCreditDailyGrowth, e.syncCreditMax, e.pendingCreditDays, e.lifetimeInvites, e.outstandingInvites, e.xpPerEmber, e.welcomeEmbers, e.syncCreditCap, e.migrationGiftCap, e.checkpointToleranceXp, ...Object.values(e.costs).filter((v) => typeof v === 'number')]) {
    assert.ok(Number.isSafeInteger(n) && n >= 0);
  }
  assert.ok(e.xpPerEmber > 0 && e.syncCreditCap > 0);
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
