import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_CHARACTER,
  dialogueFor,
  discoveryInfo,
  itemInfo,
  journalEntries,
  locations,
} from '../src/content/world.ts';
import {
  createNewGame,
  QUEST_STAGES,
  validateSave,
  type QuestStage,
} from '../src/lib/state.ts';
import { questById, roadStep, type QuestRecord } from '../src/lib/quests.ts';
import { road } from './helpers/quests.ts';

/** The lantern road at `stage`, after the opening (the record the rules read). */
const R = (stage: QuestStage): QuestRecord => (stage === 'new' ? { signpost: 'light-first-lamp' } : { signpost: 'light-first-lamp', 'lantern-road': stage });
const objective = (stage: QuestStage) => {
  const q = questById('lantern-road')!;
  const i = stage === 'new' ? 0 : q.steps.findIndex((s) => s.id === stage) + 1;
  return q.steps[i]?.objective ?? '';
};
const LABELS = questById('lantern-road')!.steps.map((s) => s.goal!);
import { allResidentJournal, allResidentLines } from '../src/content/residents.ts';
import { allTalkLines } from '../src/content/talk.ts';
import { allHeirloomJournal, allHeirloomLines } from '../src/content/heirlooms.ts';
import { allEchoKeepsakeJournal, allEchoKeepsakeLines } from '../src/content/echoes.ts';

const NPC_IDS = ['mara', 'pip', 'orrin', 'clue', 'lantern'];

test('NPC ids match the runtime contract exactly', () => {
  for (const id of NPC_IDS) {
    const dialogue = dialogueFor(id, R('new'));
    assert.equal(typeof dialogue.speaker, 'string');
    assert.ok(dialogue.speaker.length > 0);
    assert.ok(dialogue.lines.length > 0);
    for (const line of dialogue.lines) {
      assert.equal(typeof line, 'string');
      assert.ok(line.length > 0);
    }
  }
  assert.throws(() => dialogueFor('guardian', R('new')), /Unknown NPC id/);
  assert.throws(() => dialogueFor('stranger', R('complete')), /Unknown NPC id/);
});

test('every NPC has dialogue at every quest stage', () => {
  for (const id of NPC_IDS) {
    for (const stage of QUEST_STAGES) {
      const dialogue = dialogueFor(id, R(stage));
      assert.ok(dialogue.lines.length > 0, `${id}@${stage} has no lines`);
    }
  }
});

test('dialogue events fire the legal quest transitions at the right moments', () => {
  const expected: Partial<Record<QuestStage, string>> = {
    new: 'accept',
    accepted: 'find-clue',
    'guardian-defeated': 'light-lantern',
    'lantern-lit': 'return-village',
  };

  for (const id of NPC_IDS) {
    for (const stage of QUEST_STAGES) {
      const dialogue = dialogueFor(id, R(stage));
      const wanted = expected[stage];
      if (dialogue.event) {
        assert.equal(
          dialogue.event,
          wanted,
          `${id}@${stage} fires ${dialogue.event}, expected ${wanted ?? 'no event'}`,
        );
      }
    }
  }

  assert.equal(dialogueFor('mara', R('new')).event, 'accept');
  assert.equal(dialogueFor('clue', R('accepted')).event, 'find-clue');
  assert.equal(dialogueFor('lantern', R('guardian-defeated')).event, 'light-lantern');
  assert.equal(dialogueFor('mara', R('lantern-lit')).event, 'return-village');
});

test('no dialogue owns defeat-guardian; it belongs to runtime encounters', () => {
  for (const id of NPC_IDS) {
    for (const stage of QUEST_STAGES) {
      const dialogue = dialogueFor(id, R(stage));
      assert.notEqual(dialogue.event, 'defeat-guardian', `${id}@${stage}`);
    }
  }
});

test('completed-stage dialogue never re-fires quest events', () => {
  for (const id of NPC_IDS) {
    const dialogue = dialogueFor(id, R('complete'));
    assert.equal(dialogue.event, undefined);
  }
});

test('dialogue events apply cleanly through the quest machine', () => {
  let state: ReturnType<typeof createNewGame> = { ...createNewGame(), quests: { signpost: 'light-first-lamp' } };
  const dialogueSteps: Array<{ npc: string; stage: QuestStage }> = [
    { npc: 'mara', stage: 'new' },
    { npc: 'clue', stage: 'accepted' },
    { npc: 'lantern', stage: 'guardian-defeated' },
    { npc: 'mara', stage: 'lantern-lit' },
  ];
  for (const step of dialogueSteps) {
    const dialogue = dialogueFor(step.npc, R(step.stage));
    assert.equal(roadStep(state), step.stage);
    assert.ok(dialogue.event, `${step.npc}@${step.stage} should carry an event`);
    state = road(state, dialogue.event! as never);
    if (roadStep(state) === 'clue-found') {
      state = road(state, 'defeat-guardian');
    }
    validateSave(state);
  }
  assert.equal(roadStep(state), 'complete');
});

