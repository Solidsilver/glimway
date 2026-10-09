import test from 'node:test';
import assert from 'node:assert/strict';
import vectors from '../content/vectors/mail.json' with { type: 'json' };
import mailRaw from '../content/mail.json' with { type: 'json' };
import { MAIL, validateMail } from '../src/lib/mail.ts';
import { refusalMatchesRule } from './helpers/vector-rule.ts';

interface Edit { path: (string | number)[]; value?: unknown; remove?: boolean }
function edited(base: unknown, edits: Edit[]): unknown {
  const value = structuredClone(base);
  for (const e of edits) { let target = value as any; for (const key of e.path.slice(0, -1)) target = target[key]; if (e.remove) delete target[e.path.at(-1)!]; else target[e.path.at(-1)!] = e.value; }
  return value;
}
for (const v of vectors.loader) test(`shared mail loader: ${v.name}`, () => {
  const value = edited(mailRaw, v.edits);
  if (v.valid) assert.doesNotThrow(() => validateMail(value));
  else assert.throws(() => validateMail(value), (e: Error) => refusalMatchesRule(e, v.rule), v.rule);
});

test('mail rules share bounded caps, send rates, history and return policy', () => {
  for (const [k, v] of Object.entries({
    maxOutstandingSent: 50, maxOutstandingReceived: 50,
    maxSendsPerWindow: 10, sendWindowSeconds: 60, historyPageSize: 50,
    returnAfterDays: 30, maintenanceBatch: 100, maintenanceIntervalSeconds: 60,
  }) as [keyof typeof MAIL, number][]) assert.equal(MAIL[k], v, k);
});
