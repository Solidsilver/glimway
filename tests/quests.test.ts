import test from 'node:test';
import assert from 'node:assert/strict';
import items from '../content/items.json' with { type: 'json' };
import {
  needsServer,
  fingerInBracken,
  questLine,
  questTitle,
  autoSteps,
  checkGate,
  isDone,
  nextStep,
  parseRef,
  questById,
  QUESTS,
  questStatus,
  reachStep,
  refHolds,
  roadQuest,
  roadStep,
  stepsBy,
  waitOpensAt,
  waitWords,
  type GateContext,
  type QuestRecord,
} from '../src/lib/quests.ts';
import { roomParent, rootArea } from '../src/lib/rooms.ts';
import { residentById } from '../src/lib/residents.ts';
import { cycleAt as cycle } from '../src/lib/clock.ts';

const cycleAt = (id: string, now: number) => cycle(residentById(id)!, now);
import { calendarAt } from '../src/lib/clock.ts';
import { createNewGame } from '../src/lib/state.ts';
import { areaInfo, dialogueFor, dialogueRefs, journalEntries } from '../src/content/world.ts';
import { afterTheirTalk, questMarker, questSpotLabel, questSpotTalk, questTalk, roadGoal, rumourChoice, RUMOUR_ASK, takesTheTalk, type QuestTalkContext } from '../src/content/quests/index.ts';
import { noteAsPaper, questNotes, questShelves } from '../src/ui/quests-page.ts';

/** 2026-10-08 10:00 UTC: a whole hour, so the cycles start here. */
const HOUR = Date.UTC(2026, 9, 8, 10) / 1000;
const DONE_OPENING: QuestRecord = { signpost: 'light-first-lamp' };

function gate(over: Partial<GateContext> = {}): GateContext {
  return { now: HOUR + 10 * 60, area: 'village', glims: 0, carrying: () => 0, gateAt: undefined, online: true, ...over };
}

function talkCtx(quests: QuestRecord, over: Partial<GateContext> = {}, extra: Partial<QuestTalkContext> = {}): QuestTalkContext {
  return { quests, needs: { habitica: false }, gate: () => gate(over), pinned: null, connected: false, ...extra };
}

// ------------------------------------------------------------------ the tree

test('the tree: kebab-case ids, short goals, small glim grants, items that exist', () => {
  const kebab = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
  const known = new Set(items.items.map((i: { id: string }) => i.id));
  const ids = new Set<string>();
  for (const q of QUESTS) {
    assert.match(q.id, kebab);
    assert.ok(!ids.has(q.id), `duplicate quest ${q.id}`);
    ids.add(q.id);
    assert.ok(q.title && q.blurb && q.line, `${q.id} has a title, blurb and line`);
    assert.equal(questTitle(q), q.title);
    assert.ok(['road', 'village', 'craft'].includes(questLine(q)));
    const steps = new Set<string>();
    for (const s of q.steps) {
      assert.match(s.id, kebab, `${q.id}:${s.id}`);
      assert.ok(!steps.has(s.id), `duplicate step ${q.id}:${s.id}`);
      steps.add(s.id);
      assert.ok(s.goal && s.goal.length <= 40, `${q.id}:${s.id} goal "${s.goal}" (${s.goal?.length})`);
      assert.ok(s.glims >= 0 && s.glims <= 5, `${q.id}:${s.id} grants ${s.glims} glims`);
      for (const g of s.give ?? []) assert.ok(known.has(g.def), `${q.id}:${s.id} gives unknown ${g.def}`);
      if (s.gate?.item) assert.ok(known.has(s.gate.item.def), `${q.id}:${s.id} takes unknown ${s.gate.item.def}`);
      // Spots, areas, `with`, `give` and the `world`/`project` refusal are A's loader's checks (src/lib/story-tables.ts).
      assert.ok(s.where || s.do && 'sync' in s.do, `${q.id}:${s.id} has somewhere for the needle (or is done in your own day)`);
    }
    for (const ref of q.after ?? []) assert.ok(ref.includes(':') ? parseRef(ref) : questById(ref), `${q.id} after ${ref}`);
  }
  assert.deepEqual([...ids].sort(), ['a-line-in-the-race', 'lantern-road', 'seat-by-the-lamp', 'set-to-rise', 'signpost', 'stuck-hoist', 'your-own-day']);
});

test('the lantern road keeps 0.3’s step ids and every grant row (028’s gift outcomes read them)', () => {
  const road = questById('lantern-road')!;
  const grants = road.steps.map(({ id, at, items, marks, papers, glims, witness }) => ({ id, at, items, marks, papers, glims, witness }));
  assert.deepEqual(grants, [
    { id: 'accepted', at: 'village', items: [], marks: [], papers: [], glims: 0, witness: '' },
    { id: 'clue-found', at: 'ruin', items: ['lantern-route-rubbing'], marks: ['found:old-route-marker'], papers: [], glims: 0, witness: '' },
    { id: 'guardian-defeated', at: 'ruin', items: ['warden-seal'], marks: ['defeated:stone-warden'], papers: ['eleven-days'], glims: 2, witness: 'warden' },
    { id: 'lantern-lit', at: 'ruin', items: [], marks: ['found:hilltop-lantern'], papers: ['principia-memoria-excerpt'], glims: 0, witness: 'lantern' },
    { id: 'complete', at: 'village', items: [], marks: ['found:lantern-road-restored'], papers: [], glims: 3, witness: '' },
  ]);
  assert.deepEqual(road.after, ['signpost']);
});

