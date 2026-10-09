import test from 'node:test';
import assert from 'node:assert/strict';
import { contextButtons, hideContextButton, hideContextButtons, onContextButtons, pressContextButton, showContextButton } from '../src/game/context-buttons.ts';

const noop = () => {};

test('context buttons: shown in order, replaced in place, hidden by id or prefix', () => {
  hideContextButtons();
  const seen: string[][] = [];
  const stop = onContextButtons((b) => seen.push(b.map((x) => x.id)));
  assert.deepEqual(seen.at(-1), []);

  showContextButton({ id: 'go-home', label: 'Go home', order: 2, press: noop });
  showContextButton({ id: 'saddle', label: 'Ride', order: 1, press: noop });
  showContextButton({ id: 'fish-keep', label: 'Keep', press: noop, size: 'big' });
  assert.deepEqual(contextButtons().map((b) => b.id), ['fish-keep', 'saddle', 'go-home']);

  // Showing an id again replaces it and keeps its place among equals.
  showContextButton({ id: 'fish-release', label: 'Let it go', press: noop });
  showContextButton({ id: 'fish-keep', label: 'Keep it', press: noop });
  assert.deepEqual(contextButtons().map((b) => b.id), ['fish-keep', 'fish-release', 'saddle', 'go-home']);
  assert.equal(contextButtons()[0].label, 'Keep it');

  hideContextButtons('fish-');
  assert.deepEqual(contextButtons().map((b) => b.id), ['saddle', 'go-home']);
  hideContextButton('saddle');
  hideContextButton('saddle');
  assert.deepEqual(seen.at(-1), ['go-home']);

  stop();
  showContextButton({ id: 'x', label: 'X', press: noop });
  assert.deepEqual(seen.at(-1), ['go-home'], 'a stopped listener hears nothing more');
  hideContextButtons();
});

test('context buttons: pressing calls the entry, and says when nothing is up', () => {
  hideContextButtons();
  let n = 0;
  showContextButton({ id: 'saddle', label: 'Ride', press: () => (n += 1) });
  assert.equal(pressContextButton('saddle'), true);
  assert.equal(pressContextButton('go-home'), false);
  assert.equal(n, 1);
  hideContextButtons();
});
