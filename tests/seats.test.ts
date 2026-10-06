import test from 'node:test';
import assert from 'node:assert/strict';
import { BENCH, KEPT_EMPTY, SEAT_CUT, SEAT_EDGE, SEAT_ITEMS, benchSeat, decoSeat, isSeatItem } from '../src/game/seats.ts';
import { ART_PX, BREATH_MS, STEP_MS, avatarMotion } from '../src/game/hero-motion.ts';
import { EMPTY_CHAIR_LINE, SEAT_LINES } from '../src/content/touches.ts';
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts';

test('a bench seats you on it, facing the square, in front of its backrest', () => {
  const s = benchSeat(152, 224);
  assert.equal(s.x, 152);
  // On the seat (above the bench's base), not in front of it.
  assert.equal(s.y, 224 - BENCH.frontEdge);
  assert.ok(s.y < 224);
  // Drawn just over the bench (backrest behind), under anything standing lower.
  assert.ok(s.depth > 224 && s.depth < 225);
  assert.equal(s.facing, 'down');
});

test('every placed stool and chair is a seat; the Empty Chair is kept empty', () => {
  const furniture = HOMESTEAD_DATA.items.filter((i) => /stool|chair|bench/.test(i.id) && i.id !== KEPT_EMPTY && i.id !== 'writing-desk');
  for (const item of furniture) assert.ok(isSeatItem(item.id), `${item.id} should be sittable`);
  assert.deepEqual([...SEAT_ITEMS].sort(), furniture.map((i) => i.id).sort());
  assert.equal(isSeatItem(KEPT_EMPTY), false);
  assert.equal(decoSeat(KEPT_EMPTY, { left: 0, top: 0, right: 16, bottom: 16 }, 16), null);
  assert.equal(decoSeat('potted-fern', { left: 0, top: 0, right: 16, bottom: 16 }, 16), null);
  assert.ok(EMPTY_CHAIR_LINE.length <= 160);
  for (const id of SEAT_ITEMS) {
    assert.ok(SEAT_LINES[id]?.length, `${id} has sit lines`);
    for (const l of SEAT_LINES[id]) assert.ok(l.length <= 160, l);
  }
});

test('placed seats: on the seat of the art as drawn, facing you, just in front of it', () => {
  // The delivered stool: 15×16 at a footprint x 48..64, bottom 80; its round top's lip 40% down.
  const stool = decoSeat('wooden-stool', { left: 48, top: 64, right: 63, bottom: 80 }, 80)!;
  assert.deepEqual(stool, { x: 56, y: 70, depth: 80.5, facing: 'down' });
  // The delivered armchair: 16×15 at the bottom of its two-tile footprint; the cushion's front edge.
  const chair = decoSeat('reading-chair', { left: 48, top: 81, right: 64, bottom: 96 }, 96)!;
  assert.deepEqual(chair, { x: 56, y: 92, depth: 96.5, facing: 'down' });
  for (const id of SEAT_ITEMS) assert.ok(SEAT_EDGE[id] > 0 && SEAT_EDGE[id] < 1);
});

test('sitting cuts the body at the lap, never squashes it', () => {
  for (const facing of ['down', 'left', 'right'] as const) {
    // Below the belt, above the feet, for both bodies.
    assert.ok(SEAT_CUT.demo[facing] > 91 && SEAT_CUT.demo[facing] < 137);
    assert.ok(SEAT_CUT.habitica[facing] > 72 && SEAT_CUT.habitica[facing] < 84);
  }
});

test('standing still breathes one art pixel, slowly; walking steps; reduced motion: no breath', () => {
  const still = Array.from({ length: BREATH_MS / 50 }, (_, i) => avatarMotion(i * 50, false, false));
  // Only ever level or one pixel up: no glide, no float.
  assert.deepEqual([...new Set(still.map((m) => m.breath))].sort(), [-ART_PX, 0]);
  assert.ok(still.every((m) => m.step === 0), 'the feet stay planted');
  // Slow: one rise per breath, held for over a second.
  const risen = still.filter((m) => m.breath !== 0).length * 50;
  assert.ok(risen >= 1200 && risen <= 2200, `held ${risen} ms`);
  let rises = 0;
  for (let i = 1; i < still.length; i++) if (still[i].breath !== 0 && still[i - 1].breath === 0) rises++;
  assert.equal(rises, 1);

  const walk = [0, STEP_MS, 2 * STEP_MS, 3 * STEP_MS].map((t) => avatarMotion(t + 1, true, false));
  assert.deepEqual(walk.map((m) => m.step), [0, -ART_PX, 0, -ART_PX]);
  assert.ok(walk.every((m) => m.breath === 0));

  for (let t = 0; t < BREATH_MS; t += 100) assert.deepEqual(avatarMotion(t, false, true), { breath: 0, step: 0 });
});