test('the Notes: the reached steps’ notes, newest first, read like papers', () => {
  const rec = { ...DONE_OPENING, 'set-to-rise': 'let-it-rise' };
  // Set to Rise reached last: its note comes first, then the opening's, latest step first.
  const notes = questNotes(rec, { signpost: 100, 'set-to-rise': 200 });
  assert.deepEqual(notes.map((n) => n.title), ['Set to Rise', 'The First Lamp', 'In the Ledger', 'Three Fingers off Plumb', 'A Wisp on the Finger']);
  assert.deepEqual(questNotes({ signpost: 'bring-finger' }).map((n) => n.title), ['A Wisp on the Finger']);
  assert.deepEqual(questNotes({}), []);
  const paper = noteAsPaper(notes[0]);
  assert.equal(paper.title, 'Set to Rise');
  assert.equal(paper.style, 'notebook');
  assert.deepEqual(paper.meta, [{ label: 'Quest', value: 'Set to Rise' }]);
  // The journal's own pages don't repeat them.
  assert.ok(!journalEntries(rec).some((e) => notes.some((n) => n.title === e.title && n.body === e.body)));
});

test('a gated step goes to the world and waits; a step with only grants is predicted and queues', () => {
  const rise = questById('set-to-rise')!;
  assert.equal(needsServer(rise.steps.find((s) => s.id === 'set-sponge')!), true);
  assert.equal(needsServer(rise.steps.find((s) => s.id === 'fetch-flour')!), false);
  assert.equal(needsServer({ ...rise.steps[1], give: [{ def: 'flour', qty: 1 }] }), false, 'gate-only');
});

test('a wait always has a gate to count from: a gated step before it, or the quest’s first', () => {
  for (const q of QUESTS) {
    q.steps.forEach((s, i) => {
      if (!s.gate?.wait) return;
      assert.ok(i > 0, `${q.id}:${s.id} waits on its first step`);
    });
  }
});

test('every dialogue rule names a real quest step (or a quest not started)', () => {
  for (const ref of dialogueRefs()) {
    const [quest, step] = [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)];
    assert.ok(step === 'new' ? questById(quest) : parseRef(ref), ref);
  }
});

// ------------------------------------------------------------------ status

test('a new save sees the opening, and nothing else until it’s done', () => {
  const needs = { habitica: false };
  const status = Object.fromEntries(QUESTS.map((q) => [q.id, questStatus(q, {}, needs)]));
  assert.deepEqual(status, { signpost: 'open', 'lantern-road': 'hidden', 'your-own-day': 'hidden', 'set-to-rise': 'hidden', 'stuck-hoist': 'hidden', 'seat-by-the-lamp': 'hidden', 'a-line-in-the-race': 'hidden' });
  assert.equal(nextStep(questById('signpost')!, {})!.id, 'meet-orrin');
});

test('Your Own Day shows locked to a hero without Habitica once Mara has written the opening in', () => {
  const q = questById('your-own-day')!;
  assert.equal(questStatus(q, { signpost: 'set-post' }, { habitica: false }), 'hidden');
  assert.equal(questStatus(q, { signpost: 'see-mara' }, { habitica: false }), 'locked');
  assert.equal(questStatus(q, { signpost: 'see-mara' }, { habitica: true }), 'hidden', 'not come across until Mara’s talk');
  assert.equal(questStatus(q, { signpost: 'see-mara', 'your-own-day': 'hear-mara' }, { habitica: true }), 'open');
  assert.equal(questStatus(q, { signpost: 'see-mara', 'your-own-day': 'show-mara' }, { habitica: true }), 'done');
});

test('refs: a quest is done at its last step; a step ref holds from that step on', () => {
  assert.ok(!refHolds('signpost', { signpost: 'see-mara' }));
  assert.ok(refHolds('signpost', DONE_OPENING));
  assert.ok(refHolds('signpost:see-mara', DONE_OPENING));
  assert.ok(!refHolds('signpost:see-mara', { signpost: 'set-post' }));
  assert.ok(!refHolds('nothing:here', DONE_OPENING));
});

test('the east finger lies in the bracken until the wisp is shooed off it', () => {
  assert.ok(fingerInBracken({}));
  assert.ok(fingerInBracken({ signpost: 'meet-orrin' }));
  assert.ok(!fingerInBracken({ signpost: 'fetch-finger' }));
  assert.ok(!fingerInBracken(DONE_OPENING));
});

