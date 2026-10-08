import test from 'node:test';
import assert from 'node:assert/strict';
import {
  millHopperLines,
  allResidentJournal,
  allResidentLines,
  earlyResidentLines,
  isResident,
  metAt,
  metFlag,
  RESIDENT_IDS,
  residentJournal,
  residentTalk,
  type ResidentContext,
} from '../src/content/residents.ts';
import { journalEntries } from '../src/content/world.ts';
import { handoverFor, paperFlag } from '../src/content/papers.ts';
import { QUEST_STAGES, type QuestStage } from '../src/lib/state.ts';
import { calendarAt } from '../src/lib/calendar.ts';
import { buildArea } from '../src/game/worlds.ts';
import { TERRAIN, TILE } from '../src/lib/tile.ts';

const EPOCH = Date.parse('2026-01-05T00:00:00Z') / 1000;
const DAY = 86400;

/** Hearthwick's date on day `day` (1-based) of wick `wick` (0 = Thaw). */
function on(wick: number, day: number): ResidentContext['calendar'] {
  const c = calendarAt(EPOCH + (wick * 7 + day - 1) * DAY + 3600);
  return { wick: c.wick, day: c.day, mark: c.mark, festival: c.festival, notice: c.notice };
}

function ctx(over: Partial<ResidentContext> = {}): ResidentContext {
  return { stage: 'new', flags: [], calendar: on(1, 3), projects: {}, home: { claimed: false, tier: null, connected: false }, ...over };
}

/** A save that has met everyone (at `new`). */
const MET = RESIDENT_IDS.map((id) => metFlag(id, 'new'));

test('residents are their own kind of NPC: four of them, unknown ids throw', () => {
  assert.deepEqual([...RESIDENT_IDS], ['elara', 'finn', 'hazel', 'ada']);
  for (const id of RESIDENT_IDS) assert.ok(isResident(id));
  for (const id of ['mara', 'pip', 'orrin', 'silas', 'clue']) assert.ok(!isResident(id), id);
  assert.throws(() => residentTalk('mara', ctx()), /Unknown resident id/);
});

test('the first meeting is an introduction; after it, lines follow the quest stage', () => {
  for (const id of RESIDENT_IDS) {
    const first = residentTalk(id, ctx());
    assert.equal(first.first, true);
    assert.ok(first.dialogue.lines.length >= 2, id);
    assert.equal(first.dialogue.event, undefined, `${id} never moves the quest`);
    const seen = new Set<string>();
    for (const stage of QUEST_STAGES) {
      const t = residentTalk(id, ctx({ stage, flags: MET }));
      assert.equal(t.first, false);
      assert.equal(t.dialogue.event, undefined);
      assert.ok(t.dialogue.lines.length >= 2, `${id}@${stage} says its stage line and a line about the day`);
      seen.add(t.dialogue.lines[0]);
    }
    assert.ok(seen.size >= 5, `${id} has stage-aware lines`);
  }
});

test('speakers use first names, like Mara and Pip', () => {
  assert.deepEqual(RESIDENT_IDS.map((id) => residentTalk(id, ctx()).dialogue.speaker), ['Elara', 'Finn', 'Hazel', 'Ada']);
});

test('meeting flags carry the stage and round-trip', () => {
  assert.equal(metFlag('elara', 'clue-found'), 'met:elara@clue-found');
  assert.equal(metAt(['x', metFlag('ada', 'accepted')], 'ada'), 'accepted');
  assert.equal(metAt([metFlag('ada', 'accepted')], 'finn'), null);
});

test('a resident’s journal entry joins the notes after the stage you met them at', () => {
  const flags = [metFlag('hazel', 'new'), metFlag('elara', 'clue-found'), 'met:nobody@new', 'met:finn@nonsense'];
  const titles = journalEntries('complete', flags).map((e) => e.title);
  const at = (t: string) => titles.indexOf(t);
  assert.ok(at('Hazel Penhallow') > at('Arrival in Hearthwick') && at('Hazel Penhallow') < at("Mara's Request"));
  assert.ok(at('Elara Quill') > at('The Closure Mark') && at('Elara Quill') < at('The Warden Settled'));
  assert.equal(at('Finn Tolley'), -1, 'an unknown stage never shows');
  // Not met yet: nothing about them.
  assert.ok(!journalEntries('complete').some((e) => e.title === 'Ada Cooley'));
  // Met at a later stage than the journal has reached: not yet.
  assert.ok(!journalEntries('new', flags).some((e) => e.title === 'Elara Quill'));
  // Stable for older callers, and never duplicated.
  assert.deepEqual(journalEntries('new'), journalEntries('new', []));
  assert.equal(residentJournal([metFlag('ada', 'new'), metFlag('ada', 'new')], 'new').length, 1);
  const quest = new Set(journalEntries('complete').map((e) => e.title));
  for (const e of allResidentJournal()) {
    assert.ok(!quest.has(e.title), e.title);
    assert.ok(e.body.length > 40 && e.body.length < 320, e.title);
  }
});

