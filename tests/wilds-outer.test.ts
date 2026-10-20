import test from 'node:test';
import assert from 'node:assert/strict';
import { epochEnded, outerSeasonAt, seasonBounds, seasonMark } from '../src/lib/wilds/outer.ts';
import { CALENDAR_PAPERS, SITE_PAPERS, TURNED_FLAG, UNBUILT_PAPERS, calendarFind, siteFind } from '../src/lib/wilds/stories.ts';
import { ECHOES } from '../src/content/echoes.ts';
import { PAPERS } from '../src/content/papers.ts';
import { PAPERS as COMMONS_PAPERS } from '../src/game/homestead.ts';
import { calendarAt } from '../src/lib/calendar.ts';
import { createNewGame, validateSave } from '../src/lib/state.ts';
import projects from '../content/projects.json' with { type: 'json' };
import { questById } from '../src/lib/quests.ts';

// The outer Wilds' terrain, sites, crossing and Echo assignments are the
// server's now (server/internal/wilds: goldens and invariants); these are the
// client's season and story-find rules.

const DAY = 86400;
const WICK = 7 * DAY;
/** Monday 2026-10-05, inside a wick. */
const NOW = Date.UTC(2026, 9, 5, 12) / 1000;

// ---------------------------------------------------------------- epochs

test('outer seasons are the wick’s UTC bounds, like the server writes them', () => {
  const d = calendarAt(NOW);
  assert.equal(outerSeasonAt(NOW), `t:${d.startsAt}:${d.nextTurning}`);
  // The wick's first second belongs to it; its end belongs to the next wick.
  assert.equal(outerSeasonAt(d.startsAt), outerSeasonAt(NOW));
  assert.equal(outerSeasonAt(d.nextTurning - 1), outerSeasonAt(NOW));
  assert.notEqual(outerSeasonAt(d.nextTurning), outerSeasonAt(NOW));
  assert.equal(outerSeasonAt(d.nextTurning), `t:${d.nextTurning}:${d.nextTurning + WICK}`);
});

test('season bounds, marks and endings', () => {
  const d = calendarAt(NOW);
  const season = outerSeasonAt(NOW);
  assert.deepEqual(seasonBounds(season), { startsAt: d.startsAt, endsAt: d.nextTurning });
  assert.equal(seasonMark(season), d.mark);
  assert.equal(seasonBounds('0'), null);
  // An older numeric season (absolute wick number) reads through the calendar.
  assert.deepEqual(seasonBounds(String(d.wickNumber)), { startsAt: d.startsAt, endsAt: d.nextTurning });
  assert.equal(epochEnded(season, d.nextTurning - 1), false);
  assert.equal(epochEnded(season, d.nextTurning), true);
  assert.equal(epochEnded('0', NOW * 10), false);
  // The server's endsAt wins when given.
  assert.equal(epochEnded(season, NOW, NOW), true);
  const marks = new Set([0, 3, 6, 9].map((w) => seasonMark(outerSeasonAt(NOW + w * WICK))));
  assert.equal(marks.size, 4, 'four wicks three apart cover every Mark');
});

// ---------------------------------------------------------------- finds

test('site finds and calendar finds follow their gates', () => {
  const base = { flags: [] as string[], late: false, mark: 'Carting' };
  assert.equal(siteFind('plank', base), 'dorrits-second-span');
  assert.equal(siteFind('plank', { ...base, flags: ['paper:dorrits-second-span'] }), null);
  assert.equal(siteFind('nest', base), null);
  assert.equal(siteFind('nest', { ...base, late: true }), 'the-jackdaws-display');
  assert.equal(siteFind('given', { ...base, late: true }), null);
  assert.equal(siteFind('given', { ...base, late: true, flags: [TURNED_FLAG] }), 'nan-greer-trail-journal');
  assert.equal(siteFind('cairn', base), null);
  assert.equal(siteFind('cairn', { ...base, flags: ['paper:will-of-elias-fenn'] }), 'mary-fenns-cairn-slip');
  const elara = ['paper:elara-quill-field-notes-turncaps'];
  assert.equal(siteFind('reeds', { ...base, flags: elara }), null, 'only on a Mudrise flood-drift');
  assert.equal(siteFind('reeds', { ...base, flags: elara, mark: 'Mudrise' }), 'a-salting-drift-table');
  assert.equal(siteFind('echo', base), null);
  assert.equal(calendarFind('turning', base), null);
  assert.equal(calendarFind('turning', { ...base, late: true }), 'weir-effect-survey-draft');
  assert.equal(calendarFind('board', { ...base, late: true }), null);
  assert.equal(calendarFind('board', { ...base, late: true, flags: [TURNED_FLAG] }), 'notices-from-the-board');
  assert.equal(calendarFind('hame', base), 'the-hame-polishers-list');
});

test('every findable paper has a way into the game (or is reported as needing a system)', () => {
  const hooked = new Set<string>();
  // The finds that ride a claim (a POI charted, a tier-3 chest opened): the server grants them with it.
  for (const id of ['failed-grid-of-sector-4', 'joss-penhallow-field-notes-pencil-map', 'the-blind-routes-smugglers-ledger']) hooked.add(id);
  for (const r of Object.values(SITE_PAPERS)) hooked.add(r!.paper);
  for (const r of Object.values(CALENDAR_PAPERS)) hooked.add(r.paper);
  for (const e of ECHOES) if (e.paper) hooked.add(e.paper);
  for (const p of (projects as { projects: { papers: string[] }[] }).projects) for (const id of p.papers) hooked.add(id);
  // The Commons' finds.
  for (const id of Object.values(COMMONS_PAPERS)) hooked.add(id);
  const missing: string[] = [];
  for (const p of PAPERS) {
    const k = p.source.kind;
    if (k === 'library-start' || k === 'placed' || k === 'quest' || k === 'gift') continue;
    // A later quest's step hands it over in its `papers` (the Keeper's hand).
    if (k === 'quest-step') {
      const s = p.source;
      assert.ok(questById(s.quest)?.steps.find((x) => x.id === s.step)?.papers.includes(p.id), `${p.id}: ${s.quest}:${s.step} grants it`);
      continue;
    }
    if (!hooked.has(p.id) && !(p.id in UNBUILT_PAPERS)) missing.push(p.id);
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(Object.keys(UNBUILT_PAPERS), ['joss-penhallow-letter-map-case']);
  for (const id of hooked) assert.ok(PAPERS.some((p) => p.id === id), `${id} is a real paper`);
});

// ---------------------------------------------------------------- save markers

test('a Wilds save is the area and world pixels, nothing else (the region markers went with the regions)', () => {
  const s = { ...createNewGame(), area: 'outdoors' as const, position: { x: -424, y: -744 }, wildsRegion: 'outer-1', outerSeason: outerSeasonAt(NOW) };
  const v = validateSave(s);
  assert.deepEqual([v.area, v.position], ['outdoors', { x: -424, y: -744 }]);
  assert.equal('wildsRegion' in v, false);
  assert.equal('outerSeason' in v, false);
});

test('days in a wick are calendar days', () => {
  const d = calendarAt(NOW);
  assert.equal(d.nextTurning - d.startsAt, WICK);
  assert.ok(NOW >= d.startsAt && NOW < d.nextTurning);
  void DAY;
});
