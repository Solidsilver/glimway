import test from 'node:test';
import assert from 'node:assert/strict';
import { CAMP_PACK_WORDS, CAMP_PLANT_CHOICES, campPlantLines } from '../src/lib/camps.ts';
import { TROWEL, dugUpLine, plantOffer } from '../src/lib/trowel.ts';
import { BELT_ORDER, KIND_WORDS, beltFor } from '../src/lib/belt.ts';
import { CRAFTING } from '../src/lib/workshop.ts';
import { itemDef } from '../src/lib/items.ts';
import type { InstanceView } from '../src/lib/api/types.ts';

const tool = (id: string, def: string): InstanceView => ({
  id,
  itemDef: def,
  condition: 90,
  maxCondition: 90,
  usesLeft: 30,
  state: 'whole',
  wardenSet: false,
  fittings: [],
  maker: null,
});

test('trowel: a bench tool, cheap, made from one timber and one stone', () => {
  const d = itemDef('bench-trowel');
  assert.equal(d?.kind, 'tool');
  assert.deepEqual(d?.actions, [TROWEL]);
  const r = CRAFTING.recipes.find((x) => x.id === 'craft-bench-trowel');
  assert.deepEqual(r?.materials, { timber: 1, stone: 1 });
  assert.equal(r?.output.id, 'bench-trowel');
});

test('trowel: its own belt slot, after the spade, called a trowel', () => {
  assert.equal(BELT_ORDER.indexOf('uproot'), BELT_ORDER.indexOf('dig') + 1);
  assert.equal(KIND_WORDS.uproot, 'Trowel');
  const belt = beltFor([tool('t', 'bench-trowel'), tool('d', 'bench-spade')]);
  assert.deepEqual(belt.map((s) => s.kind), ['weapon', 'dig', 'uproot', 'hands']);
  assert.equal(belt[2].instance, 't');
});

test('trowel: a plant offers digging up only with the trowel in hand, and only to whoever may dig', () => {
  assert.deepEqual(plantOffer('Turncap spawn', 'uproot', true, true), { label: 'Dig up the turncap spawn', verb: 'Dig up', dig: true });
  // Without it a camp plant is only looked at; a home plant says nothing.
  for (const held of ['weapon', 'dig', 'hands'] as const) {
    assert.equal(plantOffer('Turncap spawn', held, true, true)?.dig, false, held);
    assert.equal(plantOffer('Turncap spawn', held, true, false), null, held);
  }
  // In hand, but not yours to dig.
  assert.equal(plantOffer('Turncap spawn', 'uproot', false, false), null);
});

test('trowel: the camp plant prompt no longer offers "Dig it up"', () => {
  const texts = CAMP_PLANT_CHOICES.map((c) => c.text);
  assert.deepEqual(texts, ['Leave it']);
  assert.ok(!texts.some((t) => /dig/i.test(t)));
  assert.ok(!('dig' in CAMP_PACK_WORDS));
  // The look points at the trowel instead, for whoever may dig.
  assert.deepEqual(campPlantLines('Turncap spawn', 'Bob', true), ['Bob’s turncap spawn, growing in the lamp’s light.', 'A trowel would dig it up.']);
});

test('trowel: any visitor at a camp may look at a plant; only those who may dig get the dig', () => {
  // A visitor not allowed to build, trowel in hand: still only a look, and no trowel hint.
  assert.deepEqual(plantOffer('Turncap spawn', 'uproot', false, true), { label: 'Look at the turncap spawn', verb: 'Look', dig: false });
  assert.deepEqual(campPlantLines('Turncap spawn', 'Bob'), ['Bob’s turncap spawn, growing in the lamp’s light.']);
  assert.deepEqual(campPlantLines('Turncap spawn', 'Bob', false), ['Bob’s turncap spawn, growing in the lamp’s light.']);
});

test('trowel: each dig says what it did to the trowel when it gives out', () => {
  const wear = (broke: boolean, usesLeft: number) => ({ broke, state: broke ? 'broken' : 'whole', wornOut: [], returned: [], itemDef: 'bench-trowel', usesLeft });
  assert.equal(dugUpLine('Wild thyme', wear(false, 29)), 'You dig up the wild thyme. It’s in your pack.');
  assert.equal(dugUpLine('Wild thyme', undefined), 'You dig up the wild thyme. It’s in your pack.');
  assert.match(dugUpLine('Wild thyme', wear(true, 0)), /^You dig up the wild thyme\. It’s in your pack\. .*trowel gave out\.$/i);
});
