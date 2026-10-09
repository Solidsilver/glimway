import test from 'node:test';
import assert from 'node:assert/strict';
import { CombatField, inCircle, kindleSpot, wardPulseTimes } from '../src/lib/combat-moves.ts';
import { abilityFor } from '../src/lib/abilities.ts';

test('Ward-light pulses at 1, 2.5 and 4 s for the table’s 5 s and 3 pulses', () => {
  const ward = abilityFor('ward-light')!;
  assert.deepEqual(wardPulseTimes(ward.numbers!.durationSeconds!, ward.numbers!.pulses!), [1, 2.5, 4]);
  assert.deepEqual(wardPulseTimes(5, 1), [1]);
  assert.deepEqual(wardPulseTimes(5, 0), []);
  for (const t of wardPulseTimes(9, 4)) assert.ok(t > 0 && t < 9);
});

test('Kindle lands its reach ahead in the facing, whatever the facing’s length', () => {
  assert.deepEqual(kindleSpot(100, 100, { x: 0, y: 1 }, 2), { x: 100, y: 132 });
  assert.deepEqual(kindleSpot(100, 100, { x: -3, y: 0 }, 2), { x: 68, y: 100 });
  const d = kindleSpot(0, 0, { x: 1, y: 1 }, 2);
  assert.ok(Math.abs(Math.hypot(d.x, d.y) - 32) < 1e-9);
});

test('the field: Stand plants for its seconds, patches slow what stands in them, Echo is aimed at until it fades', () => {
  const f = new CombatField();
  assert.equal(f.planted, false);
  assert.equal(f.slowAt(0, 0), 1);
  assert.deepEqual(f.aimFor({ x: 5, y: 5 }), { x: 5, y: 5 });

  f.plant(1.5, 0.8);
  f.kindle(100, 100, 24, 0.6, 6);
  f.echo(40, 50, 3);
  assert.equal(f.planted, true);
  assert.equal(f.stand?.stagger, 0.8);
  assert.equal(f.slowAt(110, 110), 0.6);
  assert.equal(f.slowAt(130, 100), 1, 'outside the patch: full speed');
  assert.deepEqual(f.aimFor({ x: 5, y: 5 }), { x: 40, y: 50 });

  f.tick(1.5);
  assert.equal(f.planted, false, 'Stand ends on time');
  f.tick(1.5);
  assert.deepEqual(f.aimFor({ x: 5, y: 5 }), { x: 5, y: 5 }, 'Echo fades at 3 s');
  assert.equal(f.slowAt(110, 110), 0.6);
  f.tick(3.01);
  assert.equal(f.slowAt(110, 110), 1, 'the patch is gone at 6 s');

  f.kindle(0, 0, 10, 0.6, 6);
  f.kindle(0, 0, 10, 0.5, 6);
  assert.equal(f.slowAt(0, 0), 0.5, 'overlapping patches: the slowest');
  f.clear();
  assert.equal(f.slowAt(0, 0), 1);
});

test('inCircle counts the rim', () => {
  assert.ok(inCircle(3, 4, 0, 0, 5));
  assert.ok(!inCircle(3, 4.01, 0, 0, 5));
});