test('rooms read as themselves on the HUD and the area card, not as their ids', () => {
  assert.deepEqual(['in:village:bakery', 'in:village:mill', 'in:village:mill:2', 'in:village:library'].map((id) => areaInfo(id).name), ['Hazel’s kitchen', 'Finn’s mill', 'The sack loft', 'The library reading room']);
  for (const id of ['in:village:bakery', 'in:village:mill', 'in:village:mill:2', 'in:village:library']) {
    const card = areaInfo(id);
    assert.ok(card.eyebrow && card.tagline && card.description, id);
    assert.doesNotMatch(card.name, /in:/i);
  }
  assert.equal(areaInfo('in:home:12').name, 'Cottage');
});

test('the road’s goal: the opening, then the lantern road, then wander', () => {
  assert.equal(roadGoal({}).short, 'See what Orrin’s grumbling about');
  assert.equal(roadQuest(DONE_OPENING)!.id, 'lantern-road');
  assert.equal(roadGoal(DONE_OPENING).short, 'Hear Mara out about the road');
  assert.equal(roadGoal({ ...DONE_OPENING, 'lantern-road': 'clue-found' }).short, 'Settle the stone warden');
  assert.match(roadGoal({ ...DONE_OPENING, 'lantern-road': 'complete' }).short, /Wander/);
  assert.equal(roadStep({ quests: {} }), 'new');
  assert.equal(roadStep({ quests: { 'lantern-road': 'lantern-lit' } }), 'lantern-lit');
});

// ------------------------------------------------------------------ prediction

test('reachStep takes only the next step, with its keepsakes, marks and gate time', () => {
  const s0 = createNewGame();
  assert.equal(reachStep(s0, 'signpost', 'fetch-finger', 0), null, 'out of order');
  assert.equal(reachStep(s0, 'nope', 'x', 0), null);
  const s1 = reachStep(s0, 'signpost', 'meet-orrin', 100)!;
  assert.deepEqual(s1.quests, { signpost: 'meet-orrin' });
  assert.deepEqual(s1.questGateAt, { signpost: 100 }, 'a quest’s first step starts its clock');
  assert.equal(reachStep(s1, 'signpost', 'meet-orrin', 0), null, 'never twice');
  const s2 = reachStep(s1, 'signpost', 'fetch-finger', 200)!;
  assert.ok(s2.inventory.includes('east-finger'));
  assert.deepEqual(s2.questGateAt, { signpost: 100 }, 'a plain step leaves the clock');
  assert.deepEqual(s0.quests, {}, 'immutable');

  const road = reachStep(reachStep({ ...s0, quests: DONE_OPENING }, 'lantern-road', 'accepted', 0)!, 'lantern-road', 'clue-found', 0)!;
  assert.ok(road.discoveries.includes('old-route-marker'));
  assert.ok(road.inventory.includes('lantern-route-rubbing'));
});

test('an glims gate spends on the prediction, and a gated step restarts the quest’s clock', () => {
  const s = { ...createNewGame(), glims: 4, xpGlims: 4, quests: { ...DONE_OPENING, 'seat-by-the-lamp': 'browse-shelf' } };
  const lit = reachStep(s, 'seat-by-the-lamp', 'oil-lamp', 500)!;
  assert.equal(lit.glims, 3);
  assert.equal(lit.xpGlims, 3);
  assert.ok(lit.flags.includes('library:lamp'));
  assert.equal(lit.questGateAt?.['seat-by-the-lamp'], 500);
});

// ------------------------------------------------------------------ gates

test('residents keep a 60-minute cycle: Hazel 40 in, 20 out; Finn offset 20', () => {
  assert.equal(cycleAt('hazel', HOUR + 5 * 60)!.spot, 'kitchen');
  assert.equal(cycleAt('hazel', HOUR + 45 * 60)!.spot, 'square');
  assert.equal(cycleAt('finn', HOUR + 10 * 60)!.spot, 'door');
  assert.equal(cycleAt('finn', HOUR + 30 * 60)!.spot, 'stones');
  assert.equal(cycleAt('finn', HOUR + 50 * 60)!.spot, 'loft');
  assert.equal(cycleAt('hazel', HOUR + 5 * 60)!.until, HOUR + 40 * 60);
  assert.equal(roomParent('in:village:mill:2'), 'in:village:mill');
  assert.equal(roomParent('in:village:mill'), 'village');
  assert.equal(rootArea('in:village:mill:2'), 'village');
  assert.equal(rootArea('in:home:12'), 'home:12');
});

test('with: you’re where they are near now, with the grace either side of a change', () => {
  const step = questById('set-to-rise')!.steps[0];
  assert.deepEqual(checkGate(step, gate({ area: 'in:village:bakery' })), { ok: true });
  assert.deepEqual(checkGate(step, gate({ area: 'village' })), { ok: false, why: 'not-here' });
  // 39:30, she's about to step out: both places count.
  const edge = HOUR + 39 * 60 + 30;
  assert.ok(checkGate(step, gate({ now: edge, area: 'village' })).ok);
  assert.ok(checkGate(step, gate({ now: edge, area: 'in:village:bakery' })).ok);
});

