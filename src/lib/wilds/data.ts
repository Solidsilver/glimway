/**
 * Typed loader for content/wilds.json — the canonical shared generator data.
 * The schema and its field rules live in proto/glimway/content/v1/wilds.proto;
 * the generated types are read here (the client reads sizes, timers,
 * catalogues, grounds and decor) and by the server's generator via
 * content/wilds.go.
 */
import raw from '../../../content/wilds.json' with { type: 'json' };
import { decodeContent } from '../content-proto.ts';
import { WildsSchema } from '../gen/glimway/content/v1/wilds_pb.js';
import type { WildsData, WildsEntityKind, WildsGround } from './types.ts';

/** Every loot table a spawn rule of the kind rolls on. */
function lootTableIds(kind: WildsEntityKind, materials: string[]): string[] {
  switch (kind) {
    case 'camp': return ['camp'];
    case 'node': return materials.map((m) => `node:${m}`);
    case 'chest': return ['chest:1', 'chest:2', 'chest:3'];
    default: return ['poi'];
  }
}

/**
 * The rules that span entries, the twin of Go's wildsRules
 * (content/wilds.go), word for word: both refuse the shared vectors with
 * the same message.
 */
function wildsRules(w: WildsData): void {
  const bad = (msg: string): never => {
    throw new Error(`invalid wilds: ${msg}`);
  };
  const q = (s: string) => JSON.stringify(s);
  const unique = (field: string, ids: string[]) => {
    const seen = new Set<string>();
    for (const id of ids) {
      if (seen.has(id)) bad(`duplicate ${field} ${id}`);
      seen.add(id);
    }
  };

  // Catalogues.
  const mixIds = w.campMixes.map((m) => m.id);
  const groundIds = w.grounds.map((g) => g.id);
  const decorIds = w.decor.map((d) => d.kind);
  const landIds = w.lands.map((l) => l.id);
  const placeIds = w.places.map((p) => p.id);
  const kindIds = w.placeKinds.map((k) => k.id);
  const uniques: [string, string[]][] = [
    ['camp mix', mixIds],
    ['ground', groundIds],
    ['ground terrain', w.grounds.map((g) => g.terrain)],
    ['decor kind', decorIds],
    ['land', landIds],
    ['place', placeIds],
    ['place kind', kindIds],
    ['lay kind', w.paths.lay.map((l) => l.kind)],
    ['compass dir', w.rumour.compass.map((c) => c.dir)],
    ['distance ring', w.rumour.distance.map((d) => String(d.ring))],
  ];
  for (const [field, ids] of uniques) unique(field, ids);
  const ground = (id: string) => w.grounds.find((g) => g.id === id);
  const decor = (id: string) => w.decor.find((d) => d.kind === id);
  const needGround = (where: string, id: string, ...surfaces: string[]) => {
    const g = ground(id);
    if (!g) return bad(`${where}: unknown ground ${q(id)}`);
    if (surfaces.length && !surfaces.includes(g.surface)) bad(`${where}: ground ${q(id)} is ${g.surface}, not ${surfaces[0]}`);
  };
  const weights = (where: string, what: string, ws: { id: string }[], known: string[]) => {
    const seen = new Set<string>();
    for (const x of ws) {
      if (!known.includes(x.id)) bad(`${where}: unknown ${what} ${q(x.id)}`);
      if (seen.has(x.id)) bad(`${where}: ${what} ${q(x.id)} weighted twice`);
      seen.add(x.id);
    }
  };

  // Camps and loot.
  w.campMixes.forEach((mix, i) => {
    for (const e of mix.enemies) if (!w.enemyKinds.includes(e)) bad(`campMixes[${i}]: unknown enemy kind ${q(e)}`);
  });
  const need = ['discovery', 'rumour'];
  for (const k of w.entityKinds) need.push(...lootTableIds(k.kind, w.materials));
  for (const t of w.tiers) for (let c = t.chestMin; c <= t.chestMax; c++) need.push(`chest:${c}`);
  for (const id of need) if (!(id in w.lootTables)) bad(`missing loot table ${q(id)}`);
  // Sorted table ids, so the same table is named every run (Go's map
  // iteration isn't; both sides spell the same message).
  for (const id of Object.keys(w.lootTables).sort()) {
    for (const e of w.lootTables[id]!.entries) {
      if (!w.materials.includes(e.material)) bad(`loot table ${q(id)}: unknown material ${q(e.material)}`);
    }
  }

  // Lands.
  for (const l of w.lands) {
    const where = `land ${l.id}`;
    const g = l.ground;
    for (const id of [g.floor, g.open, g.verge, g.path, g.trodden]) needGround(where, id, 'land');
    weights(where, 'decor kind', l.decor, decorIds);
    weights(where, 'material', l.materials, w.materials);
    weights(where, 'camp mix', l.campMixes, mixIds);
  }
  w.landSizes.bands.forEach((b, i) => {
    if (b.maxChunks > w.landSizes.capChunks) bad(`landSizes.bands[${i}]: past the cap`);
  });

  // Tiers: 1..n in order.
  w.tiers.forEach((t, i) => {
    if (t.tier !== i + 1) bad(`tiers[${i}]: tier ${t.tier} out of order`);
    weights(`tier ${i + 1}`, 'camp mix', t.campMixes, mixIds);
  });

  // Places: apart, one cell each; sites and openings on them.
  w.places.forEach((a, i) => {
    for (const b of w.places.slice(i + 1)) {
      if (a.cx < b.cx + b.width && b.cx < a.cx + a.width && a.cy < b.cy + b.height && b.cy < a.cy + a.height) bad(`places ${a.id} and ${b.id} overlap`);
    }
  });
  const S = w.chunkSize;
  const cells = w.cells;
  const siteIds: string[] = [];
  for (const p of w.places) {
    const where = `place ${p.id}`;
    if (!landIds.includes(p.land)) bad(`${where}: unknown land ${q(p.land)}`);
    if (p.tier > w.tiers.length) bad(`${where}: unknown tier ${p.tier}`);
    const x0 = p.cx - cells.originCx;
    const y0 = p.cy - cells.originCy;
    if (p.width !== cells.cellChunks || p.height !== cells.cellChunks || x0 % cells.cellChunks !== 0 || y0 % cells.cellChunks !== 0) bad(`${where}: footprint is not one cell`);
    const inside = (cx: number, cy: number) => cx >= p.cx && cy >= p.cy && cx < p.cx + p.width && cy < p.cy + p.height;
    for (const s of p.sites) {
      siteIds.push(s.id);
      if (!inside(s.cx, s.cy) || s.tx >= S || s.ty >= S) bad(`${where}: site ${s.id} outside the footprint`);
    }
    for (const s of p.dealt) siteIds.push(s.id);
    for (const o of p.openings) {
      let onEdge = inside(o.cx, o.cy);
      switch (o.edge) {
        case 'north': onEdge &&= o.cy === p.cy; break;
        case 'south': onEdge &&= o.cy === p.cy + p.height - 1; break;
        case 'west': onEdge &&= o.cx === p.cx; break;
        default: onEdge &&= o.cx === p.cx + p.width - 1;
      }
      if (!onEdge || o.offset + o.width > S) bad(`${where}: opening ${o.id} off the footprint's edge`);
    }
    unique(`${where} opening`, p.openings.map((o) => o.id));
  }
  unique('site', siteIds);

  // Paths.
  for (const c of w.paths.clearTools) if (!decor(c.decor)) bad(`paths.clearTools: unknown decor kind ${q(c.decor)}`);
  for (const l of w.paths.lay) {
    needGround(`paths.lay ${l.kind}`, l.ground, 'laid');
    if (!w.materials.includes(l.material)) bad(`paths.lay ${l.kind}: unknown material ${q(l.material)}`);
  }
  for (const s of w.paths.walk) needGround('paths.walk', s.ground);

  // The river and the road.
  const r = w.river;
  needGround('river', r.waterGround, 'water');
  needGround('river', r.bankGround, 'land');
  needGround('river', r.fordGround, 'ford');
  if (!landIds.includes(r.leanLand)) bad(`river: unknown land ${q(r.leanLand)}`);
  const road = w.road;
  needGround('road', road.ground, 'road');
  needGround('road', road.vergeGround);
  const from = w.places.find((p) => p.id === road.fromPlace);
  if (!from || !from.openings.some((o) => o.id === road.fromOpening)) bad(`road: unknown opening ${road.fromPlace}/${road.fromOpening}`);

  // Place kinds and the rumour.
  const rumour = w.rumour;
  for (const l of rumour.landmarks) if (!decor(l.decor)) bad(`rumour: unknown decor kind ${q(l.decor)}`);
  for (const k of w.placeKinds) {
    const where = `place kind ${k.id}`;
    if (!landIds.includes(k.land)) bad(`${where}: unknown land ${q(k.land)}`);
    if (!decor(k.landmark)?.blocking) bad(`${where}: landmark ${q(k.landmark)} is not a blocking decor kind`);
    if (!rumour.landmarks.some((l) => l.decor === k.landmark)) bad(`${where}: landmark ${q(k.landmark)} has no rumour phrase`);
  }
  const phrases = [rumour.template, rumour.pastRiver, rumour.opened, rumour.none,
    ...rumour.landmarks.map((l) => l.phrase), ...rumour.compass.map((c) => c.phrase), ...rumour.distance.map((d) => d.phrase)];
  for (const p of phrases) if (/[0-9]/.test(p)) bad(`rumour: a digit in ${q(p)}`);
}

/**
 * Validate the raw shared data. Throws with a precise message on anything
 * the generators cannot rely on; both language test suites run this check.
 */
export function validateWildsData(value: unknown): WildsData {
  const doc = decodeContent(WildsSchema, value, 'wilds', ['campMixes', 'grounds', 'places', 'lands', 'placeKinds']) as unknown as WildsData;
  wildsRules(doc);
  return doc;
}

let cached: WildsData | null = null;

/** Validated shared data, loaded once. */
export function loadWilds(): WildsData {
  if (!cached) cached = validateWildsData(raw);
  return cached;
}

/** The ground with the content id; throws on a broken build. */
export function wildsGround(id: string): WildsGround {
  const g = loadWilds().grounds.find((x) => x.id === id);
  if (!g) throw new Error(`wilds: no ground ${id}`);
  return g;
}
