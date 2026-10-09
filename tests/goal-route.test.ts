import test from 'node:test';
import assert from 'node:assert/strict';
import { questPlace, questPointHere, type QuestLook } from '../src/game/goal-route.ts';

const none: QuestLook = { npcAt: () => null, spotAt: () => null, wardenAt: () => null, enemyAt: () => null, lootAt: () => null };

test('goal route: a step’s place is its area; a resident’s is their schedule’s', () => {
  assert.equal(questPlace({ ui: 'journal' }, 0), null, 'the journal is no place');
  assert.deepEqual(questPlace({ area: 'woodland', enemy: 'finger-wisp' }, 0), { area: 'woodland', resident: null });
  // Finn is in the mill loft by his schedule, though the step names the square:
  // the needle and the glow both look for him where he's drawn.
  const loft = { area: 'mill-loft', tx: 4, ty: 3 };
  assert.deepEqual(questPlace({ area: 'village', npc: 'finn' }, 0, () => loft), { area: 'mill-loft', resident: loft });
  assert.deepEqual(questPlace({ npc: 'finn' }, 0, () => loft), { area: 'mill-loft', resident: loft });
  // Someone without a schedule (Orrin, Mara) stands in the step's area.
  assert.deepEqual(questPlace({ area: 'village', npc: 'orrin' }, 0, () => null), { area: 'village', resident: null });
  assert.equal(questPlace({ npc: 'nobody' }, 0, () => null), null);
});

test('goal route: the target here — what an enemy lies on, then the enemy; the person; the spot', () => {
  const look: QuestLook = {
    ...none,
    enemyAt: (id) => (id === 'finger-wisp' ? { x: 100, y: 270 } : null),
    lootAt: (id) => (id === 'finger-wisp' ? { x: 104, y: 284 } : null),
    npcAt: (id) => (id === 'orrin' ? { x: 50, y: 60 } : null),
    spotAt: (id) => (id === 'road-1' ? { x: 10, y: 20 } : id === 'clue' ? { x: 7, y: 8 } : null),
  };
  assert.deepEqual(questPointHere({ area: 'woodland', enemy: 'finger-wisp' }, null, look), { x: 104, y: 284, id: 'finger-wisp' }, 'the lost finger glows');
  assert.deepEqual(questPointHere({ area: 'woodland', enemy: 'finger-wisp' }, null, { ...look, lootAt: () => null }), { x: 100, y: 270, id: 'finger-wisp' });
  assert.deepEqual(questPointHere({ area: 'village', npc: 'orrin' }, null, look), { x: 50, y: 60, id: 'orrin' });
  assert.deepEqual(questPointHere({ area: 'woodland', spot: 'road-1' }, null, look), { x: 10, y: 20, id: 'road-1' });
  // The warden, or its route stone while it isn't up.
  assert.deepEqual(questPointHere({ area: 'ruin', enemy: 'stone-warden' }, null, look), { x: 7, y: 8, id: 'stone-warden' });
  // A resident not drawn yet: their schedule's tile.
  assert.deepEqual(questPointHere({ npc: 'finn' }, { area: 'mill-loft', tx: 4, ty: 3 }, none), { x: 72, y: 56, id: 'finn' });
  assert.equal(questPointHere({ area: 'woodland', enemy: 'finger-wisp' }, null, none), null, 'gone: nothing to glow');
});
