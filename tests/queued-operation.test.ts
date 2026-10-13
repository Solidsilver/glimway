import test from 'node:test';
import assert from 'node:assert/strict';
import { queuedRequest, queuedResult } from '../src/lib/api/queued-operation.ts';

test('queued requests preserve zeros, empty fields, caller keys, and the absence of place', () => {
  const where = { area: 'village', x: 0, y: 0 };
  const cast = queuedRequest('fish-cast', { water: 'water', bank: 'north', rod: 'rod' }, 'caller-key', where);
  assert.equal(cast.path, '/api/fishing/cast');
  assert.deepEqual(cast.body, { op: { lease: '', key: 'caller-key' }, where, water: 'water', bank: 'north', rod: 'rod' });
  const settle = queuedRequest('fish-settle', { cast: '', keep: false }, 'settle-key', where);
  assert.deepEqual(settle.body, { op: { lease: '', key: 'settle-key' }, where, cast: '', keep: false });
  const cancel = queuedRequest('fish-cancel', { cast: 'cast-id' }, 'cancel-key', where);
  assert.deepEqual(cancel.body, { op: { lease: '', key: 'cancel-key' }, cast: 'cast-id' });
  const lay = queuedRequest('wilds-lay', { epoch: 'epoch', x: 0, y: -24, kind: '' }, '', { area: 'wilds', x: 0, y: -384 });
  assert.equal(lay.key, '', 'an explicitly supplied empty key is not replaced');
  assert.deepEqual(lay.body, { op: { lease: '', key: '' }, epoch: 'epoch', where: { area: 'wilds', x: 0, y: -384 }, x: 0, y: -24, kind: '' });
});

test('queued results reject a different case or absent value before exposing success', () => {
  assert.equal(queuedResult('fish-cast', null), null);
  assert.equal(queuedResult('fish-cast', { case: 'fishSettle', value: {} }), null);
  assert.equal(queuedResult('fish-cast', { case: 'fishCast' }), null);
});
