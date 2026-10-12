import test from 'node:test';
import assert from 'node:assert/strict';
import { clearMapPosition, heroPosition, publishMapPosition } from '../src/game/map-position.ts';

test('the map takes the scene’s live position only for the session’s own area and world', () => {
  const scene = {};
  publishMapPosition(scene, 'wilds', 'world-a', 400, -960);
  // Out in the Wilds: the live sample, not the save's older spot.
  assert.deepEqual(heroPosition({ area: 'wilds', position: { x: 380, y: -950 } }, 'world-a'), { area: 'wilds', world: 'world-a', x: 400, y: -960 });
  // A move to the village has begun (the save names it, the old scene hasn't gone yet): the save, never the Wilds sample.
  assert.deepEqual(heroPosition({ area: 'village', position: { x: 256, y: 300 } }, 'world-a'), { area: 'village', world: 'world-a', x: 256, y: 300 });
  // Another world: the save too.
  assert.equal(heroPosition({ area: 'wilds', position: null }, 'world-b'), null);
  // The old scene's clear doesn't take a newer scene's sample with it.
  const next = {};
  publishMapPosition(next, 'village', 'world-a', 250, 310);
  clearMapPosition(scene);
  assert.equal(heroPosition({ area: 'village', position: null }, 'world-a')!.x, 250);
  clearMapPosition(next);
  assert.equal(heroPosition({ area: 'village', position: null }, 'world-a'), null);
});
