import test from 'node:test';
import assert from 'node:assert/strict';
import { MAIL, validateMail } from '../src/lib/mail.ts';

test('mail rules share bounded caps, send rates, history and return policy', () => {
  assert.deepEqual(MAIL, {
    maxOutstandingSent: 50, maxOutstandingReceived: 50,
    maxSendsPerWindow: 10, sendWindowSeconds: 60, historyPageSize: 50,
    returnAfterDays: 30, maintenanceBatch: 100, maintenanceIntervalSeconds: 60,
  });
});
test('mail rules reject missing, fractional, unsafe or out-of-bound configuration', () => {
  for (const key of Object.keys(MAIL) as (keyof typeof MAIL)[]) {
    for (const value of [0, -1, 1.5, Infinity, 1_000_000_000]) {
      assert.throws(() => validateMail({ ...MAIL, [key]: value }));
    }
    const missing = { ...MAIL } as Partial<typeof MAIL>;
    delete missing[key];
    assert.throws(() => validateMail(missing));
  }
  for (const raw of [null, {}, [], 'mail']) assert.throws(() => validateMail(raw));
});