test('gates in the server’s order: with, wait, item, glims, then the connection', () => {
  const rise = questById('set-to-rise')!;
  const setSponge = rise.steps[2];
  const inKitchen = { area: 'in:village:bakery' };
  assert.deepEqual(checkGate(setSponge, gate(inKitchen)), { ok: false, why: 'short', def: 'flour', need: 1 });
  assert.deepEqual(checkGate(setSponge, gate({ ...inKitchen, carrying: (d) => (d === 'flour' ? 1 : 0) })), { ok: true });
  assert.deepEqual(checkGate(setSponge, gate({ ...inKitchen, carrying: () => 1, online: false })), { ok: false, why: 'needs-connection' });
  assert.deepEqual(checkGate(setSponge, gate({ area: 'village', online: false })), { ok: false, why: 'not-here' }, 'with first');

  const rise2 = rise.steps[3];
  const setAt = HOUR;
  assert.deepEqual(checkGate(rise2, gate({ ...inKitchen, gateAt: setAt, now: HOUR + 30 * 60 })), { ok: false, why: 'not-yet', opensAt: HOUR + 2 * 3600 });
  assert.ok(checkGate(rise2, gate({ ...inKitchen, gateAt: setAt, now: HOUR + 2 * 3600 + 10 * 60 })).ok);
  assert.ok(checkGate(rise2, gate({ ...inKitchen, gateAt: undefined })).ok, 'no gate time known: the server decides');

  const lamp = questById('seat-by-the-lamp')!.steps[2];
  assert.deepEqual(checkGate(lamp, gate({ area: 'in:village:library' })), { ok: false, why: 'short-glims', need: 1 });
  assert.ok(checkGate(lamp, gate({ area: 'in:village:library', glims: 1 })).ok);
});

test('waits in words, and turnings by the calendar', () => {
  assert.equal(waitWords(HOUR + 80 * 60, HOUR), 'about 1 h 20 m');
  assert.equal(waitWords(HOUR + 2 * 3600, HOUR), 'about 2 h');
  assert.equal(waitWords(HOUR + 25 * 60, HOUR), 'about 25 m');
  assert.equal(waitWords(HOUR + 3 * 60, HOUR), 'a few minutes');
  assert.equal(waitWords(0, HOUR, { turnings: 1 }), 'after the turning');
  assert.equal(waitOpensAt({ hours: 2 }, HOUR), HOUR + 7200);
  assert.equal(waitOpensAt({ turnings: 1 }, HOUR), calendarAt(HOUR).nextTurning);
});

// ------------------------------------------------------------------ triggers

test('automatic triggers: carrying flour, walking into the library, a lit lamp, a settled wisp', () => {
  const needs = { habitica: false };
  const ctx = { area: 'village', flags: [] as string[], defeated: [] as string[], carrying: () => 0 };
  assert.deepEqual(autoSteps({}, needs, ctx), []);
  assert.deepEqual(autoSteps({ signpost: 'meet-orrin' }, needs, { ...ctx, area: 'woodland', defeated: ['finger-wisp'] }), [{ quest: 'signpost', step: 'fetch-finger' }]);
  // A step `at` the woodland waits there: the world would refuse it in the village.
  assert.deepEqual(autoSteps({ signpost: 'meet-orrin' }, needs, { ...ctx, defeated: ['finger-wisp'] }), []);
  assert.deepEqual(autoSteps({ signpost: 'see-mara' }, needs, { ...ctx, flags: ['lit:road-1'] }), [{ quest: 'signpost', step: 'light-first-lamp' }]);
  // The library starts itself, but only after the opening.
  assert.deepEqual(autoSteps({ signpost: 'see-mara' }, needs, { ...ctx, area: 'in:village:library' }), []);
  assert.deepEqual(autoSteps(DONE_OPENING, needs, { ...ctx, area: 'in:village:library' }), [{ quest: 'seat-by-the-lamp', step: 'find-library' }]);
  // Flour in the pack: only once Hazel has asked.
  const flour = { ...ctx, carrying: (d: string) => (d === 'flour' ? 1 : 0) };
  assert.deepEqual(autoSteps(DONE_OPENING, needs, flour), []);
  assert.deepEqual(autoSteps({ ...DONE_OPENING, 'set-to-rise': 'hear-hazel' }, needs, flour), [{ quest: 'set-to-rise', step: 'fetch-flour' }]);
});

