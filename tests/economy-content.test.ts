import test from 'node:test';
import assert from 'node:assert/strict';
import vectors from '../content/vectors/economy.json' with { type: 'json' };
import economyRaw from '../content/economy.json' with { type: 'json' };
import { ECONOMY, validateEconomy } from '../src/lib/economy.ts';
import { refusalMatchesRule } from './helpers/vector-rule.ts';

interface Edit { path: (string | number)[]; value?: unknown; remove?: boolean }
function edited(base: unknown, edits: Edit[]): unknown {
  const value = structuredClone(base);
  for (const e of edits) { let target = value as any; for (const key of e.path.slice(0, -1)) target = target[key]; if (e.remove) delete target[e.path.at(-1)!]; else target[e.path.at(-1)!] = e.value; }
  return value;
}
for (const v of vectors.loader) test(`shared economy loader: ${v.name}`, () => {
  const value = edited(economyRaw, v.edits);
  if (v.valid) assert.doesNotThrow(() => validateEconomy(value));
  else assert.throws(() => validateEconomy(value), (e: Error) => refusalMatchesRule(e, v.rule), v.rule);
});

test('the shipped economy contract holds', () => {
  assert.equal(ECONOMY.xpPerGlim, 10);
  assert.deepEqual([...ECONOMY.roadLanterns], ['road-1', 'road-2', 'road-3']);
  assert.ok(ECONOMY.costs.homeRest < ECONOMY.costs.rest);
  assert.equal(ECONOMY.wildsLimits.lanternReward.material, 'amber');
});
