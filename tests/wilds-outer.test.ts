import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkEntities, chunkTerrain, type ChunkExit, type ChunkTerrain, type Epoch, type Tile } from '../src/lib/wilds/index.ts';
import {
  CROSSING_CHUNK,
  OUTER_REGION_ID,
  chunkSites,
  crossingExit,
  epochEnded,
  guestOuterEpoch,
  outerSeasonAt,
  seasonBounds,
  seasonMark,
  siteChunks,
} from '../src/lib/wilds/outer.ts';
import {
  CALENDAR_PAPERS,
  SITE_PAPERS,
  TURNED_FLAG,
  UNBUILT_PAPERS,
  calendarFind,
  echoAssignments,
  siteFind,
} from '../src/lib/wilds/stories.ts';
import { TANGLE_GROUND } from '../src/lib/wilds/tangle.ts';
import { ECHOES } from '../src/content/echoes.ts';
import { PAPERS } from '../src/content/papers.ts';
import { WILDS_PAPER_PLACEMENTS } from '../src/game/wilds/placements.ts';
import { PAPERS as COMMONS_PAPERS } from '../src/game/homestead.ts';
import { calendarAt } from '../src/lib/calendar.ts';
import { createNewGame, validateSave } from '../src/lib/state.ts';
import { mergeServerState, toProgress } from '../src/lib/api/progress.ts';
import projects from '../content/projects.json' with { type: 'json' };

const DAY = 86400;
const WICK = 7 * DAY;
/** Monday 2026-10-05, inside a wick. */
const NOW = Date.UTC(2026, 9, 5, 12) / 1000;

const key = (t: Tile) => `${t.tx},${t.ty}`;
const inExit = (exits: readonly ChunkExit[], t: Tile) => exits.some((e) => t.tx >= e.tx && t.tx < e.tx + e.tw && t.ty >= e.ty && t.ty < e.ty + e.th);

function reach(w: ChunkTerrain, from: Tile): Set<string> {
  const seen = new Set([key(from)]);
  const q = [from];
  while (q.length) {
    const t = q.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { tx: t.tx + dx, ty: t.ty + dy };
      if (n.tx < 0 || n.ty < 0 || n.tx >= w.width || n.ty >= w.height || w.solid[n.ty][n.tx] || seen.has(key(n))) continue;
      seen.add(key(n));
      q.push(n);
    }
  }
  return seen;
}

/** A year of wicks (every Mark) for three world seeds. */
function outerEpochs(): Epoch[] {
  const out: Epoch[] = [];
  for (const worldSeed of ['fingersnap-guest', 'oak-7', '灰烬之路']) {
    for (let w = 0; w < 12; w++) out.push({ ...guestOuterEpoch(NOW + w * WICK), worldSeed });
  }
  return out;
}

// ---------------------------------------------------------------- epochs