test('journal entries accumulate as the quest advances', () => {
  const start = journalEntries(R('new'));
  const accepted = journalEntries(R('accepted'));
  const clue = journalEntries(R('clue-found'));
  const guardian = journalEntries(R('guardian-defeated'));
  const lit = journalEntries(R('lantern-lit'));
  const done = journalEntries(R('complete'));

  assert.ok(start.length >= 1);
  assert.ok(accepted.length > start.length);
  assert.ok(clue.length > accepted.length);
  assert.ok(guardian.length > clue.length);
  assert.ok(lit.length > guardian.length);
  assert.ok(done.length > lit.length);

  for (let i = 0; i < start.length; i += 1) {
    assert.deepEqual(start[i], accepted[i], 'early entries must stay stable');
    assert.deepEqual(start[i], done[i], 'early entries must stay stable');
  }

  const seen = new Set<string>();
  for (const entry of done) {
    assert.ok(entry.title.length > 0);
    assert.ok(entry.body.length > 20);
    assert.ok(!seen.has(entry.title), `duplicate journal title ${entry.title}`);
    seen.add(entry.title);
  }

});

test('journal and dialogue are pure (no shared mutable arrays)', () => {
  const a = dialogueFor('mara', R('new'));
  a.lines.push('mutated');
  const b = dialogueFor('mara', R('new'));
  assert.ok(!b.lines.includes('mutated'));

  const j1 = journalEntries(R('new'));
  j1.push({ title: 'x', body: 'y' });
  assert.notEqual(journalEntries(R('new')).length, j1.length);
});

test('locations cover the three quest areas and the Commons, with names and descriptions', () => {
  assert.deepEqual(Object.keys(locations).sort(), ['commons', 'ruin', 'village', 'woodland']);
  for (const [area, info] of Object.entries(locations)) {
    assert.ok(info.name.length > 0, `${area} needs a name`);
    assert.ok(info.description.length > 30, `${area} description too short`);
  }
});

test('DEMO_CHARACTER has the contract shape', () => {
  assert.equal(typeof DEMO_CHARACTER.name, 'string');
  assert.equal(typeof DEMO_CHARACTER.class, 'string');
  assert.equal(typeof DEMO_CHARACTER.level, 'number');
  for (const key of ['str', 'int', 'con', 'per'] as const) {
    assert.equal(typeof DEMO_CHARACTER.stats[key], 'number');
    assert.ok(Number.isFinite(DEMO_CHARACTER.stats[key]));
    assert.ok(DEMO_CHARACTER.stats[key] > 0);
  }
});

/** Story text stays in-world: embers and warmth, never real-life apps or tallies. */
const OUT_OF_WORLD = /\b(habitica|xp|habits?|tasks?|to-?dos?|dailies|streaks?|app)\b/i;

test('story dialogue lines fit the box (160 characters) and stay in-world', async () => {
  const expansion = await import('../src/content/expansion-writing.ts');
  // The world touches (flowers, benches, signs) read as lines too.
  const touches = await import('../src/content/touches.ts');
  const lines: string[] = [
    ...touches.FLOWER_LINES,
    ...touches.SIT_LINES,
    ...Object.values(touches.SIGN_COPY).flatMap((s) => s.lines),
  ];
  for (const id of NPC_IDS) {
    for (const stage of QUEST_STAGES) {
      const d = dialogueFor(id, R(stage));
      lines.push(...d.lines);
      for (const c of d.choices ?? []) lines.push(c.text, ...(c.reply ?? []));
    }
  }
  const builder = expansion.BUILDER_NPC_DATA.dialogue;
  for (const d of [builder.firstMeeting, builder.offerCampsite, builder.sellDecorations, builder.notEnoughEmbers, builder.afterUpgrade]) {
    lines.push(...d.lines);
  }
  lines.push(...builder.idleLines, ...Object.values(expansion.NEW_NPC_LINES).flat());
  // The residents (Elara, Finn, Hazel, Ada): every line they can say.
  lines.push(...allResidentLines());
  // Greetings and the short talk's choices (src/content/talk.ts).
  lines.push(...allTalkLines());
  // The heirlooms (Silas, Orrin, Ada, Nan's camp): every line they say.
  lines.push(...allHeirloomLines());
  // The Echo camps' keepsake offers (leaving Bett's candle, Nan's road-nails):
  // the leave choice, the offers, the guest line, the leaving and the softer settle.
  lines.push(...allEchoKeepsakeLines());
  for (const line of lines) {
    assert.ok(line.length <= 160, `${line.length} chars: ${line}`);
    assert.doesNotMatch(line, OUT_OF_WORLD, line);
  }
  const prose = [
    ...journalEntries(R('complete')).flatMap((e) => [e.title, e.body]),
    ...allResidentJournal().flatMap((e) => [e.title, e.body]),
    ...allHeirloomJournal().flatMap((e) => [e.title, e.body]),
    ...allEchoKeepsakeJournal().flatMap((e) => [e.title, e.body]),
    ...Object.values(locations).flatMap((l) => [l.name, l.eyebrow, l.tagline, l.description]),
    ...[...expansion.POIS, ...expansion.TRINKETS, ...expansion.MORE_TRINKETS].map((t) => ('discoveryText' in t ? t.discoveryText : t.blurb)),
  ];
  for (const text of prose) assert.doesNotMatch(text, OUT_OF_WORLD, text);
});