test('a talk takes the road’s step first, then the tree’s order', () => {
  const both = { ...DONE_OPENING, 'lantern-road': 'lantern-lit', 'your-own-day': 'do-something' };
  assert.deepEqual(stepsBy('talk', 'mara', both, { habitica: true }).map((x) => x.quest.id), ['lantern-road', 'your-own-day']);
  const later = { ...both, 'your-own-day': 'hear-mara' };
  assert.deepEqual(stepsBy('sync', 'glims', later, { habitica: true }).map((x) => x.step.id), ['do-something']);
  assert.deepEqual(stepsBy('sync', 'glims', later, { habitica: false }), [], 'needs habitica');
});

// ------------------------------------------------------------------ talks

test('the opening: Orrin’s talk takes meet-orrin; Mara points at him until the post is set', () => {
  const d = questTalk('orrin', talkCtx({}))!;
  assert.equal(d.event, 'signpost:meet-orrin');
  assert.equal(d.choices?.length, 2);
  assert.equal(questTalk('mara', talkCtx({})), null, 'Mara has no step yet');
  assert.equal(dialogueFor('mara', {}).event, undefined);
  assert.match(dialogueFor('mara', {}).lines.join(' '), /Orrin/);
  assert.equal(questTalk('mara', talkCtx({ signpost: 'set-post' }))!.event, 'signpost:see-mara');
  assert.match(dialogueFor('mara', { signpost: 'see-mara' }).lines.join(' '), /east gate/);
  assert.equal(dialogueFor('mara', DONE_OPENING).event, 'accept', 'then the lantern road');
  assert.equal(dialogueFor('mara', { ...DONE_OPENING, 'lantern-road': 'accepted' }).event, undefined);
  // Mara’s own-day line is for connected heroes.
  const connected = questTalk('mara', talkCtx({ signpost: 'set-post' }, {}, { connected: true }))!.lines.join(' ');
  assert.match(connected, /your own day/);
  assert.doesNotMatch(questTalk('mara', talkCtx({ signpost: 'set-post' }))!.lines.join(' '), /your own day/);
});

test('Set to Rise: Hazel asks; the offer is disabled with why; "not yet" says the wait in her words', () => {
  const kitchen = { area: 'in:village:bakery' };
  const start = questTalk('hazel', talkCtx(DONE_OPENING, kitchen))!;
  assert.equal(start.choices?.[0].action, 'quest:set-to-rise:hear-hazel');
  assert.equal(questTalk('hazel', talkCtx(DONE_OPENING, { area: 'village' })), null, 'not with her: her usual talk');
  assert.equal(questTalk('hazel', talkCtx({ signpost: 'see-mara' }, kitchen)), null, 'not before the opening is done');

  const asked = { ...DONE_OPENING, 'set-to-rise': 'fetch-flour' };
  const short = questTalk('hazel', talkCtx(asked, kitchen))!;
  assert.deepEqual(short.choices?.[0], { text: 'Set the sponge with her', note: 'Needs 1 flour', disabled: true });
  const ready = questTalk('hazel', talkCtx(asked, { ...kitchen, carrying: () => 1 }))!;
  assert.equal(ready.choices?.[0].action, 'quest:set-to-rise:set-sponge');
  assert.equal(ready.choices?.[0].note, '1 flour');
  const offline = questTalk('hazel', talkCtx(asked, { ...kitchen, carrying: () => 1, online: false }))!;
  assert.deepEqual(offline.choices?.[0], { text: 'Set the sponge with her', note: 'Needs a connection', disabled: true });

  const set = { ...DONE_OPENING, 'set-to-rise': 'set-sponge' };
  const early = questTalk('hazel', talkCtx(set, { ...kitchen, gateAt: HOUR, now: HOUR + 30 * 60 }))!;
  assert.equal(early.event, undefined);
  assert.equal(early.choices, undefined);
  assert.match(early.lines.join(' '), /Not yet.*about 1 h 30 m/);
  assert.equal(questTalk('hazel', talkCtx(set, { ...kitchen, gateAt: HOUR, now: HOUR + 50 * 60 })), null, 'out in the square: not with her in the kitchen');
  const risen = questTalk('hazel', talkCtx(set, { ...kitchen, gateAt: HOUR, now: HOUR + 2 * 3600 + 60 }))!;
  assert.equal(risen.choices?.[0].action, 'quest:set-to-rise:let-it-rise');
  assert.equal(questMarker('hazel', talkCtx(set, { ...kitchen, gateAt: HOUR, now: HOUR + 2 * 3600 + 60 })), 'quest');
  assert.equal(questMarker('hazel', talkCtx(set, { ...kitchen, gateAt: HOUR, now: HOUR + 30 * 60 })), null);
});