test('reveal order: nothing before the road is lit says the Six survived', () => {
  const early = earlyResidentLines().join('\n');
  assert.doesNotMatch(early, /\b(surviv\w*|alive|still out there|keeping a light|kept a light|carved fox(es)?|wooden fox(es)?|twenty-seven|Sallow Ford lamp|Bryony|turncaps?)\b/i);
  // The late hints are there once the road is lit.
  assert.match(residentTalk('elara', ctx({ stage: 'complete', flags: MET })).dialogue.lines.join(' '), /Bryony/);
  assert.match(residentTalk('finn', ctx({ stage: 'complete', flags: MET })).dialogue.lines.join(' '), /linseed/i);
});

test('the strongest late lines wait for their papers', () => {
  const late = (id: string, flags: string[]) => residentTalk(id, ctx({ stage: 'complete', flags: [...MET, ...flags] })).dialogue.lines.join(' ');
  assert.doesNotMatch(late('elara', []), /turncap/);
  assert.match(late('elara', [paperFlag('elara-quill-field-notes-turncaps')]), /turncap notes/);
  assert.match(late('elara', [paperFlag('elara-quill-field-notes-turncaps'), paperFlag('a-salting-drift-table')]), /Bryony’s hand/);
  assert.match(late('finn', [paperFlag('forty-one-and-holding')]), /hopper/);
  assert.match(late('finn', [paperFlag('forty-one-and-holding'), paperFlag('note-in-the-linseed-box')]), /what a river owes a road/);
  assert.match(late('ada', [paperFlag('adas-oil-receipts')]), /who pays/);
  assert.match(late('hazel', [paperFlag('keepers-twists-recipe-card')]), /back of my card/);
  // Papers never change what anyone says before the road is lit.
  const flags = [...MET, paperFlag('adas-oil-receipts'), paperFlag('note-in-the-linseed-box')];
  for (const stage of QUEST_STAGES.filter((s) => s !== 'complete')) {
    assert.deepEqual(residentTalk('ada', ctx({ stage, flags })).dialogue.lines, residentTalk('ada', ctx({ stage, flags: MET })).dialogue.lines);
  }
});

test('Hazel hands over her own recipe card once the road is lit', () => {
  for (const stage of QUEST_STAGES.filter((s) => s !== 'complete') as QuestStage[]) assert.equal(handoverFor('hazel', stage, []), null);
  const h = handoverFor('hazel', 'complete', []);
  assert.equal(h?.paperId, 'keepers-twists-recipe-card');
  assert.match(h!.lines.join(' '), /my brother/);
  for (const line of h!.lines) assert.ok(line.length <= 160, line);
  assert.equal(handoverFor('hazel', 'complete', [paperFlag('keepers-twists-recipe-card')]), null);
});

test('Elara’s line follows the calendar: the wick, the Mark, the day before a Turning', () => {
  const say = (cal: ResidentContext['calendar']) => residentTalk('elara', ctx({ flags: MET, calendar: cal })).dialogue.lines.at(-1)!;
  // Ordinary days name the wick and read the Mark.
  assert.match(say(on(1, 3)), /^Mud-wick, Mudrise/);
  assert.match(say(on(4, 2)), /^Light-wick, the Green Hush/);
  assert.match(say(on(7, 2)), /^Sap-wick, Amberfall/);
  assert.match(say(on(10, 2)), /^Smoke-wick\. The White Quiet/);
  // The last day of a wick: she has posted the Turning.
  assert.equal(on(8, 7)!.notice, 'Dark of Amber-wick — the outer Wilds will turn.');
  assert.match(say(on(8, 7)), /^Dark of Amber-wick tomorrow: the outer Wilds turn\. I’ve posted it\./);
  // A festival outranks the notice (Closure Night is the Quiet's last day).
  assert.equal(on(11, 7)!.festival, 'Closure Night');
  assert.match(say(on(11, 7)), /road left dark on purpose/);
  assert.match(say(on(5, 6)), /^Carting Day/);
  assert.match(say(on(0, 1)), /ice is off the Wend/);
  assert.match(say(on(8, 1)), /^Amberwake/);
  // Each different day is news: the topic key changes, so the "…" comes back.
  const topics = new Set([on(1, 3), on(1, 7), on(5, 6)].map((c) => residentTalk('elara', ctx({ flags: MET, calendar: c })).topic));
  assert.equal(topics.size, 3);
  // No calendar yet: the stage line alone.
  assert.equal(residentTalk('elara', ctx({ flags: MET, calendar: null })).dialogue.lines.length, 1);
});

