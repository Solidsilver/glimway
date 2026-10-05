/**
 * The outer Wilds and the Turning — pure rules shared by the client and its
 * tests. No rendering, no network.
 *
 * Epochs: the inner region (the Tangle) is permanent (season "0"). The outer
 * region turns every wick: its season is `t:<startsAt>:<endsAt>` — the
 * wick's UTC boundaries in Unix seconds, exactly what the server writes
 * (server/internal/api/wilds.go ensureEpoch). Connected play takes the
 * server's epoch; guests compute the same season from the shared calendar
 * (content/calendar.json) with their own fixed world seed.
 *
 * The crossing: the Tangle's far side (the north edge of its north-middle
 * chunk, opposite the Commons) opens into the outer region's entry chunk
 * through that chunk's "way home" gap. The crossing is client-only terrain:
 * the generator's exit list — which feeds the server-reproduced entity
 * placement — never changes; chunkTerrain adds the crossing on top.
 *
 * Story sites: places in a chunk that are not generated entities and never
 * reach the server — Echo camps, and the spots where the outer Wilds give
 * back a found text. They are deterministic from the epoch (a new wick moves
 * them) and terrain clears around them like an entity.
 */
import { CALENDAR, calendarAt, type Calendar } from '../calendar.ts';
import { chunkEntities } from './gen-v1.ts';
import { hash, chunkSeed, type SeedEpoch } from './hash.ts';
import { loadWilds } from './data.ts';
import type { ChunkExit, Epoch, Tile, WildsRegion } from './types.ts';

export const INNER_REGION_ID = 'inner-1';
export const OUTER_REGION_ID = 'outer-1';

/** Guests' world seed (both regions). */
export const GUEST_WORLD_SEED = 'fingersnap-guest';

// ------------------------------------------------------------ epochs

/** The outer season for a moment: the wick it falls in, by its UTC bounds. */
export function outerSeasonAt(unix: number, cal: Calendar = CALENDAR): string {
  const d = calendarAt(Math.floor(unix), cal);
  return `t:${d.startsAt}:${d.nextTurning}`;
}

/** A guest's outer epoch right now (same season rule as the server). */
export function guestOuterEpoch(unix: number, cal: Calendar = CALENDAR): Epoch {
  return { worldSeed: GUEST_WORLD_SEED, regionId: OUTER_REGION_ID, generatorVersion: 1, season: outerSeasonAt(unix, cal) };
}

/**
 * The wick bounds a season names, or null for a permanent one ("0").
 * Older numeric seasons (an absolute wick number) are read through the
 * calendar so they keep working.
 */
export function seasonBounds(season: string, cal: Calendar = CALENDAR): { startsAt: number; endsAt: number } | null {
  const t = /^t:(-?\d+):(-?\d+)$/.exec(season);
  if (t) return { startsAt: Number(t[1]), endsAt: Number(t[2]) };
  const n = Number(season);
  if (!Number.isSafeInteger(n) || n === 0 || season.trim() !== season || season === '') return null;
  const epoch = Date.parse(cal.epoch) / 1000;
  const duration = cal.wickDays * 86400;
  const startsAt = epoch + (n - 1) * duration;
  return { startsAt, endsAt: startsAt + duration };
}

/** The Mark (Mudrise, Carting, Amberfall, Quiet) an outer season falls in. */
export function seasonMark(season: string, cal: Calendar = CALENDAR): string | null {
  const b = seasonBounds(season, cal);
  return b ? calendarAt(b.startsAt, cal).mark : null;
}

/** The wick name an outer season falls in (Thaw … Quiet). */
export function seasonWick(season: string, cal: Calendar = CALENDAR): string | null {
  const b = seasonBounds(season, cal);
  return b ? calendarAt(b.startsAt, cal).wick : null;
}

/** Has this epoch ended at `unix`? Permanent epochs never do. */
export function epochEnded(season: string, unix: number, endsAt?: number | null): boolean {
  const end = endsAt ?? seasonBounds(season)?.endsAt ?? null;
  return end !== null && unix >= end;
}

// ------------------------------------------------------------ the crossing

/** The Tangle chunk whose far (north) edge opens onto the outer region. */
export const CROSSING_CHUNK = { cx: 1, cy: 0 } as const;