test('who speaks first: the main story, or a step you’re mid-way through there; anything else after their own lines', () => {
  const kitchen = { area: 'in:village:bakery' };
  // The opening's step takes Orrin's talk.
  assert.ok(takesTheTalk(questTalk('orrin', talkCtx({}))!, talkCtx({})));
  // A quest's start follows the resident's own talk.
  const start = questTalk('hazel', talkCtx(DONE_OPENING, kitchen))!;
  assert.ok(!takesTheTalk(start, talkCtx(DONE_OPENING, kitchen)));
  // Mid-quest, but not ready (no flour; the sponge still thinking): after their own lines.
  const asked = { ...DONE_OPENING, 'lantern-road': 'complete', 'set-to-rise': 'fetch-flour' };
  assert.ok(!takesTheTalk(questTalk('hazel', talkCtx(asked, kitchen))!, talkCtx(asked, kitchen)));
  const set = { ...DONE_OPENING, 'set-to-rise': 'set-sponge' };
  const thinking = { ...kitchen, gateAt: HOUR, now: HOUR + 30 * 60 };
  assert.ok(!takesTheTalk(questTalk('hazel', talkCtx(set, thinking))!, talkCtx(set, thinking)));
  // Mid-way and ready (the flour in the pack, the sponge risen): the step is the talk.
  const flour = { ...kitchen, carrying: () => 1 };
  assert.ok(takesTheTalk(questTalk('hazel', talkCtx(asked, flour))!, talkCtx(asked, flour)));
  const risen = { ...kitchen, gateAt: HOUR, now: HOUR + 2 * 3600 + 60 };
  assert.ok(takesTheTalk(questTalk('hazel', talkCtx(set, risen))!, talkCtx(set, risen)));
  // Your Own Day's start follows Mara's road lines.
  const yod = talkCtx({ ...DONE_OPENING, 'lantern-road': 'accepted' }, {}, { needs: { habitica: true } });
  assert.ok(!takesTheTalk(questTalk('mara', yod)!, yod));

  const own = { speaker: 'Hazel', lines: ['Joss liked the ends burnt.'], choices: [{ text: 'Hear it again', replay: true }, { text: 'Be on my way', dismiss: true }] };
  const d = afterTheirTalk(own, start);
  assert.deepEqual(d.lines, ['Joss liked the ends burnt.', ...start.lines]);
  assert.deepEqual(d.choices!.map((c) => c.text), ['I’ll fetch you some flour.', 'Hear it again', 'Not yet']);
  assert.equal(d.choices![0].action, 'quest:set-to-rise:hear-hazel');
  assert.equal(d.speaker, 'Hazel');
  // A reminder that can't be taken keeps its disabled offer, after her lines.
  const reminder = afterTheirTalk(own, questTalk('hazel', talkCtx(asked, kitchen))!);
  assert.match(reminder.lines.join(' '), /Joss liked the ends burnt\. Still no flour/);
  assert.deepEqual(reminder.choices![0], { text: 'Set the sponge with her', note: 'Needs 1 flour', disabled: true });
});

test('the sponge bowl shows the wait; room spots take their steps', () => {
  const kitchen = { area: 'in:village:bakery' };
  assert.match(questSpotTalk('sponge-bowl', talkCtx(DONE_OPENING, kitchen))!.lines[0], /Empty/);
  const set = { ...DONE_OPENING, 'set-to-rise': 'set-sponge' };
  assert.match(questSpotTalk('sponge-bowl', talkCtx(set, { ...kitchen, gateAt: HOUR, now: HOUR + 30 * 60 }))!.lines[0], /about 1 h 30 m/);
  assert.match(questSpotTalk('sponge-bowl', talkCtx(set, { ...kitchen, gateAt: HOUR, now: HOUR + 3 * 3600 }))!.lines[0], /risen/);
  assert.equal(questSpotLabel('sponge-bowl', talkCtx(set)), 'Look in the bowl');

  const loft = { area: 'in:village:mill:2' };
  const hoist = { ...DONE_OPENING, 'stuck-hoist': 'hear-finn' };
  assert.equal(questSpotTalk('mill-hoist', talkCtx(hoist, loft))!.event, 'stuck-hoist:look-hoist');
  assert.equal(questSpotLabel('mill-hoist', talkCtx(hoist, loft)), 'Look at the hoist in the sack loft');
  const tallow = { ...DONE_OPENING, 'stuck-hoist': 'get-tallow' };
  assert.equal(questSpotTalk('mill-hoist', talkCtx(tallow, loft))!.choices?.[0].note, 'Needs 1 tallow');

  const lib = { area: 'in:village:library' };
  const browsed = { ...DONE_OPENING, 'seat-by-the-lamp': 'browse-shelf' };
  assert.equal(questSpotLabel('reading-lamp', talkCtx(browsed, lib)), 'Oil the reading lamp · 1 glim');
  assert.equal(questSpotTalk('reading-lamp', talkCtx(browsed, lib))!.choices?.[0].note, 'Needs 1 glim');
  assert.equal(questSpotTalk('reading-lamp', talkCtx(browsed, { ...lib, glims: 2 }))!.choices?.[0].action, 'quest:seat-by-the-lamp:oil-lamp');
  assert.equal(questSpotTalk('reading-lamp', talkCtx({ ...DONE_OPENING, 'seat-by-the-lamp': 'oil-lamp' }, lib))!.speaker, 'Reading Lamp');
  assert.equal(questSpotTalk('library-shelf', talkCtx({}, lib)), null, 'no step: the shelf opens the library');
});

