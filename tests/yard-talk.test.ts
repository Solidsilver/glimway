import test from 'node:test';
import assert from 'node:assert/strict';
import { MANAGE_DEED, SEE_THE_YARD, YARD_OFFICE, YARD_SHOP, isYardRoom, pellTalk, silasTalk, type PellTalkContext, type SilasTalkContext } from '../src/game/yard-talk.ts';
import { BUILDER_NPC_DATA, SILAS_YARD } from '../src/content/expansion-writing.ts';
import { HEIRLOOM_GUEST_LINES } from '../src/content/heirlooms.ts';
import { PELL, PELL_DEED } from '../src/content/pell.ts';
import { residentById } from '../src/lib/residents.ts';
import { roomFor } from '../src/lib/rooms.ts';

const IDLE = BUILDER_NPC_DATA.dialogue.idleLines[3];
const silas = (over: Partial<SilasTalkContext> = {}): SilasTalkContext => ({
  first: false,
  idle: IDLE,
  connected: true,
  claimed: true,
  axe: null,
  guestAxe: false,
  fox: null,
  ...over,
});
const texts = (d: { choices?: { text: string }[] }) => (d.choices ?? []).map((c) => c.text);

test('Silas: a homeowner gets his line, See the Yard and Just passing, nothing else', () => {
  const d = silasTalk(silas());
  assert.equal(d.speaker, 'Silas');
  assert.deepEqual(d.lines, [IDLE]);
  assert.deepEqual(texts(d), [SILAS_YARD.seeTheYard, SILAS_YARD.justPassing]);
  assert.equal(d.choices![0].action, SEE_THE_YARD);
  assert.equal(d.choices![1].action, undefined, 'the goodbye does nothing');
  assert.equal(d.pointsAtPell, false);
});

test('Silas: the first meeting plays once, in place of his idle line', () => {
  const d = silasTalk(silas({ first: true }));
  assert.deepEqual(d.lines, BUILDER_NPC_DATA.dialogue.firstMeeting.lines);
});

test('Silas: no deed yet, he points at Pell (and so does the guide); guests hear the guest pointer', () => {
  const none = silasTalk(silas({ claimed: false }));
  assert.deepEqual(none.lines, [IDLE, SILAS_YARD.pellPointer]);
  assert.equal(none.pointsAtPell, true);
  assert.deepEqual(texts(none), [SILAS_YARD.seeTheYard, SILAS_YARD.justPassing], 'no deed choices: those are Pell’s');
  const guest = silasTalk(silas({ connected: false, claimed: null }));
  assert.deepEqual(guest.lines, [IDLE, SILAS_YARD.pellPointerGuest]);
  // The plot book not read yet (loading, offline): no pointer, rather than a wrong one.
  const unread = silasTalk(silas({ claimed: null }));
  assert.deepEqual(unread.lines, [IDLE]);
  assert.equal(unread.pointsAtPell, false);
});

test('Silas: the axe only when it applies; offered only when he can hand it over', () => {
  const take = { text: 'Take the Brack felling axe', action: 'heirloom:grant:brack-felling-axe' };
  const ready = silasTalk(silas({ axe: { lines: ['The axe line.'], choice: take } }));
  assert.deepEqual(ready.lines, [IDLE, 'The axe line.']);
  assert.deepEqual(texts(ready), [SILAS_YARD.seeTheYard, take.text, SILAS_YARD.justPassing]);
  // Held back (too far, offline): he says why, and there's no choice.
  const held = silasTalk(silas({ axe: { lines: ['Come round the yard first.'], choice: null } }));
  assert.deepEqual(held.lines, [IDLE, 'Come round the yard first.']);
  assert.deepEqual(texts(held), [SILAS_YARD.seeTheYard, SILAS_YARD.justPassing]);
  // A guest who knows Hollis's name: the axe waits for a world.
  const guest = silasTalk(silas({ connected: false, claimed: null, guestAxe: true }));
  assert.ok(guest.lines.includes(HEIRLOOM_GUEST_LINES.silas));
});

