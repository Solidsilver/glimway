import { checkGate, type QuestStepDef } from '../src/lib/quests.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import vectors from '../content/vectors/town-rules.json' with { type: 'json' };
import { at } from '../src/lib/location.ts';
import { bankFor, nearBank, waterFor, watersForArea } from '../src/lib/fishing.ts';
import layout from '../content/layouts/hearthwick.json' with { type: 'json' };
import { fixedGatherAt, gatherArea, gatheringOffered } from '../src/lib/gathering.ts';
import { createNewGame, recoverFromDefeat } from '../src/lib/state.ts';
import { predict } from '../src/lib/api/predict.ts';

test('town rule parity uses saved world pixels (shared Go/TS vectors)', () => {
  const water = waterFor('water:village:mill-pond')!;
  const bank = bankFor(water, 'north')!;
  for (const c of vectors.cases) {
    assert.equal(at(c.area, c.x, c.y).rest, c.rest, `${c.name}: rest`);
    assert.equal(gatheringOffered(c.area, c.target, c), c.gather, `${c.name}: gathering`);
    assert.equal(gatherArea(c.area, c), c.gatherArea, `${c.name}: gatherArea`);
    assert.equal(nearBank(c.area, c.x, c.y, water, bank), c.fish, `${c.name}: fishing`);
  }
  assert.deepEqual(watersForArea('outdoors').map(w => w.id), [water.id]);
  assert.deepEqual(watersForArea('hearthwick').map(w => w.id), [water.id]);
});

test('new arrivals and both recovery paths use authored town anchors', () => {
  const state = createNewGame();
  assert.deepEqual({ area: state.area, ...state.position }, vectors.spawn);
  for (const recovered of [recoverFromDefeat(state), predict(state, { kind: 'fall' }, { profile: null })]) {
    assert.deepEqual({ area: recovered.area, ...recovered.position }, vectors.recovery);
  }
});

test('quest gate prediction uses the same place as server personHere', () => {
  for (const c of vectors.gates) {
    const step = { id: 'test', at: 'hearthwick', gate: { with: c.with } } as QuestStepDef;
    const got = checkGate(step, { area: c.area, position: c, now: c.now, glims: 0, carrying: () => 0, gateAt: undefined, online: true });
    assert.equal(got.ok, c.here, c.name);
  }
});

test('authored gathering needs the matching tile within reach (shared Go/TS vectors)', () => {
 const objects = layout.objects.filter((o) => o.kind === 'gather').map((o) => ({ kind: o.kind, target: o.target!, tx: o.tx - 24, ty: o.ty + 24 }));
 for (const c of vectors.fixedGather) assert.equal(fixedGatherAt(c, c.tile, c.target, objects), c.allowed, c.name);
});