test('rumours: a resident names an open quest you haven’t pinned, never their own', () => {
  const rec = { ...DONE_OPENING, 'stuck-hoist': 'look-hoist' };
  const r = rumourChoice('elara', talkCtx(rec))!;
  assert.equal(r.text, RUMOUR_ASK);
  assert.equal(r.replay, true);
  assert.match(r.reply![0], /get a lump of tallow from Hazel/);
  assert.equal(rumourChoice('finn', talkCtx(rec)), null, 'Finn’s own errand');
  assert.equal(rumourChoice('hazel', talkCtx(rec)), null, 'the step is about Hazel');
  assert.equal(rumourChoice('elara', talkCtx(rec, {}, { pinned: 'quest:stuck-hoist' })), null, 'pinned already leads');
  assert.equal(rumourChoice('mara', talkCtx(rec)), null, 'residents only');
  assert.equal(rumourChoice('elara', talkCtx(DONE_OPENING)), null, 'nothing open');
});

test('every quest talk fits the box and stays in-world', async () => {
  const OUT_OF_WORLD = /\b(habitica|xp|habits?|tasks?|to-?dos?|dailies|streaks?|app)\b/i;
  const mods = await Promise.all(['signpost', 'set-to-rise', 'stuck-hoist', 'seat-by-the-lamp', 'your-own-day', 'a-line-in-the-race'].map((f) => import(`../src/content/quests/${f}.ts`)));
  const lines: string[] = [];
  for (const m of mods) {
    for (const v of Object.values(m)) {
      if (!v || typeof v !== 'object') continue;
      for (const talk of Object.values(v as Record<string, unknown>)) {
        const t = talk as { lines?: unknown; offer?: { text: string; reply?: string[] }; short?: string[]; notYet?: (w: string) => string[]; choices?: { text: string; reply?: string[] }[] };
        if (!t || typeof t !== 'object' || !('speaker' in t)) continue;
        const ls = typeof t.lines === 'function' ? [...t.lines({ connected: true }), ...t.lines({ connected: false })] : (t.lines as string[]);
        lines.push(...ls, ...(t.short ?? []), ...(t.notYet ? t.notYet('about 1 h 20 m') : []));
        if (t.offer) lines.push(t.offer.text, ...(t.offer.reply ?? []));
        for (const c of t.choices ?? []) lines.push(c.text, ...(c.reply ?? []));
      }
    }
  }
  assert.ok(lines.length > 40);
  for (const l of lines) {
    assert.ok(l.length <= 160, `${l.length} chars: ${l}`);
    assert.doesNotMatch(l, OUT_OF_WORLD, l);
  }
});

// ------------------------------------------------------------------ the page

test('the Quests page: shelves by line, the next step, ticks, no spoilers, done folded', () => {
  const needs = { habitica: false };
  const page = (rec: QuestRecord, over: Partial<GateContext> = {}, pinned: string | null = null, focus: string | null = null) =>
    questShelves(rec, { needs, gate: () => gate(over), pinned, focus });

  const fresh = page({});
  assert.deepEqual(fresh.map((s) => s.line), ['road']);
  assert.equal(fresh[0].open[0].id, 'signpost');
  assert.equal(fresh[0].open[0].goal, 'See what Orrin’s grumbling about');
  assert.deepEqual(fresh[0].open[0].reached, []);
  assert.equal(fresh[0].open[0].later, 6);

  const mid = page({ signpost: 'bring-finger' }, {}, null, 'signpost')[0].open[0];
  assert.deepEqual(mid.reached, ['See what Orrin’s grumbling about', 'Find the signpost’s east finger', 'Take the finger back to Orrin']);
  assert.equal(mid.goal, 'Write the lean in your journal');
  assert.equal(mid.later, 3);

  // After the opening: the lantern road isn't listed until Mara asks; the opening folds.
  const after = page({ ...DONE_OPENING, 'set-to-rise': 'set-sponge' }, { gateAt: HOUR, now: HOUR + 40 * 60 }, 'quest:set-to-rise');
  assert.deepEqual(after.map((s) => s.line), ['road', 'village']);
  assert.deepEqual(after[0].open, []);
  assert.deepEqual(after[0].done.map((c) => c.id), ['signpost']);
  const rise = after[1].open.find((c) => c.id === 'set-to-rise')!;
  assert.equal(rise.wait, 'ready in about 1 h 20 m');
  assert.equal(rise.pinned, true);
  assert.equal(rise.later, 0);
  assert.equal(page({ ...DONE_OPENING, 'set-to-rise': 'set-sponge' }, { gateAt: HOUR, now: HOUR + 3 * 3600 })[1].open.find((c) => c.id === 'set-to-rise')!.wait, 'ready now');

  // A guest past Mara’s ledger sees Your Own Day locked, with how to take it.
  const locked = page({ signpost: 'see-mara' })[1].open.find((c) => c.id === 'your-own-day')!;
  assert.equal(locked.status, 'locked');
  assert.match(locked.locked!, /Connect Habitica in the Menu/);
  assert.ok(!page({}).some((s) => s.line === 'craft'), 'Crafts stays hidden while empty');
  assert.ok(isDone(questById('signpost')!, DONE_OPENING));
});

