import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeMove, isGoodbye } from '../src/lib/dialogue-escape.ts';

// The owner's playtest: Esc gets you out of any talk, unless it's crucial.
test('Esc: a talk without replies closes, as if read through', () => {
  assert.deepEqual(escapeMove({ choices: null, answered: false }), { kind: 'close' });
  assert.deepEqual(escapeMove({ choices: [], answered: false }), { kind: 'close' });
  // A reply already picked: its words are being read, and closing delivers its action.
  assert.deepEqual(escapeMove({ choices: [{ text: 'Raise a cottage', action: 'home:upgrade' }], answered: true }), { kind: 'close' });
});

test('Esc: with replies on offer it takes the goodbye, flagged or plain', () => {
  const bye = { text: 'Not yet', dismiss: true };
  assert.deepEqual(escapeMove({ choices: [{ text: 'See what you’ve finished', action: 'home:shop' }, bye], answered: false }), { kind: 'goodbye', choice: bye });
  const plain = { text: 'Just passing' };
  assert.deepEqual(escapeMove({ choices: [{ text: 'Share the deed', action: 'home:joint' }, plain], answered: false }), { kind: 'goodbye', choice: plain });
  const leave = { text: 'Be on my way', dismiss: true };
  assert.deepEqual(escapeMove({ choices: [{ text: 'Hear it again', replay: true }, leave], answered: false }), { kind: 'goodbye', choice: leave });
});

test('Esc: a decision with no goodbye stays, and so does a story beat', () => {
  assert.deepEqual(escapeMove({ choices: [{ text: 'Tell him it runs', action: 'a' }, { text: 'Why does it lean?', reply: ['Three fingers off plumb.'] }], answered: false }), { kind: 'stay' });
  assert.deepEqual(escapeMove({ choices: null, answered: false, beat: true }), { kind: 'stay' });
  // "Hear it again" or a greyed-out goodbye is no way out.
  assert.equal(isGoodbye({ text: 'Hear it again', replay: true, dismiss: true }), false);
  assert.equal(isGoodbye({ text: 'Not yet', disabled: true }), false);
  // A goodbye-sounding reply that does something is a choice, not a goodbye.
  assert.equal(isGoodbye({ text: 'Not yet', action: 'quest:later' }), false);
  // A flagged goodbye with words of its own is still the way out (its words are skipped).
  assert.equal(isGoodbye({ text: 'Not yet', reply: ['Keep it safe, then.'], dismiss: true }), true);
});
