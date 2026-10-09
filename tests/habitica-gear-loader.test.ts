import test from 'node:test';
import assert from 'node:assert/strict';
import vectors from '../content/vectors/habitica-gear.json' with { type: 'json' };
import gearRaw from '../content/habitica-gear.json' with { type: 'json' };
import { CATALOG, validateHabiticaGear, gearStatsFor, gearItemFor } from '../src/lib/habitica/gear.ts';
import { refusalMatchesRule } from './helpers/vector-rule.ts';

interface Edit { path: (string | number)[]; value?: unknown; remove?: boolean }
function edited(base: unknown, edits: Edit[]): unknown {
  const value = structuredClone(base);
  for (const e of edits) { let target = value as any; for (const key of e.path.slice(0, -1)) target = target[key]; if (e.remove) delete target[e.path.at(-1)!]; else target[e.path.at(-1)!] = e.value; }
  return value;
}
for (const v of vectors.loader) test(`shared habitica-gear loader: ${v.name}`, () => {
  const value = edited(gearRaw, v.edits);
  if (v.valid) assert.doesNotThrow(() => validateHabiticaGear(value));
  else assert.throws(() => validateHabiticaGear(value), (e: Error) => refusalMatchesRule(e, v.rule), v.rule);
});

test('the shipped snapshot loads on the client', () => {
  assert.ok(CATALOG.comment.length > 0);
  assert.ok(Object.keys(CATALOG.gear).length >= 1800);
  assert.ok(CATALOG.appearances.hair.color.length > 0);
  // The provenance and rules of interpretation survived the reshape.
  assert.equal(CATALOG.provenance.name, 'habitica-content-snapshot');
  assert.ok(Object.keys(CATALOG.rules).length > 0);
});

test('the lookups answer as before', () => {
  assert.deepEqual(gearStatsFor('armor_armoire_admiralsUniform'), { str: 7, int: 0, con: 7, per: 0, klass: 'armoire' });
  assert.equal(gearStatsFor('no-such-key'), undefined);
  assert.equal(gearItemFor('no-such-key'), undefined);
});
