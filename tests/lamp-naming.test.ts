import test from 'node:test';
import assert from 'node:assert/strict';
import { HOMESTEAD_DATA } from '../src/lib/homestead.ts';
import { NAMING_SLOTS, defaultParts, namingChoices, renderNaming } from '../src/lib/lamp-naming.ts';

// What the server offers by a road stone: one place found near it, then the fallbacks.
const landmarks = [
  { id: 'place:1:-1', phrase: 'the standing stone' },
  { id: 'road', phrase: 'the road' },
  { id: 'whitequiet', phrase: 'the Whitequiet' },
];

test('the form’s own naming renders word for word, with its short name', () => {
  const got = renderNaming(['first', 'past', 'whitequiet', 'road', 'place:1:-1', 'hold-fast'], landmarks);
  assert.deepEqual(got, {
    text: 'You are the first lamp past the Whitequiet. Behind you the road; ahead the standing stone. Hold fast.',
    shortName: 'First lamp past the Whitequiet',
  });
});

test('behind and ahead take a side phrase or a landmark on offer; every closing is the design’s', () => {
  const got = renderNaming(['twelfth', 'below', 'place:1:-1', 'home', 'dark', 'weave'], landmarks);
  assert.equal(got?.text, 'You are the twelfth lamp below the standing stone. Behind you home; ahead the dark. Keep the weave tight.');
  assert.equal(got?.shortName, 'Twelfth lamp below the standing stone');
  assert.deepEqual(namingChoices(landmarks).closing.map((c) => c.words), ['Keep the weave tight.', 'Hold fast.', 'Stay.']);
  assert.deepEqual(namingChoices(landmarks).relation.map((c) => c.id), ['past', 'beside', 'above', 'below']);
});

test('no free text: any part not on offer refuses the whole naming', () => {
  const good = ['first', 'past', 'whitequiet', 'road', 'dark', 'stay'];
  assert.ok(renderNaming(good, landmarks));
  for (let i = 0; i < NAMING_SLOTS.length; i++) {
    const bad = [...good];
    bad[i] = 'My own words';
    assert.equal(renderNaming(bad, landmarks), null, NAMING_SLOTS[i]);
  }
  // A landmark the server didn't offer for this lamp, a side used as the landmark, the wrong count.
  assert.equal(renderNaming(['first', 'past', 'place:9:9', 'road', 'dark', 'stay'], landmarks), null);
  assert.equal(renderNaming(['first', 'past', 'dark', 'road', 'dark', 'stay'], landmarks), null);
  assert.equal(renderNaming(good.slice(0, 5), landmarks), null);
});

test('a first pick is a whole naming, behind the road', () => {
  const parts = defaultParts(landmarks);
  assert.equal(parts.length, 6);
  assert.equal(parts[3], 'road');
  assert.notEqual(parts[4], 'road');
  assert.ok(renderNaming(parts, landmarks));
  assert.equal(HOMESTEAD_DATA.lampNaming.ash, 'lamp-ash');
});