test('everyone reacts to festivals', () => {
  for (const id of RESIDENT_IDS) {
    for (const [w, d, name] of [[0, 1, 'The Breaking'], [5, 6, 'Carting Day'], [8, 1, 'Amberwake'], [11, 7, 'Closure Night']] as const) {
      const t = residentTalk(id, ctx({ flags: MET, calendar: on(w, d) }));
      assert.equal(t.topic, `new:festival:${name}`, `${id} on ${name}`);
    }
  }
});

test('village projects and your homestead come up in conversation', () => {
  // No calendar: the first of the day's turns (project, then plot, then season).
  const last = (id: string, over: Partial<ResidentContext>) => residentTalk(id, ctx({ flags: MET, calendar: null, ...over })).dialogue.lines.at(-1)!;
  assert.match(last('finn', { projects: { 'mill-wheel': 'open' } }), /notice on the board/);
  assert.match(last('finn', { projects: { 'mill-wheel': 'in-progress' } }), /every other turn/);
  assert.match(last('finn', { projects: { 'mill-wheel': 'complete' } }), /Forty-one and holding/);
  assert.match(last('ada', { projects: { 'cooley-window-fund': 'complete' } }), /Paid in full/);
  assert.match(last('hazel', { projects: { 'well-canopy': 'complete' } }), /canopy/);
  // The festival still comes first.
  assert.match(last('finn', { projects: { 'mill-wheel': 'open' }, calendar: on(5, 6) }), /^Carting Day/);
  // Homestead: none (only worth saying with a world to claim in), a camp, a roof.
  assert.match(last('elara', { home: { claimed: false, tier: null, connected: true } }), /plots chalked/);
  assert.equal(residentTalk('elara', ctx({ flags: MET, calendar: null })).dialogue.lines.length, 1, 'a guest isn’t told to claim');
  assert.match(last('elara', { home: { claimed: true, tier: 0, connected: true } }), /Your camp/);
  assert.match(last('elara', { home: { claimed: true, tier: 2, connected: true } }), /cottage on skids/);
  assert.match(last('hazel', { home: { claimed: true, tier: 1, connected: true } }), /roof of your own/);
  assert.match(last('ada', { home: { claimed: true, tier: 1, connected: true } }), /Put a lamp in the window/);
  // Ada says nothing about a plot she can't see from her window: the season instead.
  assert.match(residentTalk('ada', ctx({ flags: MET, home: { claimed: true, tier: 0, connected: true } })).dialogue.lines.at(-1)!, /Wet season/);
  // With a calendar, project, plot and season take turns by the day of the wick.
  const turns = [1, 2, 3].map((d) =>
    residentTalk('finn', ctx({ flags: MET, calendar: on(1, d), projects: { 'mill-wheel': 'open' }, home: { claimed: true, tier: 1, connected: true } })).dialogue.lines.at(-1)!,
  );
  assert.match(turns[0], /notice on the board/);
  assert.match(turns[1], /You’ve a roof now/);
  assert.match(turns[2], /^Mudrise/);
});

test('Ada speaks in very few words', () => {
  const ada = new Set<string>();
  for (const stage of QUEST_STAGES) for (const l of residentTalk('ada', ctx({ stage, flags: MET })).dialogue.lines) ada.add(l);
  for (const l of residentTalk('ada', ctx()).dialogue.lines) ada.add(l);
  for (const l of ada) assert.ok(l.split(/\s+/).length <= 14, l);
});

test('resident talk is pure (no shared arrays)', () => {
  const a = residentTalk('hazel', ctx({ flags: MET }));
  a.dialogue.lines.push('mutated');
  assert.ok(!residentTalk('hazel', ctx({ flags: MET })).dialogue.lines.includes('mutated'));
  assert.ok(allResidentLines().length > 80);
});

