import test from 'node:test';
import assert from 'node:assert/strict';
import { epochEnded, outerSeasonAt, seasonBounds, seasonMark } from '../src/lib/wilds/outer.ts';
import { CALENDAR_PAPERS, SITE_PAPERS, TURNED_FLAG, UNBUILT_PAPERS, calendarFind, siteFind } from '../src/lib/wilds/stories.ts';
import { ECHOES } from '../src/content/echoes.ts';
import { PAPERS } from '../src/content/papers.ts';
import { WILDS_PAPER_PLACEMENTS } from '../src/game/wilds/placements.ts';
import { PAPERS as COMMONS_PAPERS } from '../src/game/homestead.ts';
import { calendarAt } from '../src/lib/calendar.ts';
import { createNewGame, validateSave } from '../src/lib/state.ts';
import projects from '../content/projects.json' with { type: 'json' };

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
  for (const p of WILDS_PAPER_PLACEMENTS) hooked.add(p.paperId);
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
    if (!hooked.has(p.id) && !(p.id in UNBUILT_PAPERS)) missing.push(p.id);
  }
  assert.deepEqual(missing, []);
  assert.deepEqual(Object.keys(UNBUILT_PAPERS), ['joss-penhallow-letter-map-case']);
  for (const id of hooked) assert.ok(PAPERS.some((p) => p.id === id), `${id} is a real paper`);
});

// ---------------------------------------------------------------- save markers

test('the outer-region save markers are client-only and stay with their position', () => {
  const s = { ...createNewGame(), area: 'wilds' as const, position: { x: 424, y: 744 }, wildsRegion: 'outer-1', outerSeason: outerSeasonAt(NOW) };
  const v = validateSave(s);
  assert.equal(v.wildsRegion, 'outer-1');
  assert.equal(v.outerSeason, outerSeasonAt(NOW));
  // Out of the Wilds the region marker means nothing and is dropped.
  assert.equal(validateSave({ ...s, area: 'village' }).wildsRegion, undefined);
  assert.equal('wildsRegion' in validateSave(createNewGame()), false);
});

test('days in a wick are calendar days', () => {
  const d = calendarAt(NOW);
  assert.equal(d.nextTurning - d.startsAt, WICK);
  assert.ok(NOW >= d.startsAt && NOW < d.nextTurning);
  void DAY;
});
