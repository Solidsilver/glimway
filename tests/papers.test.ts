import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generate, OUT_FILE, paperCatalog, PAPERS_JSON_FILE, renderPapersJSON } from '../scripts/papers.ts';
import {
  allPlacements,
  designedRule,
  beatsDue,
  foundPapers,
  handoverFor,
  PAPER_COLLECTIONS,
  paperFlag,
  PAPERS,
  placedPapersIn,
  type LaterKind,
} from '../src/content/papers.ts';
import { parseBody, parseInline, lineText } from '../src/lib/papers/markup.ts';
import {
  createRemoteLibrary,
  donationFlag,
  localDonations,
  mergeShelf,
  parseShelves,
  startingShelf,
} from '../src/lib/papers/library.ts';
import { buildArea, type WorldData } from '../src/game/worlds.ts';
import { AREAS, type AreaId } from '../src/lib/state.ts';
import { isClientMark } from '../src/lib/api/predict.ts';
import { createNewGame } from '../src/lib/state.ts';

// ------------------------------------------------------------ content

test('the generated papers module matches docs/lore/texts (run `npm run papers`)', () => {
  assert.equal(readFileSync(OUT_FILE, 'utf8'), generate());
});

test('the shared catalog the server embeds matches the client papers (run `npm run papers`)', () => {
  // Byte-for-byte against a fresh regeneration, so an edited find source or a
  // new paper cannot reach the server without `content/papers.json` following.
  assert.equal(readFileSync(PAPERS_JSON_FILE, 'utf8'), renderPapersJSON());
  const rows = paperCatalog();
  assert.equal(rows.length, PAPERS.length);
  for (const [i, p] of PAPERS.entries()) {
    assert.deepEqual(rows[i], { id: p.id, collection: p.collection, source: p.source.kind, section: p.section, rule: designedRule(p.id) });
  }
});