test('the world-touch lines are varied, in-world, and every sign resolves', async () => {
  const touches = await import('../src/content/touches.ts');
  const pools: Array<[string, readonly string[]]> = [
    ['flowers', touches.FLOWER_LINES],
    ['sit', touches.SIT_LINES],
    ...Object.entries(touches.SIGN_COPY).map(([key, s]) => [key, s.lines] as [string, readonly string[]]),
  ];
  for (const [key, pool] of pools) {
    assert.ok(pool.length >= 2, `${key} pool needs at least two lines to vary`);
    assert.equal(new Set(pool).size, pool.length, `${key} pool repeats a line`);
    for (const line of pool) {
      assert.ok(line.length > 0 && line.length <= 160, `${key}: ${line.length} chars: ${line}`);
      assert.doesNotMatch(line, OUT_OF_WORLD, line);
    }
  }
  // Cycling a pool never says the same line twice in a row.
  for (const pool of [touches.FLOWER_LINES, touches.SIT_LINES]) {
    for (let i = 1; i < pool.length * 2; i += 1) {
      assert.notEqual(touches.nextLine(pool, i), touches.nextLine(pool, i - 1));
    }
  }
  // Every road the game can signpost has its own copy; anything else falls back.
  const fallback = touches.signCopy('no-such-sign');
  const gates = [
    'gate:village:woodland',
    'gate:village:commons',
    'gate:woodland:village',
    'gate:woodland:ruin',
    'gate:ruin:woodland',
    'gate:commons:village',
    'gate:commons:wilds',
  ];
  for (const key of [...gates, 'post', 'route', 'milestone']) {
    const copy = touches.signCopy(key);
    assert.ok(copy.speaker.length > 0, `${key} has no speaker`);
    assert.notDeepEqual(copy, fallback, `${key} fell back to the plain sign`);
  }
  assert.deepEqual(touches.signCopy('gate:nowhere'), fallback);
});

test('the warden is settled, not slain, in every story beat', () => {
  const text = [
    ...QUEST_STAGES.flatMap((s) => NPC_IDS.flatMap((id) => dialogueFor(id, R(s)).lines)),
    ...journalEntries(R('complete')).map((e) => e.body),
    ...allResidentLines(),
    ...allHeirloomLines(),
    ...allHeirloomJournal().map((e) => e.body),
    ...allEchoKeepsakeLines(),
    ...allEchoKeepsakeJournal().map((e) => e.body),
  ].join('\n');
  assert.doesNotMatch(text, /\b(defeat(ed)?|bested|slain|killed|destroyed)\b/i);
  assert.match(dialogueFor('mara', R('guardian-defeated')).lines.join(' '), /settled/);
});

test('the Echo camps take their person’s keepsake: journal once, and a softer settle', async () => {
  const { ECHOES, echoKeepsakeJournalEntries } = await import('../src/content/echoes.ts');
  // Dorrit has no keepsake item yet; Bett's and Nan's do.
  assert.deepEqual(ECHOES.filter((e) => e.keepsake).map((e) => e.member).sort(), ['bett', 'nan']);
  // The journal writes each keep the first time it is left, and only then.
  assert.deepEqual(echoKeepsakeJournalEntries([]), []);
  const entries = echoKeepsakeJournalEntries(['returned:beeswax-candle', 'returned:road-nails']);
  assert.equal(entries.length, 2);
  const nan = ECHOES.find((e) => e.member === 'nan')!.keepsake!;
  assert.deepEqual(echoKeepsakeJournalEntries(['returned:road-nails']), [{ ...nan.journal }]);
});

test('the Quests page’s steps follow the objectives: copy the naming, then settle the warden', () => {
  const step = (stage: QuestStage) => LABELS[QUEST_STAGES.indexOf(stage)];
  // One step per stage before the ending, in story order.
  assert.equal(LABELS.length, QUEST_STAGES.length - 1);
  assert.equal(step('accepted'), 'Copy the route stone in Ashwatch Ruin');
  assert.match(objective('accepted'), /copy the naming cut on the route stone/);
  assert.equal(step('clue-found'), 'Settle the stone warden');
  assert.match(objective('clue-found'), /^Settle the stone warden/);
  assert.match(objective('guardian-defeated'), /^Light the hilltop lantern/);
  for (const s of LABELS) assert.doesNotMatch(s, /\b(face|fight|defeat|slay|kill)\b/i, s);
});