test('Silas: carrying the fox, its line, give it back, and its own Not yet as the one goodbye', () => {
  const give = { text: 'Give it back', reply: ['You hold it out.'], action: 'keep:return:whittled-fox:silas' };
  const notYet = { text: 'Not yet', reply: ['Keep it a while.'] };
  const d = silasTalk(silas({ fox: { line: 'That fox. Hollis carved it.', choices: [give, notYet] } }));
  assert.deepEqual(d.lines, [IDLE, 'That fox. Hollis carved it.']);
  assert.deepEqual(texts(d), [SILAS_YARD.seeTheYard, 'Give it back', 'Not yet']);
  assert.ok(!texts(d).includes(SILAS_YARD.justPassing));
});

test('Silas: nothing about deeds, bundles, building or sharing is in his talk any more', () => {
  const contexts: SilasTalkContext[] = [silas(), silas({ claimed: false }), silas({ connected: false, claimed: null }), silas({ first: true, claimed: false })];
  for (const c of contexts) {
    const d = silasTalk(c);
    for (const ch of d.choices ?? []) {
      assert.doesNotMatch(ch.text, /deed|Raise|workshop|finished|Share|Give up|timber|stone|fiber|Hear it again/i, ch.text);
      assert.ok(!ch.action || ch.action === SEE_THE_YARD || ch.action.startsWith('heirloom:') || ch.action.startsWith('keep:'), String(ch.action));
    }
  }
});

const PELL_IDLE = PELL.idleLines[0];
const pell = (over: Partial<PellTalkContext> = {}): PellTalkContext => ({
  first: false,
  idle: PELL_IDLE,
  status: 'ready',
  claimed: false,
  homeRead: false,
  glims: 0,
  invite: null,
  reclaimable: [],
  unclaimed: [{ gate: 2, price: 0 }, { gate: 0, price: 0 }],
  pitchHeard: true,
  atTable: true,
  ...over,
});

test('Pell: no deed yet, the deeds on offer (the first free) and Not today', () => {
  const d = pellTalk(pell());
  assert.equal(d.speaker, 'Pell');
  assert.deepEqual(d.lines, [PELL_IDLE]);
  assert.deepEqual(texts(d), ['The deed to West Row 2', 'The deed to West Row 1', PELL_DEED.notToday]);
  assert.equal(d.choices![0].note, 'First deed: free');
  assert.equal(d.choices![0].action, 'home:claim:2');
  assert.equal(d.choices!.at(-1)!.action, undefined);
});

test('Pell: a deed you can’t afford shows what it needs and can’t be picked; at most four are offered', () => {
  const d = pellTalk(pell({ glims: 5, unclaimed: [1, 2, 3, 4, 5].map((gate) => ({ gate, price: gate === 1 ? 4 : 10 })) }));
  const deeds = d.choices!.slice(0, -1);
  assert.equal(deeds.length, 4);
  assert.equal(deeds[0].disabled, undefined);
  assert.equal(deeds[0].note, '4 glims');
  assert.equal(deeds[1].disabled, true);
  assert.equal(deeds[1].note, 'Needs 10 glims');
  assert.equal(deeds[1].action, undefined);
});

test('Pell: the first meeting comes with the first deed; the pitch plays once otherwise', () => {
  const first = pellTalk(pell({ first: true, pitchHeard: false }));
  assert.deepEqual(first.lines, PELL.firstMeeting.lines);
  const second = pellTalk(pell({ pitchHeard: false }));
  assert.deepEqual(second.lines, [PELL_IDLE, PELL_DEED.pitch]);
  assert.deepEqual(pellTalk(pell()).lines, [PELL_IDLE]);
});

test('Pell: an invite to sign and old deeds to take back come first, and are news each time', () => {
  const d = pellTalk(pell({ invite: { homeId: 'h1', gate: 4, from: 'Tansy' }, reclaimable: [1, 6, 7] }));
  assert.deepEqual(texts(d), ['Sign Tansy’s deed', 'Take back East Row 1', 'Take back West Row 4', 'The deed to West Row 2', 'The deed to West Row 1', PELL_DEED.notToday]);
  assert.equal(d.choices![0].action, 'home:sign:h1');
  assert.equal(d.choices![0].note, 'West Row 3 · together, at the table');
  assert.equal(d.choices![1].action, 'home:claim:1');
  assert.equal(d.choices![1].note, PELL_DEED.takeBackNote);
  assert.deepEqual(d.lines, [PELL_IDLE, PELL_DEED.invite('Tansy', 'West Row 3')]);
  const back = pellTalk(pell({ reclaimable: [1] }));
  assert.deepEqual(back.lines, [PELL_IDLE, PELL_DEED.takeBackPitch('East Row 1')]);
  // A long name is cut short on the choice.
  assert.equal(pellTalk(pell({ invite: { homeId: 'h1', gate: 4, from: 'Bartholomew Quill' } })).choices![0].text, 'Sign Bartholomew Q…’s deed');
});