test('all 52 texts, in the README’s 8 collections, each with a find source', () => {
  assert.equal(PAPERS.length, 52);
  assert.equal(PAPER_COLLECTIONS.length, 8);
  assert.equal(new Set(PAPERS.map((p) => p.id)).size, 52);
  for (const p of PAPERS) {
    assert.ok(p.title && p.description && p.body.length > 100, `${p.id} has text`);
    assert.ok(PAPER_COLLECTIONS.includes(p.collection));
    assert.ok(p.hint.length > 0);
    assert.ok(!/^#\s/m.test(p.body), `${p.id}: title heading stripped from body`);
    assert.ok(!/^\*From\s+["“]/m.test(p.body), `${p.id}: collection footer stripped from body`);
    // Server limit on a story flag is 128 characters.
    assert.ok(donationFlag(p.id, new Date(2026, 9, 4)).length <= 128);
  }
});

const LATER: LaterKind[] = ['commons', 'wilds-poi', 'wilds-chest', 'village-project', 'turning', 'echo'];

test('reveal order: the survival texts come late, never early', () => {
  const late = [
    'note-in-the-linseed-box',
    'joss-penhallow-letter-map-case',
    'count-house-tally-book-scrap',
    'nan-greer-trail-journal',
    'joss-penhallow-field-notes-pencil-map',
    'silas-pine-offcut-scrap',
    // The writer's thirteen: the river giving foxes back, the Whitequiet
    // keeping the Six's things, Tam "almost to the light", Bett's Echo.
    'forty-one-and-holding',
    'the-jackdaws-display',
    'tams-ox-words',
    'betts-flat-verse',
  ];
  for (const id of late) {
    const p = PAPERS.find((x) => x.id === id)!;
    assert.ok((LATER as string[]).includes(p.source.kind), `${id} must wait for a later system, not ${p.source.kind}`);
  }
  // Anything findable before the road is lit (starting shelf, world
  // pickups, quest beats before the lantern) is free of those spoilers.
  const early = PAPERS.filter(
    (p) =>
      p.source.kind === 'library-start' ||
      (p.source.kind === 'placed' && !p.source.after) ||
      (p.source.kind === 'quest' && p.source.stage !== 'lantern-lit' && p.source.stage !== 'complete'),
  );
  assert.ok(early.some((p) => p.id === 'eleven-days'), 'the warden beat counts as early');
  for (const p of early) {
    assert.ok(
      !/Sallow Ford lamp|Hollis keeps the lamp|Account 404|almost to the light|walk back and pick them up|bringing things back|foxes in (the|this) box/i.test(p.body),
      `${p.id} spoils the Six`,
    );
  }
});

test('the library starts with public papers on its shelves', () => {
  const start = startingShelf();
  assert.equal(start.length, 13);
  for (const id of ['the-carters-compact', 'the-twelve-wicks', 'oak-hall-edict-on-the-stealing-of-shade', 'dangers-of-the-white-quiet-pamphlet', 'twoford-almanac-silas-copy', 'brackenwood-cutters-handbook', 'the-boy-who-ran-faster-than-the-wick']) {
    assert.ok(start.some((e) => e.paperId === id), `${id} on the starting shelf`);
  }
});

test('found papers are story flags `paper:<id>`; unknown ids are ignored', () => {
  assert.deepEqual(foundPapers(['paper:will-of-elias-fenn', 'paper:nope', 'lit:road-1', 'paper:will-of-elias-fenn']), ['will-of-elias-fenn']);
});

test('paper and donation marks are written by the server only (never a client mark)', () => {
  for (const f of [paperFlag('will-of-elias-fenn'), donationFlag('will-of-elias-fenn', new Date())]) assert.equal(isClientMark(f), false);
});

// ------------------------------------------------------------ placement

type Tile = { tx: number; ty: number };
const key = (t: Tile) => `${t.tx},${t.ty}`;
const worlds = Object.fromEntries(AREAS.map((a) => [a, buildArea(a)])) as Record<AreaId, WorldData>;

/** Same conservative collision model as tests/worlds.test.ts. */
function blockedTiles(w: WorldData): Set<string> {
  const out = new Set<string>();
  for (let y = 0; y < w.height; y++) for (let x = 0; x < w.width; x++) if (w.solid[y][x]) out.add(key({ tx: x, ty: y }));
  const spots: Tile[] = [...w.trees, ...w.bushes, ...w.rocks, ...w.npcs, ...w.props];
  if (w.well) spots.push(w.well);
  if (w.mural) spots.push(w.mural);
  for (const s of spots) out.add(key(s));
  return out;
}

function reachable(w: WorldData): Set<string> {
  const blocked = blockedTiles(w);
  const seen = new Set<string>([key(w.spawn)]);
  const queue: Tile[] = [w.spawn];
  while (queue.length) {
    const t = queue.shift()!;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = { tx: t.tx + dx, ty: t.ty + dy };
      if (n.tx < 0 || n.ty < 0 || n.tx >= w.width || n.ty >= w.height) continue;
      if (seen.has(key(n)) || blocked.has(key(n))) continue;
      seen.add(key(n));
      queue.push(n);
    }
  }
  return seen;
}

test('every placed paper lies on a walkable, reachable tile off exits and away from other interactions', () => {
  const placements = allPlacements();
  assert.ok(placements.length >= 9);
  for (const area of AREAS) {
    assert.ok(placements.filter((p) => p.source.area === area).length >= 3, `a few papers in ${area}`);
  }
  for (const p of placements) {
    const w = worlds[p.source.area];
    const t = { tx: p.source.tx, ty: p.source.ty };
    assert.ok(!blockedTiles(w).has(key(t)), `${p.id} at ${key(t)} is not walkable`);
    assert.ok(reachable(w).has(key(t)), `${p.id} at ${key(t)} cannot be reached from the spawn`);
    assert.ok(!w.exits.some((e) => t.tx >= e.tx - 1 && t.tx <= e.tx + e.tw && t.ty >= e.ty - 1 && t.ty <= e.ty + e.th), `${p.id} sits on an exit`);
    // Three tiles from anything else you press E at, so prompts never fight.
    const others: Tile[] = [...w.npcs, ...w.emberSpots, ...w.discoverySpots];
    for (const s of [w.mural, w.shrine, w.library]) if (s) others.push(s);
    for (const q of placements) if (q !== p && q.source.area === p.source.area) others.push(q.source);
    for (const o of others) assert.ok(Math.hypot(o.tx - t.tx, o.ty - t.ty) >= 3, `${p.id} is crowded by ${key(o)}`);
  }
});

test('the library door is in the village and can be walked up to', () => {
  const w = worlds.village;
  assert.ok(w.library, 'village has a library');
  const below = { tx: w.library!.tx, ty: w.library!.ty + 1 };
  assert.ok(reachable(w).has(key(below)), 'the tile in front of the door is reachable');
  assert.ok(!worlds.woodland.library && !worlds.ruin.library);
});

test('placed papers disappear once found, and wait for their quest stage', () => {
  const before = placedPapersIn('village', 'new', []);
  assert.ok(before.some((p) => p.id === 'pip-copybook-warden-corrections'));
  const after = placedPapersIn('village', 'new', [paperFlag('pip-copybook-warden-corrections')]);
  assert.ok(!after.some((p) => p.id === 'pip-copybook-warden-corrections'));
});

// ------------------------------------------------------------ handovers and beats

test('Mara hands over the ledger only once the clue is found, with words fit for the moment', () => {
  assert.equal(handoverFor('mara', 'accepted', []), null);
  const early = handoverFor('mara', 'clue-found', []);
  assert.equal(early?.paperId, 'ashwatch-ledger-excerpts');
  assert.match(early!.lines.join(' '), /before you climb/);
  const late = handoverFor('mara', 'complete', []);
  assert.equal(late?.paperId, 'ashwatch-ledger-excerpts');
  assert.doesNotMatch(late!.lines.join(' '), /before you climb/);
  // Ledger first, then her after-quest gift.
  const next = handoverFor('mara', 'complete', [paperFlag('ashwatch-ledger-excerpts')]);
  assert.equal(next?.paperId, 'elara-quill-field-notes-turncaps');
  assert.equal(handoverFor('mara', 'complete', [paperFlag('ashwatch-ledger-excerpts'), paperFlag('elara-quill-field-notes-turncaps')]), null);
});

test('gifts wait for the end of the main quest', () => {
  assert.equal(handoverFor('hazel', 'lantern-lit', []), null);
  // Hazel hands over her own card now (it was Pip's errand before she was in the world).
  assert.equal(handoverFor('hazel', 'complete', [])?.paperId, 'keepers-twists-recipe-card');
  assert.equal(handoverFor('pip', 'complete', []), null);
  assert.equal(handoverFor('orrin', 'complete', [])?.paperId, 'orrins-workshop-rules');
});

test('the warden and shrine-ledge beats arrive with their quest stages', () => {
  assert.deepEqual(beatsDue('clue-found', []).map((p) => p.id), []);
  assert.deepEqual(beatsDue('guardian-defeated', []).map((p) => p.id), ['eleven-days']);
  assert.deepEqual(beatsDue('lantern-lit', [paperFlag('eleven-days')]).map((p) => p.id), ['principia-memoria-excerpt']);
  assert.deepEqual(beatsDue('complete', [paperFlag('eleven-days'), paperFlag('principia-memoria-excerpt')]), []);
});

// ------------------------------------------------------------ markup

test('inline emphasis: bold, italic, pencil; stray asterisks stay literal', () => {
  assert.deepEqual(parseInline('**Caller:** The *water* `pencil`'), [
    { text: 'Caller:', b: true },
    { text: ' The ' },
    { text: 'water', i: true },
    { text: ' ' },
    { text: 'pencil', pencil: true },
  ]);
  assert.equal(lineText(parseInline('3 * 4 = 12')), '3 * 4 = 12');
});

test('body blocks: verses keep their line breaks, asides introduce handwriting, signatures sit right', () => {
  const blocks = parseBody('Crack the shell,\nHere comes the fleet.\n\n- Dad\n\n*(On the reverse, in the same hand:)*\n\nP.S. Clean the grate.\n\n- one\n- two');
  assert.equal(blocks[0].kind, 'para');
  assert.equal(blocks[0].kind === 'para' && blocks[0].lines.length, 2);
  assert.deepEqual(blocks.map((b) => (b.kind === 'heading' ? 'h' : `${b.kind}:${b.tone}`)), ['para:plain', 'para:sign', 'para:aside', 'para:hand', 'list:hand']);
});

test('every text parses into something readable', () => {
  for (const p of PAPERS) {
    const blocks = parseBody(p.body);
    assert.ok(blocks.length >= 2, `${p.id} has blocks`);
    const text = blocks.map((b) => (b.kind === 'para' ? b.lines.map(lineText).join(' ') : b.kind === 'list' ? b.items.map(lineText).join(' ') : lineText(b.line))).join(' ');
    assert.ok(!text.includes('**'), `${p.id}: no stray bold markers`);
  }
});

// ------------------------------------------------------------ library

test('the shelf: starting books, then the earliest donation of each paper', () => {
  const shelf = mergeShelf(
    [{ paperId: 'will-of-elias-fenn', donatedBy: 'Tansy', donatedAt: '2026-10-03' }],
    [
      { paperId: 'will-of-elias-fenn', donatedBy: 'Wren', donatedAt: '2026-10-01' },
      { paperId: 'oak-hall-edict-on-the-stealing-of-shade', donatedBy: 'Wren', donatedAt: '2026-10-01' },
      { paperId: 'not-a-paper', donatedBy: 'Wren', donatedAt: '2026-10-01' },
    ],
  );
  assert.equal(shelf.size, 14);
  assert.equal(shelf.get('will-of-elias-fenn')?.donatedBy, 'Wren');
  assert.equal(shelf.get('oak-hall-edict-on-the-stealing-of-shade')?.donatedBy, null, 'the starting copy stays the credited one');
});

test('local donations round-trip through save flags', () => {
  const flag = donationFlag('will-of-elias-fenn', new Date(2026, 9, 4));
  assert.equal(flag, 'donated:will-of-elias-fenn@2026-10-04');
  assert.deepEqual(localDonations([flag, 'donated:bogus@2026-10-04', 'paper:will-of-elias-fenn'], 'Wren'), [
    { paperId: 'will-of-elias-fenn', donatedBy: 'Wren', donatedAt: '2026-10-04' },
  ]);
});

test('server shelves are validated', () => {
  assert.equal(parseShelves({}), null);
  assert.deepEqual(parseShelves({ shelves: [{ paperId: 'will-of-elias-fenn', donatedBy: ' Tansy ', donatedAt: '2026-10-04T10:00:00Z' }, { paperId: 'x' }, 7] }), [
    { paperId: 'will-of-elias-fenn', donatedBy: 'Tansy', donatedAt: '2026-10-04T10:00:00Z' },
  ]);
});

function fakeFetch(status: number, body: unknown, type = 'application/json'): { fetchImpl: typeof fetch; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': type } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test('remote library: a 404 or an HTML page means "no library here" (fall back to local)', async () => {
  assert.deepEqual(await createRemoteLibrary(fakeFetch(404, { error: { code: 'not-found' } })).load(), { ok: false, reason: 'unsupported' });
  assert.deepEqual(await createRemoteLibrary(fakeFetch(200, '<html></html>', 'text/html')).load(), { ok: false, reason: 'unsupported' });
});

test('remote library: shelves and a dead network (donations go through the outbox)', async () => {
  const entry = { paperId: 'will-of-elias-fenn', donatedBy: 'Tansy', donatedAt: '2026-10-04T10:00:00Z' };
  assert.deepEqual(await createRemoteLibrary(fakeFetch(200, { shelves: [entry] })).load(), { ok: true, shelves: [entry] });
  const dead = { fetchImpl: (async () => { throw new TypeError('network'); }) as unknown as typeof fetch };
  assert.deepEqual(await createRemoteLibrary(dead).load(), { ok: false, reason: 'offline' });
});