test('the warden is settled by a naming: no "rubbing" in anything a player reads', () => {
  const stages = QUEST_STAGES;
  const text: string[] = [];
  for (const id of ['mara', 'pip', 'orrin', 'clue', 'lantern']) {
    for (const st of stages) {
      try {
        const d = dialogueFor(id, R(st));
        text.push(...d.lines, ...(d.choices ?? []).flatMap((c) => [c.text, ...(c.reply ?? [])]));
      } catch {
        /* not every id speaks at every stage */
      }
    }
  }
  for (const st of stages) {
    text.push(objective(st), ...journalEntries(R(st)).flatMap((e) => [e.title, e.body]));
  }
  text.push(...allResidentLines(), ...allResidentJournal().map((e) => e.body));
  text.push(...LABELS, itemInfo('lantern-route-rubbing').name, itemInfo('lantern-route-rubbing').blurb, discoveryInfo('old-route-marker').blurb);
  for (const t of text) assert.doesNotMatch(t, /\brub(bing|bed)?\b/i, t);
  assert.match(dialogueFor('clue', R('accepted')).lines.join(' '), /The road is closed here/);
  assert.equal(itemInfo('lantern-route-rubbing').name, 'Wenna’s Naming, Copied Out');
});

test('the seasons’ materials keep their own company: each in its mark or wick, and none expire', async () => {
  const { GATHERING_DATA, inSeason, gatheringTarget } = await import('../src/lib/gathering.ts');
  const { CALENDAR, calendarAt } = await import('../src/lib/calendar.ts');
  const dayAt = (t: number) => calendarAt(t, CALENDAR);
  const epoch = Date.parse(CALENDAR.epoch) / 1000;

  // Every seasonal piece names the season the doc gives it.
  const seasons: Record<string, { kind: 'mark' | 'wick'; season: string; item: string }> = {
    'freshet-shore': { kind: 'mark', season: 'Mudrise', item: 'walnut-shells' },
    'bloom-patch': { kind: 'wick', season: 'Bloom', item: 'bloom-flowers' },
    'pond-ice': { kind: 'mark', season: 'Quiet', item: 'frost-glass' },
  };
  for (const [id, want] of Object.entries(seasons)) {
    const t = gatheringTarget(id);
    assert.ok(t, `${id} is a gather target`);
    assert.equal(want.kind === 'mark' ? t!.mark : t!.wick, want.season, `${id} in ${want.season}`);
    assert.deepEqual(t!.yields.map((y) => y.item), [want.item]);
    // Its own wick or mark, and never its neighbour's: the year has all of
    // them, once each.
    const own = firstOf((inner) => (want.kind === 'mark' ? inner.mark : inner.wick) === want.season);
    assert.ok(inSeason(t!, dayAt(own)), `${id} stands in its season`);
  }
  function firstOf(when: (day: { mark: string; wick: string }) => boolean): number {
    for (let d = 0; d < CALENDAR.wickDays * 12; d++) {
      const t = epoch + d * 86400 + 3600;
      if (when(dayAt(t))) return t;
    }
    throw new Error('no such day');
  }
  // The sap rides the Tangle's trees, in Amberfall alone.
  const sap = gatheringTarget('tangle-tree')?.yields.find((y) => y.item === 'amberfall-sap');
  assert.ok(sap, 'the Tangle trees give their sap');
  assert.equal(sap?.mark, 'Amberfall');
  // The amberfall sap yield is silent the rest of the year.
  const amberfall = firstOf((day) => day.mark === 'Amberfall');
  assert.ok(inSeason(sap!, dayAt(amberfall)));
});

test('the sellers and their goods speak the village’s voice', async () => {
  const { ITEMS } = await import('../src/lib/items.ts');
  const sellers = ITEMS.sellers ?? [];
  assert.ok(sellers.length >= 3, 'Hazel’s kitchen, Finn’s mill door, the Carting Day stall');
  const names = sellers.map((s) => s.npc).join(',');
  assert.match(names, /Hazel/);
  assert.match(names, /Finn/);
  const stall = sellers.find((s) => s.festival);
  assert.equal(stall?.festival, 'Carting Day');
  for (const s of sellers) {
    for (const g of s.goods) {
      assert.ok(g.line.length <= 160, `${g.line.length} chars: ${g.line}`);
      assert.doesNotMatch(g.line, OUT_OF_WORLD, g.line);
      assert.ok(g.label.length > 0 && g.label.length <= 80);
    }
  }
});