const EXIT_GAP = 3;
/** Matches gen-v1's commons gap (tx = 1 on the entry chunk's south edge). */
const HOME_GAP_TX = 1;

function regionById(id: string): WildsRegion {
  const r = loadWilds().regions.find((x) => x.id === id);
  if (!r) throw new Error(`wilds: unknown region ${id}`);
  return r;
}

/** Where stepping through the crossing lands in the outer entry chunk. */
export function crossingOuterArrival(): Tile {
  const S = loadWilds().chunkSize;
  return { tx: HOME_GAP_TX + 1, ty: S - 2 };
}

/** Where stepping back through the crossing lands in the Tangle. */
export function crossingInnerArrival(): Tile {
  const S = loadWilds().chunkSize;
  return { tx: S / 2, ty: 1 };
}

/**
 * The crossing as a chunk exit of the Tangle's north-middle chunk (null for
 * every other chunk or region): a 3-wide gap centred on the north edge.
 */
export function crossingExit(regionId: string, cx: number, cy: number): ChunkExit | null {
  if (regionId !== INNER_REGION_ID || cx !== CROSSING_CHUNK.cx || cy !== CROSSING_CHUNK.cy) return null;
  const S = loadWilds().chunkSize;
  const outer = regionById(OUTER_REGION_ID);
  return {
    tx: S / 2 - 1,
    ty: 0,
    tw: EXIT_GAP,
    th: 1,
    to: `chunk:${OUTER_REGION_ID}:${outer.entryX}:${outer.entryY}`,
    entry: crossingOuterArrival(),
    dir: 'north',
    toChunk: { cx: outer.entryX, cy: outer.entryY },
    toRegion: OUTER_REGION_ID,
  };
}

/**
 * The outer entry chunk's way home leads back over the crossing (the
 * generator names it `commons`; only the Tangle's entry really reaches the
 * Commons). Other exits pass through unchanged.
 */
export function routeHome(regionId: string, e: ChunkExit): ChunkExit {
  if (regionId !== OUTER_REGION_ID || e.to !== 'commons') return e;
  return {
    ...e,
    to: `chunk:${INNER_REGION_ID}:${CROSSING_CHUNK.cx}:${CROSSING_CHUNK.cy}`,
    entry: crossingInnerArrival(),
    toChunk: { ...CROSSING_CHUNK },
    toRegion: INNER_REGION_ID,
  };
}

// ------------------------------------------------------------ story sites

/**
 * - echo: a phantom camp where an Echo of the Six can wait (outer).
 * - given: where the outer Wilds give a text back, by the crossing (outer entry).
 * - cairn: the Amberwash forage cairn (outer).
 * - nest: a dead iron-oak with a jackdaw's nest (outer).
 * - reeds: a backwater of the Wend, reeds and still water (outer).
 * - plank: a plank half-buried where the bridge tore (the Tangle crossing).
 */
export type SiteKind = 'echo' | 'given' | 'cairn' | 'nest' | 'reeds' | 'plank';

export interface StorySite {
  /** Stable within the epoch: `<kind>` or `echo:<n>`. */
  id: string;
  kind: SiteKind;
  cx: number;
  cy: number;
  tx: number;
  ty: number;
}

/** Echo camps per outer epoch. */
export const ECHO_SITES = 3;

