import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTROLS, TOUCH_CONTROLS } from '../src/content/controls.ts';

test('the controls list names B (arrange your home) and G (emotes)', () => {
  const row = (key: string) => CONTROLS.find((r) => r.keys.includes(key));
  assert.match(row('B')?.does ?? '', /Arrange your home/);
  assert.match(row('G')?.does ?? '', /Emotes/);
  // The whole keyboard surface is there.
  for (const key of ['W', 'E', 'Space', 'F', 'R', 'Shift', 'J', 'C', 'I', 'M', 'H', 'Esc']) assert.ok(row(key), key);
});

test('every control has a touch equivalent (riding has the saddle button now)', () => {
  for (const r of CONTROLS) assert.ok(r.touch && r.touch.length > 0, r.does);
  assert.equal(TOUCH_CONTROLS.length, CONTROLS.length);
  assert.ok(TOUCH_CONTROLS.some((t) => /second ✦/.test(t.control) && /Second move/.test(t.does)));
  assert.ok(TOUCH_CONTROLS.some((t) => /saddle button/.test(t.control) && /Ride/.test(t.does)));
  assert.ok(TOUCH_CONTROLS.some((t) => /Arrange button/.test(t.control) && /Arrange your home/.test(t.does)));
  assert.ok(TOUCH_CONTROLS.some((t) => /speech button/.test(t.control) && /Emotes/.test(t.does)));
  // Touch rows don't talk about keys.
  for (const t of TOUCH_CONTROLS) assert.doesNotMatch(t.does, /arrows work/);
});
