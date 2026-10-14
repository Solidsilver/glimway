import test from 'node:test';
import assert from 'node:assert/strict';
import { at } from '../src/lib/location.ts';
import { isSafeBoundary, isSafeArea } from '../src/lib/habitica/sync.ts';
import { createNewGame, validateSave } from '../src/lib/state.ts';
import { rideRefusal } from '../src/lib/companions.ts';
import { gatheringOffered } from '../src/lib/gathering.ts';
import { moveBlocks } from '../src/lib/world-moves.ts';
import { displayArea } from '../src/content/world.ts';
import { pickupsIn } from '../src/lib/items.ts';
import { isPresenceArea } from '../src/lib/presence-client.ts';
import { hasAreaKind } from '../src/game/worlds.ts';

test('location rules follow the hero across the safety boundary, on the Commons and off it', () => {
  for (const [area, x, y, safe, ride, id, moveSafe] of [
    ['hearthwick', 40, 424, true, true, 'hearthwick', true],
    ['outdoors', 40, 392, true, true, 'hearthwick', true],
    ['outdoors', 40, 376, false, true, 'tangle', false],
    ['village', 400, 300, true, false, 'village', true],
    // From a home a move arrives at its gate on the new world's Commons (the server's anchor).
    ['home:0', 40, 40, true, true, 'home:0', true],
    ['in:home:0', 80, 80, true, false, 'in:home:0', true],
    ['in:commons:yard', 40, 40, true, false, 'in:commons:yard', true],
  ] as const) {
    const state = { ...createNewGame(), area, position: { x, y } };
    assert.equal(at(area, x, y).id, id);
    assert.equal(isSafeArea(area, state.position), safe);
    assert.equal(isSafeBoundary(state), safe);
    assert.equal(moveBlocks({ area, position: state.position, outgoing: 0, online: true, pending: false }).includes('area'), !moveSafe);
    assert.equal(rideRefusal({ area, position: state.position, mountOut: 'Wolf-Base', riding: false, stable: true, mounts: 1 }) === null, ride);
  }
  assert.equal(displayArea({ area: 'outdoors', position: { x: 40, y: 392 } }), 'hearthwick');
  assert.equal(displayArea({ area: 'outdoors', position: { x: 40, y: 376 } }), 'tangle');
});

test('fixed ground offers its own gathering and content placements; the old saved space is refused', () => {
  assert.equal(gatheringOffered('outdoors', 'tree', { x: 40, y: 392 }), false);
  assert.equal(gatheringOffered('outdoors', 'bloom-patch', { x: 40, y: 392 }), true);
  assert.equal(gatheringOffered('outdoors', 'tree', { x: 40, y: 376 }), true);
  const local = pickupsIn('hearthwick', []);
  const world = pickupsIn('outdoors', []);
  assert.equal(world.length, local.length);
  for (const p of local) {
    const w = world.find(w => w.id === p.id)!;
    assert.equal(w.area, 'outdoors');
    assert.equal(w.tx, p.tx);
    assert.equal(w.ty, p.ty);
  }
  assert.throws(() => validateSave({ ...createNewGame(), area: 'wilds' }));
  assert.equal(isPresenceArea('wilds:0:0'), false);
  assert.equal(isPresenceArea('outdoors:0:1'), true);
  assert.equal(isPresenceArea('outdoors:0:3'), true);
  assert.equal(hasAreaKind('outdoors'), true);
  assert.equal(hasAreaKind('wilds'), false);
});

test('quest reach predicates use the named place and retain outdoor wire space', async () => {
  const { autoSteps } = await import('../src/lib/quests.ts');
  const { questPointHere } = await import('../src/game/goal-route.ts');
  const look = { npcAt: () => null, spotAt: () => null, wardenAt: () => null, enemyAt: () => null, lootAt: () => null };
  assert.deepEqual(questPointHere({ npc: 'silas', area: 'hearthwick' }, { area: 'hearthwick', tx: 34, ty: 35 }, look, 'outdoors'), { id: 'silas', x: 34 * 16 + 8, y: 35 * 16 + 8 });
  const context = { flags: [], defeated: [], carrying: () => 0 };
  assert.deepEqual(autoSteps({}, { habitica: false }, { ...context, area: 'outdoors', position: { x: 40, y: 392 } }), autoSteps({}, { habitica: false }, { ...context, area: 'hearthwick' }));
});