test('outer seasons are the wick’s UTC bounds, like the server writes them', () => {
  const d = calendarAt(NOW);
  assert.equal(outerSeasonAt(NOW), `t:${d.startsAt}:${d.nextTurning}`);
  // The wick's first second belongs to it; its end belongs to the next wick.
  assert.equal(outerSeasonAt(d.startsAt), outerSeasonAt(NOW));
  assert.equal(outerSeasonAt(d.nextTurning - 1), outerSeasonAt(NOW));
  assert.notEqual(outerSeasonAt(d.nextTurning), outerSeasonAt(NOW));
  assert.equal(outerSeasonAt(d.nextTurning), `t:${d.nextTurning}:${d.nextTurning + WICK}`);
  const e = guestOuterEpoch(NOW);
  assert.deepEqual(e, { worldSeed: 'fingersnap-guest', regionId: OUTER_REGION_ID, generatorVersion: 1, season: outerSeasonAt(NOW) });
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

// ---------------------------------------------------------------- the crossing

test('the crossing joins the Tangle’s far side to the outer entry, both ways', () => {
  const inner: Epoch = { worldSeed: 'fingersnap-guest', regionId: 'inner-1', generatorVersion: 1, season: '0' };
  const outer = guestOuterEpoch(NOW);
  const t = chunkTerrain(inner, CROSSING_CHUNK.cx, CROSSING_CHUNK.cy);
  const over = t.exits.find((e) => e.toRegion === OUTER_REGION_ID);
  assert.ok(over, 'the Tangle’s north-middle chunk has the crossing');
  assert.equal(over.dir, 'north');
  assert.equal(over.to, 'chunk:outer-1:1:1');
  assert.equal(crossingExit('inner-1', 0, 0), null);
  assert.equal(crossingExit('outer-1', 1, 0), null);
  // No other Tangle chunk leads out of the region.
  for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 3; cx++) {
    if (cx === CROSSING_CHUNK.cx && cy === CROSSING_CHUNK.cy) continue;
    assert.ok(chunkTerrain(inner, cx, cy).exits.every((e) => !e.toRegion), `Tangle ${cx},${cy}`);
  }
  const o = chunkTerrain(outer, 1, 1);
  const back = o.exits.find((e) => e.toRegion === 'inner-1');
  assert.ok(back, 'the outer entry’s way home leads back over the crossing');
  assert.equal(back.to, `chunk:inner-1:${CROSSING_CHUNK.cx}:${CROSSING_CHUNK.cy}`);
  assert.ok(o.exits.every((e) => e.to !== 'commons'), 'only the Tangle reaches the Commons');
  // Each side's arrival is walkable, outside any exit, and reaches the way back.
  assert.deepEqual(over.entry, o.spawn, 'crossing over lands at the outer entry’s arrival');
  for (const [land, w, way] of [[over.entry, o, back], [back.entry, t, over]] as const) {
    assert.equal(w.solid[land.ty][land.tx], false);
    assert.ok(!inExit(w.exits, land));
    assert.ok(reach(w, land).has(`${way.tx},${way.ty}`));
  }
});

// ---------------------------------------------------------------- outer chunks

test('every outer chunk keeps entities, sites and exits reachable, borders sealed', () => {
  for (const epoch of outerEpochs()) {
    for (let cy = 0; cy < 3; cy++) {
      for (let cx = 0; cx < 3; cx++) {
        const where = `${epoch.worldSeed} ${epoch.season} ${cx},${cy}`;
        const w = chunkTerrain(epoch, cx, cy);
        assert.equal(w.look, 'outer');
        assert.equal(w.mark, seasonMark(epoch.season));
        const r = reach(w, w.spawn);
        for (const e of w.exits) for (let y = e.ty; y < e.ty + e.th; y++) for (let x = e.tx; x < e.tx + e.tw; x++) assert.ok(r.has(`${x},${y}`), `${where}: exit ${e.to} at ${x},${y}`);
        for (const en of chunkEntities(epoch, cx, cy)) assert.ok(r.has(key(en)), `${where}: ${en.id}`);
        for (const s of w.sites) {
          assert.ok(r.has(key(s)), `${where}: site ${s.id}`);
          for (const en of chunkEntities(epoch, cx, cy)) assert.ok(en.tx !== s.tx || en.ty !== s.ty, `${where}: ${s.id} on ${en.id}`);
          if (s.kind === 'reeds') assert.equal(w.ground[s.ty - 1][s.tx], TANGLE_GROUND.water, `${where}: a reed site’s pool`);
        }
        for (let i = 0; i < w.width; i++) {
          for (const t of [{ tx: i, ty: 0 }, { tx: i, ty: w.height - 1 }, { tx: 0, ty: i }, { tx: w.width - 1, ty: i }]) {
            if (!w.solid[t.ty][t.tx]) assert.ok(inExit(w.exits, t), `${where}: open border ${key(t)}`);
          }
        }
        // Turncaps lean east out here, toward Sallow Ford.
        for (const d of w.decor.filter((x) => x.kind === 'turncaps')) assert.equal(d.flip, true, `${where}: turncap leans west`);
      }
    }
  }
});

test('a new wick is different land: terrain and sites move', () => {
  const a = guestOuterEpoch(NOW);
  const b = guestOuterEpoch(NOW + WICK);
  assert.notDeepEqual(chunkTerrain(a, 0, 0).solid, chunkTerrain(b, 0, 0).solid);
  assert.notDeepEqual(siteChunks(a), siteChunks(b));
});

// ---------------------------------------------------------------- sites and Echoes

test('story sites are deterministic and complete per epoch', () => {
  for (const epoch of outerEpochs()) {
    const chunks = siteChunks(epoch);
    assert.deepEqual(siteChunks(epoch), chunks);
    assert.deepEqual(chunks.map((s) => s.id).sort(), ['cairn', 'echo:0', 'echo:1', 'echo:2', 'given', 'nest', 'reeds']);
    assert.deepEqual(chunks.find((s) => s.id === 'given'), { id: 'given', kind: 'given', cx: 1, cy: 1 });
    assert.equal(chunks.find((s) => s.id === 'echo:0')!.cx, 2, 'one Echo always waits in the far east');
    let placed = 0;
    for (let cy = 0; cy < 3; cy++) for (let cx = 0; cx < 3; cx++) {
      const sites = chunkTerrain(epoch, cx, cy).sites;
      assert.deepEqual(sites, chunkSites(epoch, cx, cy, chunkTerrain(epoch, cx, cy).exits));
      placed += sites.length;
    }
    assert.equal(placed, chunks.length, `${epoch.season}: every site found a spot`);
  }
  const inner: Epoch = { worldSeed: 'x', regionId: 'inner-1', generatorVersion: 1, season: '0' };
  assert.deepEqual(siteChunks(inner), [{ id: 'plank', kind: 'plank', cx: 1, cy: 0 }]);
});

test('Echo assignments: deterministic, one camp per member, twins late, Tam east', () => {
  const lateSeen = new Set<string>();
  for (let w = 0; w < 40; w++) {
    const epoch = guestOuterEpoch(NOW + w * WICK);
    const sites = siteChunks(epoch);
    for (const late of [false, true]) {
      const a = echoAssignments(epoch, sites, late);
      assert.deepEqual([...a.entries()], [...echoAssignments(epoch, sites, late).entries()]);
      const members = [...a.values()].map((e) => e.member);
      assert.equal(new Set(members).size, members.length, 'no member waits in two camps');
      assert.equal(a.size, 3);
      for (const [id, def] of a) {
        if (def.late) assert.ok(late, `${def.member} before the road is lit`);
        if (def.east) assert.equal(sites.find((s) => s.id === id)!.cx, 2, 'Tam only in the far east');
        if (late) lateSeen.add(def.member);
      }
    }
  }
  assert.deepEqual([...lateSeen].sort(), ECHOES.map((e) => e.member).sort(), 'every Echo turns up over the year');
});

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
  // Never uploaded.
  const up = toProgress(v) as unknown as Record<string, unknown>;
  assert.equal('wildsRegion' in up || 'outerSeason' in up, false);
  // A merge keeps the marker only while the position it describes stands.
  const server = { ...createNewGame(), area: 'wilds' as const, position: { x: 424, y: 744 } };
  assert.equal(mergeServerState(v, server, 'keep-local').wildsRegion, 'outer-1');
  assert.equal(mergeServerState(v, server, 'server').wildsRegion, 'outer-1');
  assert.equal(mergeServerState(v, { ...server, position: { x: 30, y: 30 } }, 'server').wildsRegion, undefined);
  assert.equal(mergeServerState(v, { ...server, position: { x: 30, y: 30 } }, 'server').outerSeason, outerSeasonAt(NOW));
});

test('days in a wick are calendar days (sanity for the guest clock)', () => {
  const d = calendarAt(NOW);
  assert.equal(d.nextTurning - d.startsAt, WICK);
  assert.ok(NOW >= d.startsAt && NOW < d.nextTurning);
  void DAY;
});