function mulberry(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Which chunk each site of an epoch sits in (cheap: no terrain, no entities). */
export function siteChunks(epoch: Epoch): { id: string; kind: SiteKind; cx: number; cy: number }[] {
  const region = regionById(epoch.regionId);
  if (region.kind !== 'outer') {
    return epoch.regionId === INNER_REGION_ID ? [{ id: 'plank', kind: 'plank', ...CROSSING_CHUNK }] : [];
  }
  const rng = mulberry(hash([epoch.worldSeed, epoch.regionId, epoch.generatorVersion, epoch.season, 'sites']));
  const all: { cx: number; cy: number }[] = [];
  for (let cy = 0; cy < region.gridHeight; cy++) for (let cx = 0; cx < region.gridWidth; cx++) all.push({ cx, cy });
  const away = all.filter((c) => c.cx !== region.entryX || c.cy !== region.entryY);
  const load = new Map<string, number>();
  const take = (pool: { cx: number; cy: number }[]): { cx: number; cy: number } => {
    // Spread out: prefer the least-used chunks, then chance.
    const least = Math.min(...pool.map((c) => load.get(`${c.cx},${c.cy}`) ?? 0));
    const options = pool.filter((c) => (load.get(`${c.cx},${c.cy}`) ?? 0) === least);
    const c = options[Math.floor(rng() * options.length)];
    load.set(`${c.cx},${c.cy}`, least + 1);
    return c;
  };
  const out: { id: string; kind: SiteKind; cx: number; cy: number }[] = [];
  out.push({ id: 'given', kind: 'given', cx: region.entryX, cy: region.entryY });
  load.set(`${region.entryX},${region.entryY}`, 1);
  // One Echo always waits in the far east column (toward Sallow Ford).
  const east = region.gridWidth - 1;
  out.push({ id: 'echo:0', kind: 'echo', ...take(away.filter((c) => c.cx === east)) });
  for (let i = 1; i < ECHO_SITES; i++) out.push({ id: `echo:${i}`, kind: 'echo', ...take(away) });
  for (const kind of ['cairn', 'nest', 'reeds'] as const) out.push({ id: kind, kind, ...take(away) });
  return out;
}

/** Tiles within the 3×3-wide margin of an exit (sites keep clear of the mouths). */
function nearExit(exits: readonly ChunkExit[], x: number, y: number, r: number): boolean {
  return exits.some((e) => x >= e.tx - r && x < e.tx + e.tw + r && y >= e.ty - r && y < e.ty + e.th + r);
}

/**
 * The story sites in one chunk, placed on tiles clear of the generated
 * entities and the exit mouths. `exits` are the chunk's terrain exits
 * (the crossing included).
 */
export function chunkSites(epoch: Epoch, cx: number, cy: number, exits: readonly ChunkExit[]): StorySite[] {
  const wanted = siteChunks(epoch).filter((s) => s.cx === cx && s.cy === cy);
  if (wanted.length === 0) return [];
  const S = loadWilds().chunkSize;
  const entities = chunkEntities(epoch, cx, cy);
  const rng = mulberry(chunkSeed(epoch as SeedEpoch, cx, cy) ^ 0x51735e7);
  const out: StorySite[] = [];
  for (const w of wanted) {
    // The plank lies just inside the crossing; the given-back spot by the way home.
    const prefer =
      w.kind === 'plank' ? { tx: S / 2 + 3, ty: 4 } :
      w.kind === 'given' ? { tx: 6, ty: S - 5 } :
      null;
    const free = (x: number, y: number, entityGap: number) =>
      !nearExit(exits, x, y, 3) &&
      entities.every((e) => Math.max(Math.abs(e.tx - x), Math.abs(e.ty - y)) > entityGap) &&
      out.every((s) => Math.max(Math.abs(s.tx - x), Math.abs(s.ty - y)) > 4) &&
      // A reed pool sits two tiles north of its site.
      (w.kind !== 'reeds' || y >= 6);
    let spot: Tile | null = null;
    for (const gap of [3, 2]) {
      const candidates: Tile[] = [];
      for (let y = 4; y <= S - 5; y++) for (let x = 4; x <= S - 5; x++) if (free(x, y, gap)) candidates.push({ tx: x, ty: y });
      if (candidates.length === 0) continue;
      if (prefer) {
        candidates.sort((a, b) => Math.hypot(a.tx - prefer.tx, a.ty - prefer.ty) - Math.hypot(b.tx - prefer.tx, b.ty - prefer.ty));
        spot = candidates[Math.floor(rng() * Math.min(3, candidates.length))];
      } else spot = candidates[Math.floor(rng() * candidates.length)];
      break;
    }
    if (spot) out.push({ id: w.id, kind: w.kind, cx, cy, ...spot });
  }
  return out;
}

/** Every story site of an epoch, region-wide (chunk by chunk). */
export function regionSites(epoch: Epoch, exitsFor: (cx: number, cy: number) => readonly ChunkExit[]): StorySite[] {
  const chunks = new Set(siteChunks(epoch).map((s) => `${s.cx},${s.cy}`));
  const out: StorySite[] = [];
  for (const k of chunks) {
    const [cx, cy] = k.split(',').map(Number);
    out.push(...chunkSites(epoch, cx, cy, exitsFor(cx, cy)));
  }
  return out;
}
