import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import economyJson from '../content/economy.json' with { type: 'json' };
import type { Economy } from '../src/lib/economy.ts';
import { serializeVectors } from '../scripts/backend-vectors.ts';

test('shared economy has the complete typed shape and valid values', () => {
  const e = economyJson as Economy;
  assert.deepEqual(Object.keys(e).sort(), ['xpPerEmber', 'welcomeEmbers', 'costs', 'questEmbers', 'roadLanterns', 'chestId', 'charmItem', 'syncCreditCap', 'migrationGiftCap', 'checkpointToleranceXp'].sort());
  for (const n of [e.xpPerEmber, e.welcomeEmbers, e.syncCreditCap, e.migrationGiftCap, e.checkpointToleranceXp, ...Object.values(e.costs), ...Object.values(e.questEmbers)]) {
    assert.ok(Number.isSafeInteger(n) && n >= 0);
  }
  assert.ok(e.xpPerEmber > 0 && e.syncCreditCap > 0);
  assert.deepEqual(Object.keys(e.costs).sort(), ['chest', 'rest', 'roadLantern']);
  assert.deepEqual(Object.keys(e.questEmbers).sort(), ['defeat-guardian', 'return-village']);
  assert.deepEqual(e.roadLanterns, ['road-1', 'road-2', 'road-3']);
  assert.equal(e.chestId, 'ashwatch-chest');
  assert.equal(e.charmItem, 'ember-charm');
});

test('committed Go parity vectors match the real TypeScript functions', () => {
  assert.equal(readFileSync(new URL('../content/vectors/backend.json', import.meta.url), 'utf8'), serializeVectors(), 'Run npm run vectors after intentional rule changes');
});