test('residents stand on open ground in their places, clear of the quest NPCs and the spawn', () => {
  const village = buildArea('village');
  const commons = buildArea('commons');
  const spot = (w: typeof village, id: string) => w.npcs.find((n) => n.id === id)!;
  for (const [w, id] of [[village, 'hazel'], [village, 'finn'], [village, 'ada'], [commons, 'elara']] as const) {
    const n = spot(w, id);
    assert.ok(n, `${id} is placed`);
    assert.equal(w.solid[n.ty][n.tx], false, `${id} stands on open ground`);
    for (const o of w.npcs) if (o !== n) assert.ok(Math.hypot(o.tx - n.tx, o.ty - n.ty) * TILE > 48, `${id} is clear of ${o.id}`);
    assert.ok(Math.hypot(w.spawn.tx - n.tx, w.spawn.ty - n.ty) * TILE > 48, `${id} is clear of the spawn`);
    for (const b of [...w.bushes, ...w.rocks]) assert.ok(b.tx !== n.tx || b.ty !== n.ty, `${id} not on a bush or rock`);
  }
  // Finn at his mill door, Ada under her window, Elara by the Wilds arch.
  const finn = spot(village, 'finn');
  const mill = village.mill!;
  assert.equal(finn.ty, mill.ty + mill.th, 'Finn stands on the ground in front of the mill');
  assert.ok(Math.abs(finn.tx - mill.door.tx) <= 1, 'beside the door');
  assert.deepEqual(spot(village, 'ada'), { id: 'ada', tx: 35, ty: 8 });
  const arch = commons.exits.find((e) => e.to === 'wilds')!;
  const elara = spot(commons, 'elara');
  assert.ok(Math.abs(elara.ty - arch.ty) <= 6 && elara.tx >= arch.tx && elara.tx <= arch.tx + arch.tw + 1);
  // Off the lane's walk: the Wilds path stays clear.
  assert.ok(elara.tx > arch.tx + arch.tw - 1);
});

test('the Tolley mill sits on the pond’s edge, clear of the quest, the library, Ada and Hazel', () => {
  const village = buildArea('village');
  const m = village.mill!;
  assert.ok(m, 'the village has a mill');
  // Its footprint is solid, the wheel stands at the water's edge, and the
  // hopper is solid against the west wall.
  for (let y = m.ty; y < m.ty + m.th; y++) for (let x = m.tx; x < m.tx + m.tw; x++) assert.ok(village.solid[y][x], `${x},${y}`);
  const wheel = { tx: Math.floor(m.wheel.x / TILE), ty: Math.floor(m.wheel.y / TILE) };
  assert.ok(village.solid[wheel.ty][wheel.tx], 'the wheel blocks its own tile');
  assert.equal(wheel.tx, m.tx + m.tw, 'on the east wall');
  assert.ok([TERRAIN.water_a, TERRAIN.water_b].includes(village.ground[wheel.ty][wheel.tx + 1]), 'pond water beside the wheel');
  assert.ok(village.solid[m.hopper.ty][m.hopper.tx]);
  assert.ok(m.hopper.tx === m.tx - 1 && m.hopper.ty >= m.ty && m.hopper.ty < m.ty + m.th, 'hopper against the west wall');
  // The door opens onto walkable ground, and the garden's gap above still opens onto grass.
  assert.equal(village.solid[m.door.ty + 1][m.door.tx], false);
  assert.equal(village.solid[19][27], false);
  // Nothing of the quest, the library, Ada's house or Hazel in or against it.
  const inMill = (p: { tx: number; ty: number }) => p.tx >= m.tx - 1 && p.tx <= m.tx + m.tw && p.ty >= m.ty - 1 && p.ty <= m.ty + m.th;
  for (const n of village.npcs.filter((n) => n.id !== 'finn')) assert.ok(!inMill(n), n.id);
  for (const p of [village.library!, village.board!, village.well!, village.spawn]) assert.ok(!inMill(p), `${p.tx},${p.ty}`);
  for (const b of [...village.bushes, ...village.rocks]) assert.ok(!inMill(b), `${b.tx},${b.ty}`);
  for (const e of village.exits) assert.ok(!inMill({ tx: e.tx, ty: e.ty }));
  const keys = (village.scenery ?? []).map((s) => s.key);
  assert.ok(keys.includes('mill-house') && keys.includes('mill-hopper'));
});

test('the hopper’s tally is a mystery until Finn’s paper says what it counts', () => {
  const before = millHopperLines([]).join(' ');
  assert.match(before, /clusters of five/);
  assert.doesNotMatch(before, /fox|Aldo|twenty-seven|grate/i);
  const after = millHopperLines([paperFlag('forty-one-and-holding')]).join(' ');
  assert.match(after, /twenty-seven/);
  assert.match(after, /fox cleaned off the grate/);
  for (const l of [...millHopperLines([]), ...millHopperLines([paperFlag('forty-one-and-holding')])]) assert.ok(l.length <= 160, l);
});

test('Finn has his mill: no line says he comes up to the pond between grindings', () => {
  assert.ok(allResidentLines().some((l) => /This is the mill/.test(l)));
  for (const l of allResidentLines()) assert.doesNotMatch(l, /between grindings|come up to (the pond|watch)/i, l);
  assert.match(residentTalk('finn', ctx({ flags: MET, calendar: null, projects: { 'mill-wheel': 'complete' } })).dialogue.lines.at(-1)!, /No groan/);
});
