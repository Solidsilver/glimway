import test from 'node:test';
import assert from 'node:assert/strict';
import { PeerTrack, RENDER_DELAY_MS, SNAP_PX } from '../src/lib/presence-interp.ts';

const p = (x: number, y = 0, moving = true, fx = 1) => ({ x, y, facing: { x: fx, y: 0 }, moving });

test('draws a little in the past, gliding between samples', () => {
  const t = new PeerTrack();
  assert.equal(t.at(0), null);
  t.push(p(0), 1000);
  t.push(p(10), 1125);
  t.push(p(20), 1250);
  // Halfway between the first two samples, shown RENDER_DELAY_MS later.
  const mid = t.at(1062.5 + RENDER_DELAY_MS)!;
  assert.ok(Math.abs(mid.x - 5) < 1e-9);
  assert.equal(mid.moving, true);
  // Past the newest sample it holds still (no extrapolation).
  const end = t.at(5000)!;
  assert.equal(end.x, 20);
  assert.equal(end.moving, false);
});

test('a long silence before a step glides from where it stood, not from the past', () => {
  const t = new PeerTrack();
  t.push(p(0, 0, false), 1000);
  t.push(p(10), 5000); // stood still for 4 s, then moved
  const just = t.at(5000 - 125 + RENDER_DELAY_MS + 1)!;
  assert.ok(just.x < 2, `starts near 0, got ${just.x}`);
  const later = t.at(5000 + RENDER_DELAY_MS)!;
  assert.equal(later.x, 10);
});

test('a teleport snaps instead of sliding across the map', () => {
  const t = new PeerTrack();
  t.push(p(0), 1000);
  t.push(p(SNAP_PX + 50), 1125);
  const mid = t.at(1060 + RENDER_DELAY_MS)!;
  assert.equal(mid.x, 0);
  const after = t.at(1130 + RENDER_DELAY_MS)!;
  assert.equal(after.x, SNAP_PX + 50);
});

test('facing follows the samples; history stays bounded', () => {
  const t = new PeerTrack();
  t.push(p(0, 0, true, 1), 1000);
  t.push(p(-10, 0, true, -1), 1125);
  assert.equal(t.at(1010 + RENDER_DELAY_MS)!.facing.x, 1);
  assert.equal(t.at(1120 + RENDER_DELAY_MS)!.facing.x, -1);
  for (let i = 0; i < 100; i++) t.push(p(i), 2000 + i * 125);
  assert.equal(t.at(1e9)!.x, 99);
  assert.ok((t as unknown as { samples: unknown[] }).samples.length <= 16);
});
