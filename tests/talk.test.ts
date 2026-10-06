import test from 'node:test';
import assert from 'node:assert/strict';
import { GREETINGS, shortTalk, TALK_COPY } from '../src/content/talk.ts';
import { metFlag, RESIDENT_IDS, residentTalk, type ResidentContext } from '../src/content/residents.ts';

const ctx = (over: Partial<ResidentContext> = {}): ResidentContext => ({
  stage: 'new',
  flags: [],
  calendar: null,
  projects: {},
  home: { claimed: false, tier: null, connected: false },
  ...over,
});

test('everyone who talks has a few greetings of their own, one line each', () => {
  for (const id of ['mara', 'pip', 'orrin', ...RESIDENT_IDS]) {
    const lines = GREETINGS[id];
    assert.ok(lines && lines.length >= 3, `${id} has greetings`);
    for (const l of lines) assert.ok(l.length > 0 && l.length <= 160, l);
    assert.equal(new Set(lines).size, lines.length, `${id}'s greetings differ`);
  }
});

test('a short talk: the greeting, anything new, and "Hear it again" with the whole talk', () => {
  const full = ['One.', 'Two.', 'Today’s line.'];
  const plain = shortTalk({ greeting: 'Hello.', fresh: [], full });
  assert.deepEqual(plain.lines, ['Hello.']);
  assert.deepEqual(plain.choices.map((c) => c.text), [TALK_COPY.again, TALK_COPY.leave]);
  assert.deepEqual(plain.choices[0].reply, full);
  assert.equal(plain.choices[0].replay, true);
  assert.equal(plain.choices[1].dismiss, true);

  const fresh = shortTalk({ greeting: 'Hello.', fresh: ['Today’s line.'], full });
  assert.deepEqual(fresh.lines, ['Hello.', 'Today’s line.']);

  // Own choices stay; "Hear it again" goes before the goodbye.
  const own = shortTalk({ greeting: 'Hi.', fresh: [], full, choices: [{ text: 'Buy a loaf', action: 'buy:x' }, { text: 'Not yet' }] });
  assert.deepEqual(own.choices.map((c) => c.text), ['Buy a loaf', TALK_COPY.again, 'Not yet']);
  const noBye = shortTalk({ greeting: 'Hi.', fresh: [], full, choices: [{ text: 'Raise a cottage', action: 'home:upgrade' }] });
  assert.deepEqual(noBye.choices.map((c) => c.text), ['Raise a cottage', TALK_COPY.again]);
});

test('a resident’s talk splits into the story and the line about the day', () => {
  const first = residentTalk('hazel', ctx());
  assert.equal(first.story.key, 'intro');
  const met = [metFlag('hazel', 'new')];
  for (const stage of ['new', 'accepted', 'complete'] as const) {
    const t = residentTalk('hazel', ctx({ stage, flags: met }));
    assert.equal(t.story.key, stage);
    assert.deepEqual([...t.story.lines, ...(t.day ? [t.day.line] : [])], t.dialogue.lines);
  }
});
