import test from 'node:test';
import assert from 'node:assert/strict';
import { BELT_ORDER, SWING, beltFor, heldSlot, KIND_WORDS, kindForKey, noSwingThought, stepKind } from '../src/lib/belt.ts';
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

test('belt: the rod is its own kind, after the spade (crafts.md 5.7)', () => {
  const belt = beltFor([tool('r', 'willow-rod'), tool('d', 'bench-spade'), tool('b', 'stave-bucket')]);
  assert.deepEqual(belt.map((s) => s.kind), ['weapon', 'dig', 'fish', 'draw']);
  assert.equal(heldSlot(belt, 'fish').instance, 'r');
  assert.equal(KIND_WORDS.fish, 'Fish');
});

test('a click or a press swings only what can be swung: the weapon, then the sturdy tools', () => {
  assert.equal(SWING.weapon, 'weapon');
  for (const k of ['chop', 'break', 'dig'] as const) assert.equal(SWING[k], 'tool', k);
  for (const k of ['fish', 'draw', 'water', 'trim', 'mark'] as const) assert.equal(SWING[k], null, k);
  // Every kind on the belt has a rule.
  assert.deepEqual(Object.keys(SWING).sort(), [...BELT_ORDER].sort());
  assert.equal(noSwingThought('Willow rod'), 'You can’t fight with a willow rod.');
  assert.equal(noSwingThought('Oak-mark punch'), 'You can’t fight with an oak-mark punch.');
  assert.match(noSwingThought(null), /no thing to fight with/);
});