// ------------------------------------------------------------------ A Line in the Race (crafts.md 5.8)

test('A Line in the Race: Finn’s rod, a roach from the race, Hazel’s card, on the Crafts shelf', () => {
  const q = questById('a-line-in-the-race')!;
  assert.equal(questLine(q), 'craft');
  assert.deepEqual(q.after, ['signpost']);
  assert.deepEqual(q.steps.map((s) => s.id), ['hear-finn-line', 'first-catch', 'show-hazel']);
  assert.deepEqual(q.steps[0].give, [{ def: 'willow-rod', qty: 1 }]);
  assert.deepEqual(q.steps[2].gate?.item, { def: 'mill-roach', qty: 1, keep: false });
  assert.deepEqual(q.steps[2].give, [{ def: 'recipe-card-millers-fry', qty: 1 }]);
  assert.equal(q.steps[2].glims, 1);
  assert.equal(q.steps[2].note?.title, 'Miller’s Fry');

  // Hidden until Finn starts it; the hoist comes first at his door while it's open.
  assert.equal(questStatus(q, DONE_OPENING, { habitica: false }), 'hidden');
  assert.equal(questTalk('finn', talkCtx(DONE_OPENING))!.key, 'quest:stuck-hoist:hear-finn');
  const hoisted = { ...DONE_OPENING, 'stuck-hoist': 'tell-finn' };
  const finn = questTalk('finn', talkCtx(hoisted))!;
  assert.equal(finn.speaker, 'Finn');
  assert.match(finn.lines.join(' '), /rod on the hook by my door/);
  assert.equal(finn.choices![0].action, 'quest:a-line-in-the-race:hear-finn-line');

  // The roach in the pack takes the carry step on its own.
  const out = { ...hoisted, 'a-line-in-the-race': 'hear-finn-line' };
  const ctx = { area: 'village', flags: [] as string[], defeated: [] as string[], carrying: (d: string) => (d === 'mill-roach' ? 1 : 0) };
  assert.deepEqual(autoSteps(out, { habitica: false }, ctx).map((a) => `${a.quest}:${a.step}`), ['a-line-in-the-race:first-catch']);
  assert.deepEqual(autoSteps(out, { habitica: false }, { ...ctx, carrying: () => 0 }), []);

  // Hazel wants the roach: shown disabled without one, taken with it.
  const caught = { ...hoisted, 'a-line-in-the-race': 'first-catch' };
  const kitchen = { area: 'in:village:bakery', now: HOUR + 10 * 60 };
  const short = questTalk('hazel', talkCtx(caught, kitchen))!;
  assert.deepEqual(short.choices![0], { text: 'Show her the roach', note: 'Needs 1 mill roach', disabled: true });
  const ready = questTalk('hazel', talkCtx(caught, { ...kitchen, carrying: () => 1 }))!;
  assert.equal(ready.choices![0].action, 'quest:a-line-in-the-race:show-hazel');

  // The Crafts shelf shows once it's started, after the road and the village.
  const shelves = questShelves(out, { needs: { habitica: false }, gate: () => gate(), pinned: null });
  assert.deepEqual(shelves.map((s) => s.line), ['road', 'village', 'craft']);
  assert.equal(shelves[2].title, 'Crafts');
  assert.equal(shelves[2].open[0].goal, 'Catch a roach from the mill race');
});

test('who Mara speaks for: the road keeps its own rules, so the new order never moves her quest talk', () => {
  const connected = { needs: { habitica: true } };
  // The lantern road's talks are dialogue rules (src/content/world.ts), not step talks: they
  // never reach triggerTalk. Mara's quest talk is Your Own Day's, road started or not.
  assert.equal(questTalk('mara', talkCtx(DONE_OPENING, {}, connected))!.key, 'quest:your-own-day:hear-mara');
  const roadOn = { ...DONE_OPENING, 'lantern-road': 'accepted' };
  assert.equal(questTalk('mara', talkCtx(roadOn, {}, connected))!.key, 'quest:your-own-day:hear-mara');
  const shown = { ...DONE_OPENING, 'your-own-day': 'do-something' };
  assert.equal(questTalk('mara', talkCtx(shown, {}, connected))!.key, 'quest:your-own-day:show-mara');
  assert.equal(questTalk('mara', talkCtx({ ...shown, 'lantern-road': 'lantern-lit' }, {}, connected))!.key, 'quest:your-own-day:show-mara');
  // Without Habitica, Mara has no quest talk at all: the road speaks through its rules.
  assert.equal(questTalk('mara', talkCtx(DONE_OPENING)), null);
});
