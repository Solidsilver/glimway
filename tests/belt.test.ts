import test from 'node:test';
import assert from 'node:assert/strict';
import { BELT_ORDER, SWING, beltFor, heldSlot, KIND_WORDS, keyForSlot, kindForKey, noSwingThought, stepKind } from '../src/lib/belt.ts';
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

test('belt: the weapon alone for a guest or an empty pack (the hands are there too)', () => {
  assert.deepEqual(beltFor(null).map((s) => s.kind), ['weapon', 'hands']);
  assert.deepEqual(beltFor([]).map((s) => s.kind), ['weapon', 'hands']);
});

test('belt: the empty hands are always on the belt, always last, and never carry a tool', () => {
  for (const pack of [null, [], [tool('a', 'bench-axe'), tool('r', 'willow-rod')]] as const) {
    const belt = beltFor(pack as never);
    assert.equal(belt.at(-1)?.kind, 'hands', JSON.stringify(pack));
    assert.equal(belt.filter((s) => s.kind === 'hands').length, 1);
  }
  const hands = beltFor(null).at(-1)!;
  assert.equal(hands.instance, null);
  assert.equal(hands.itemDef, null);
  // The chosen kind never falls back to the weapon: the hands are always carried.
  assert.equal(heldSlot(beltFor(null), 'hands').kind, 'hands');
});

test('belt: one slot per tool kind carried, in the fixed order, the weapon first and the hands last', () => {
  const belt = beltFor([tool('s', 'bench-spade'), tool('a', 'bench-axe'), tool('b', 'stave-bucket'), tool('p', 'bench-pick')]);
  assert.deepEqual(belt.map((s) => s.kind), ['weapon', 'chop', 'break', 'dig', 'draw', 'hands']);
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
  // The wheel steps through the hands too, and wraps round.
  assert.equal(stepKind(belt, 'dig', 1), 'hands');
  assert.equal(stepKind(belt, 'hands', 1), 'weapon');
  assert.equal(stepKind(belt, 'weapon', -1), 'hands');
  assert.equal(stepKind(belt, 'hands', -1), 'dig');
  // The axe chosen but the pack lost it: the weapon is in hand.
  assert.equal(heldSlot(beltFor([tool('d', 'bench-spade')]), 'chop').kind, 'weapon');
});

test('belt: the 0 key is the empty hands, and they never take one of 1…9', () => {
  const belt = beltFor([tool('a', 'bench-axe'), tool('d', 'bench-spade')]);
  assert.equal(kindForKey(belt, 0), 'hands');
  assert.equal(kindForKey(beltFor(null), 0), 'hands');
  assert.equal(kindForKey(belt, 5), null);
  assert.equal(keyForSlot(belt, 'hands'), 0);
  assert.equal(keyForSlot(belt, 'weapon'), 1);
  assert.equal(keyForSlot(belt, 'chop'), 2);
  assert.equal(keyForSlot(belt, 'dig'), 3);
  for (const s of belt) assert.equal(kindForKey(belt, keyForSlot(belt, s.kind)), s.kind, s.kind);
});

test('belt: the rod is its own kind, after the spade (crafts.md 5.7)', () => {
  const belt = beltFor([tool('r', 'willow-rod'), tool('d', 'bench-spade'), tool('b', 'stave-bucket')]);
  assert.deepEqual(belt.map((s) => s.kind), ['weapon', 'dig', 'fish', 'draw', 'hands']);
  assert.equal(heldSlot(belt, 'fish').instance, 'r');
  assert.equal(KIND_WORDS.fish, 'Fish');
});

test('a click or a press swings only what can be swung: the weapon, then the sturdy tools', () => {
  assert.equal(SWING.weapon, 'weapon');
  for (const k of ['chop', 'break', 'dig'] as const) assert.equal(SWING[k], 'tool', k);
  for (const k of ['fish', 'draw', 'water', 'trim', 'mark', 'hands'] as const) assert.equal(SWING[k], null, k);
  // Every kind on the belt has a rule.
  assert.deepEqual(Object.keys(SWING).sort(), [...BELT_ORDER].sort());
  assert.equal(noSwingThought('Willow rod'), 'You can’t fight with a willow rod.');
  assert.equal(noSwingThought('Oak-mark punch'), 'You can’t fight with an oak-mark punch.');
  assert.match(noSwingThought(null), /no thing to fight with/);
  // Empty hands and nothing to act on: a thought, never a swing.
  assert.equal(noSwingThought(null, 'hands'), 'Your hands are empty.');
  assert.equal(noSwingThought('anything at all', 'hands'), 'Your hands are empty.');
});

test('belt: the words for the empty hands', () => {
  assert.equal(KIND_WORDS.hands, 'Empty hands');
  assert.deepEqual(Object.keys(KIND_WORDS).sort(), [...BELT_ORDER].sort());
});
