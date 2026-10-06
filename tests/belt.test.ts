import test from 'node:test';
import assert from 'node:assert/strict';
import { beltFor, heldSlot, kindForKey, stepKind } from '../src/lib/belt.ts';
import type { InstanceView } from '../src/lib/api/types.ts';

const tool = (id: string, itemDef: string, state = 'sound', usesLeft = 30): InstanceView => ({
  id,
  itemDef,
  condition: 90,
  maxCondition: 90,
  usesLeft,
  state: state as InstanceView['state'],
  wardenSet: false,
  fittings: [],
  maker: null,
});

test('belt: the weapon alone for a guest or an empty pack', () => {
  assert.deepEqual(beltFor(null).map((s) => s.kind), ['weapon']);
  assert.deepEqual(beltFor([]).map((s) => s.kind), ['weapon']);
});

test('belt: one slot per tool kind carried, in the fixed order, the weapon first', () => {
  const belt = beltFor([tool('s', 'bench-spade'), tool('a', 'bench-axe'), tool('b', 'stave-bucket'), tool('p', 'bench-pick')]);
  assert.deepEqual(belt.map((s) => s.kind), ['weapon', 'chop', 'break', 'dig', 'draw']);
  assert.equal(belt[1].instance, 'a');
});

test('belt: the best of a kind: a working tool before a blunt one, keen before dull, more uses first', () => {
  const belt = beltFor([tool('blunt', 'bench-axe', 'blunt'), tool('dull', 'brack-felling-axe', 'dull'), tool('keen', 'bench-axe', 'sound', 4)]);
  assert.equal(belt[1].instance, 'keen');
  assert.equal(beltFor([tool('blunt', 'bench-axe', 'blunt')])[1].usable, false);
  const two = beltFor([tool('few', 'bench-axe', 'sound', 3), tool('many', 'bench-axe', 'sound', 20)]);
  assert.equal(two[1].instance, 'many');
});

test('belt: keys, the wheel, and a kind no longer carried', () => {
  const belt = beltFor([tool('a', 'bench-axe'), tool('d', 'bench-spade')]);
  assert.equal(kindForKey(belt, 1), 'weapon');
  assert.equal(kindForKey(belt, 3), 'dig');
  assert.equal(kindForKey(belt, 4), null);
  assert.equal(stepKind(belt, 'dig', 1), 'weapon');
  assert.equal(stepKind(belt, 'weapon', -1), 'dig');
  // The axe chosen but the pack lost it: the weapon is in hand.
  assert.equal(heldSlot(beltFor([tool('d', 'bench-spade')]), 'chop').kind, 'weapon');
});
