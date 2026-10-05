import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEMO_CHARACTER,
  dialogueFor,
  journalEntries,
  locations,
  QUEST_STEPS,
} from '../src/content/world.ts';
import {
  advanceQuest,
  createNewGame,
  QUEST_STAGES,
  questObjective,
  validateSave,
  type QuestStage,
} from '../src/lib/state.ts';

const NPC_IDS = ['mara', 'pip', 'orrin', 'clue', 'lantern'];

test('NPC ids match the runtime contract exactly', () => {
  for (const id of NPC_IDS) {
    const dialogue = dialogueFor(id, 'new');
    assert.equal(typeof dialogue.speaker, 'string');
    assert.ok(dialogue.speaker.length > 0);
    assert.ok(dialogue.lines.length > 0);
    for (const line of dialogue.lines) {
      assert.equal(typeof line, 'string');
      assert.ok(line.length > 0);
    }
  }
  assert.throws(() => dialogueFor('guardian', 'new'), /Unknown NPC id/);
  assert.throws(() => dialogueFor('stranger', 'complete'), /Unknown NPC id/);
});

test('every NPC has dialogue at every quest stage', () => {
  for (const id of NPC_IDS) {
    for (const stage of QUEST_STAGES) {
      const dialogue = dialogueFor(id, stage);
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
      const dialogue = dialogueFor(id, stage);
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

  assert.equal(dialogueFor('mara', 'new').event, 'accept');
  assert.equal(dialogueFor('clue', 'accepted').event, 'find-clue');
  assert.equal(dialogueFor('lantern', 'guardian-defeated').event, 'light-lantern');
  assert.equal(dialogueFor('mara', 'lantern-lit').event, 'return-village');
});

test('no dialogue owns defeat-guardian; it belongs to runtime encounters', () => {
  for (const id of NPC_IDS) {
    for (const stage of QUEST_STAGES) {
      const dialogue = dialogueFor(id, stage);
      assert.notEqual(dialogue.event, 'defeat-guardian', `${id}@${stage}`);
    }
  }
});

test('completed-stage dialogue never re-fires quest events', () => {
  for (const id of NPC_IDS) {
    const dialogue = dialogueFor(id, 'complete');
    assert.equal(dialogue.event, undefined);
  }
});

test('dialogue events apply cleanly through the quest machine', () => {
  let state = createNewGame();
  const dialogueSteps: Array<{ npc: string; stage: QuestStage }> = [
    { npc: 'mara', stage: 'new' },
    { npc: 'clue', stage: 'accepted' },
    { npc: 'lantern', stage: 'guardian-defeated' },
    { npc: 'mara', stage: 'lantern-lit' },
  ];
  for (const step of dialogueSteps) {
    const dialogue = dialogueFor(step.npc, step.stage);
    assert.equal(state.quest, step.stage);
    assert.ok(dialogue.event, `${step.npc}@${step.stage} should carry an event`);
    state = advanceQuest(state, dialogue.event!);
    if (state.quest === 'clue-found') {
      state = advanceQuest(state, 'defeat-guardian');
    }
    validateSave(state);
  }
  assert.equal(state.quest, 'complete');
});

test('journal entries accumulate as the quest advances', () => {
  const start = journalEntries('new');
  const accepted = journalEntries('accepted');
  const clue = journalEntries('clue-found');
  const guardian = journalEntries('guardian-defeated');
  const lit = journalEntries('lantern-lit');
  const done = journalEntries('complete');

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

  assert.throws(() => journalEntries('nope' as never), /Unknown quest stage/);
});

test('journal and dialogue are pure (no shared mutable arrays)', () => {
  const a = dialogueFor('mara', 'new');
  a.lines.push('mutated');
  const b = dialogueFor('mara', 'new');
  assert.ok(!b.lines.includes('mutated'));

  const j1 = journalEntries('new');
  j1.push({ title: 'x', body: 'y' });
  assert.notEqual(journalEntries('new').length, j1.length);
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
  const lines: string[] = [];
  for (const id of NPC_IDS) {
    for (const stage of QUEST_STAGES) {
      const d = dialogueFor(id, stage);
      lines.push(...d.lines);
      for (const c of d.choices ?? []) lines.push(c.text, ...(c.reply ?? []));
    }
  }
  const builder = expansion.BUILDER_NPC_DATA.dialogue;
  for (const d of [builder.firstMeeting, builder.offerCampsite, builder.sellDecorations, builder.notEnoughEmbers, builder.afterUpgrade]) {
    lines.push(...d.lines);
  }
  lines.push(...builder.idleLines, ...Object.values(expansion.NEW_NPC_LINES).flat());
  for (const line of lines) {
    assert.ok(line.length <= 160, `${line.length} chars: ${line}`);
    assert.doesNotMatch(line, OUT_OF_WORLD, line);
  }
  const prose = [
    ...journalEntries('complete').flatMap((e) => [e.title, e.body]),
    ...Object.values(locations).flatMap((l) => [l.name, l.eyebrow, l.tagline, l.description]),
    ...[...expansion.POIS, ...expansion.TRINKETS, ...expansion.MORE_TRINKETS].map((t) => ('discoveryText' in t ? t.discoveryText : t.blurb)),
  ];
  for (const text of prose) assert.doesNotMatch(text, OUT_OF_WORLD, text);
});

test('the warden is settled, not slain, in every story beat', () => {
  const text = [
    ...QUEST_STAGES.flatMap((s) => NPC_IDS.flatMap((id) => dialogueFor(id, s).lines)),
    ...journalEntries('complete').map((e) => e.body),
  ].join('\n');
  assert.doesNotMatch(text, /\b(defeat(ed)?|bested|slain|killed|destroyed)\b/i);
  assert.match(dialogueFor('mara', 'guardian-defeated').lines.join(' '), /settled/);
});

test('the journal checklist follows the objectives: a rubbing, then settling the warden', () => {
  const step = (stage: QuestStage) => QUEST_STEPS.find((s) => s.stage === stage)!.label;
  // One step per stage before the ending, in story order.
  assert.deepEqual(QUEST_STEPS.map((s) => s.stage), QUEST_STAGES.slice(0, -1));
  assert.equal(step('accepted'), 'Take a rubbing of the route stone');
  assert.match(questObjective('accepted'), /take a rubbing of the route stone/);
  assert.equal(step('clue-found'), 'Settle the stone warden');
  assert.match(questObjective('clue-found'), /^Settle the stone warden/);
  assert.match(questObjective('guardian-defeated'), new RegExp(`^${step('guardian-defeated')}`));
  for (const s of QUEST_STEPS) assert.doesNotMatch(s.label, /\b(face|fight|defeat|slay|kill)\b/i, s.label);
});
