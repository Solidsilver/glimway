import test from 'node:test';
import assert from 'node:assert/strict';
import { LEAD_BEHIND, LEAD_DROP, LEAD_SLACK, leadStep, ropeSag, type LeadState } from '../src/game/entities/led-mount.ts';

const walk = (s: LeadState, hero: { x: number; y: number; faceRight?: boolean; seated?: boolean }, frames: number): LeadState => {
  let st = s;
  for (let f = 0; f < frames; f++) st = leadStep(st, { x: hero.x, y: hero.y, faceRight: hero.faceRight ?? true, seated: hero.seated ?? false, dt: 16 });
  return st;
};

test('on the lead: it comes to its spot behind the hero, past the pet', () => {
  const s = walk({ x: 0, y: 100, faceRight: false, moving: false }, { x: 200, y: 100 }, 300);
  assert.ok(Math.abs(s.x - (200 - LEAD_BEHIND)) < 1.01, `x ${s.x}`);
  assert.ok(Math.abs(s.y - (100 + LEAD_DROP)) < 1.01);
  assert.equal(s.moving, false);
});

test('on the lead: with slack in the rope it stands still; seated, it waits wherever it is', () => {
  const at: LeadState = { x: 200 - LEAD_BEHIND + LEAD_SLACK - 2, y: 100 + LEAD_DROP, faceRight: true, moving: false };
  assert.deepEqual({ ...leadStep(at, { x: 200, y: 100, faceRight: true, seated: false, dt: 16 }), faceRight: true }, at);
  const far: LeadState = { x: 0, y: 0, faceRight: false, moving: false };
  const waited = leadStep(far, { x: 300, y: 300, faceRight: true, seated: true, dt: 16 });
  assert.equal(waited.x, 0);
  assert.equal(waited.moving, false);
});

test('on the lead: it turns to walk where it goes and catches up when left far behind', () => {
  const s = leadStep({ x: 0, y: 100, faceRight: false, moving: false }, { x: 500, y: 100, faceRight: true, seated: false, dt: 100 });
  assert.equal(s.faceRight, true);
  assert.ok(s.x > 12 * 2, 'faster than its walking pace when far behind');
  const back = leadStep({ x: 500, y: 100, faceRight: true, moving: false }, { x: 0, y: 100, faceRight: false, seated: false, dt: 100 });
  assert.equal(back.faceRight, false);
});

test('the rope sags when slack and straightens at a stretch', () => {
  assert.ok(ropeSag(5) > ropeSag(40));
  assert.equal(ropeSag(1000), 1);
});