test('Pell: the invite is signed only at the deed table; elsewhere it shows, disabled, saying so', () => {
  const away = pellTalk(pell({ atTable: false, invite: { homeId: 'h1', gate: 4, from: 'Tansy' } }));
  assert.equal(away.choices![0].text, 'Sign Tansy’s deed');
  assert.equal(away.choices![0].disabled, true);
  assert.equal(away.choices![0].action, undefined);
  assert.equal(away.choices![0].note, PELL_DEED.standByTable);
  // The deeds for sale don't care where you stand.
  assert.equal(away.choices![1].action, 'home:claim:2');
});

test('Pell: on a deed, Manage your deed and Not today; never the deeds for sale', () => {
  const d = pellTalk(pell({ claimed: true, homeRead: true, invite: { homeId: 'h1', gate: 4, from: 'Tansy' }, reclaimable: [1] }));
  assert.deepEqual(texts(d), [PELL_DEED.manage, PELL_DEED.notToday]);
  assert.equal(d.choices![0].action, MANAGE_DEED);
  assert.deepEqual(d.lines, [PELL_IDLE]);
});

test('Pell: a homeowner’s first talk is a short welcome and an idle line, never the pitch', () => {
  const d = pellTalk(pell({ first: true, pitchHeard: false, claimed: true, homeRead: true }));
  assert.deepEqual(d.lines, [PELL.firstMeetingHomeowner, PELL_IDLE]);
  assert.deepEqual(texts(d), [PELL_DEED.manage, PELL_DEED.notToday]);
  assert.equal(d.met, true);
  assert.ok(!d.lines.some((l) => PELL.firstMeeting.lines.includes(l)));
});

test('Pell: the first meeting waits until the plot book says whether you hold a deed', () => {
  for (const over of [{ status: 'loading' }, { status: 'offline' }, { claimed: true, homeRead: false }] as const) {
    const d = pellTalk(pell({ first: true, ...over }));
    assert.equal(d.met, false, JSON.stringify(over));
    assert.equal(d.lines[0], PELL_IDLE);
  }
  assert.equal(pellTalk(pell({ first: true })).met, true);
  assert.equal(pellTalk(pell({ first: true, status: 'guest' })).met, true);
  assert.equal(pellTalk(pell()).met, false);
});

test('Pell: a guest, a book still loading or out of reach gets the line why, and no choices', () => {
  const guest = pellTalk(pell({ status: 'guest' }));
  assert.deepEqual(guest.lines, [PELL_IDLE, PELL_DEED.guest]);
  assert.equal(guest.choices, undefined);
  assert.equal(guest.needsRead, false);
  const loading = pellTalk(pell({ status: 'loading' }));
  assert.deepEqual(loading.lines, [PELL_IDLE, PELL_DEED.loading]);
  assert.equal(loading.needsRead, false, 'already reading');
  const offline = pellTalk(pell({ status: 'offline' }));
  assert.deepEqual(offline.lines, [PELL_IDLE, PELL_DEED.offline]);
  assert.equal(offline.needsRead, true);
  // On a deed whose page isn't read yet: wait for it (Manage your deed needs it).
  const unread = pellTalk(pell({ claimed: true, homeRead: false }));
  assert.equal(unread.choices, undefined);
  assert.equal(unread.needsRead, true);
});

test('the Yard: the two rooms, Silas at the counter and Pell at the desk', () => {
  assert.ok(isYardRoom(YARD_SHOP) && isYardRoom(YARD_OFFICE));
  assert.ok(!isYardRoom('commons') && !isYardRoom('in:village:bakery') && !isYardRoom('in:home:3'));
  assert.ok(roomFor(YARD_SHOP) && roomFor(YARD_OFFICE));
  assert.equal(residentById('silas')!.spots.counter.area, YARD_SHOP);
  assert.equal(residentById('pell')!.spots.desk.area, YARD_OFFICE);
});
