import type { ChunkRect } from '../../lib/wilds/coords.ts';
/**
 * The Wilds store: the client's picture of the open map, keyed by chunk
 * (docs/design/open-map.md 2.4, 2.5), shared by the scene and the panels.
 *
 * The server owns everything (server-first.md 3). `refreshNear` reads
 * GET /api/wilds/near/<cx>/<cy>: the still and wick epochs, the world border,
 * and for the 5×5 chunks around (cx, cy) every entity's cycle and state,
 * personal claims, discoveries, fallen lanterns, Echo assignments, ground
 * changes, named ways and material balances.
 * Each read replaces what the store held for the chunks in its window and
 * keeps the rest, then loads the window's chunk bodies (terrain, decor,
 * sites, entity bodies; game/wilds/chunks.ts) in their epochs. A read is
 * made on entering a chunk (at most every 10 s per chunk) and before every
 * claim (a claim must name the entity's current cycle).
 *
 * Freshness: a view is fresh once a near read and its chunks have loaded.
 * When a later read fails, the last view stays to look at but is marked
 * `stale`; `wildsLive` (what offers and claims read) returns nothing for a
 * stale view or while the link is not online (server-first.md 3.3).
 *
 * Lifetime and order: a read belongs to the store's generation and the link
 * it was asked through. A reset, the turning or a world move ends that
 * generation, and its answer (or failure) is dropped. Overlapping reads and
 * answers are ordered (see `readMark`): a late, older answer never replaces what
 * a newer read or answer set, nor turns the land back.
 *
 * The turning: a read that names another wick epoch than the one held means
 * the Beyond turned. The store starts over from that read and the scene
 * plays it (EV.turning); nobody is sent home (decision 10).
 *
 * There is no local play: without a server the Wilds don't open.
 */
import { prepareFixed } from './fixed.ts';
import { MATERIALS, TRINKETS } from '../../content/expansion-writing.ts';
import type { WildsEntityView, WildsLanternView } from '../../lib/api/types.ts';
import type { ChunkGroundChanges, GroundChange, ChunkLandStatus, WildsEntityState, WildsEpoch as WildsEpochPb, WildsLantern, WildsNearResult, WildsWay } from '../../lib/gen/glimway/v1/wilds_pb.js';
import { tileKey } from '../../lib/tile.ts';
import type { WildsClaimResult } from '../../lib/gen/glimway/v1/operations_pb.js';
import { epochKindAt } from '../../lib/wilds/coords.ts';
import { sourceOf } from '../../lib/location.ts';
import { NEAR_RADIUS } from '../../lib/api/near.ts';
import type { WildsEpochKind } from '../../lib/wilds/types.ts';
import { EV, bus } from '../events.ts';
import { gameNow } from '../clock.ts';
import type { Session } from '../session.ts';
import { CHUNK_TILES, chunkKey, chunkOfPixel, isWildsArea } from './coords.ts';
import { loadChunk, loadedTerrain, pruneChunks, cachedTerrain } from './chunks.ts';
import type { ChunkTerrain, EntityBody } from './terrain.ts';
import { adoptMaterials, heldMaterials, markNow, mirrorMaterials, nextMark } from '../materials-order.ts';

/** An epoch as the server named it in the last near read. */
export interface WildsEpoch {
  /** '' until the Wilds have been read. */
  id: string;
  kind: WildsEpochKind;
  worldSeed: string;
  generatorVersion: number;
  season: string;
  /** Unix seconds the epoch ends (the wick); null for the still epoch. */
  endsAt: number | null;
}

/** A chunk rectangle, inclusive (the world border's, as the server names it). */
export type { ChunkRect } from '../../lib/wilds/coords.ts';

export interface LootDrop {
  materials: { id: string; qty: number }[];
  /** Glim-free trinket id, or null. */
  trinket: string | null;
}

export interface WildsDiscovery {
  entityId: string;
  poiId: string;
  discovererId: string;
  displayName: string;
}

/** An entity's body (from its chunk) with its state (from the near read); `cx, cy` its chunk. */
export type WildsThing = WildsEntityView & { cx: number; cy: number };

/** A chunk seen at a distance: its main land and whether the Wend crosses it (the map's window). */
export interface Glimpse {
  land: string;
  river: boolean;
}

type EntityStateView = Pick<WildsEntityView, 'cycle' | 'state' | 'available_at' | 'by' | 'at' | 'camp_claimable'>;

export interface WildsView {
  /** Explicit status of occupied/explored chunks from near reads. */
  land: Map<string, ChunkLandStatus>;
  still: WildsEpoch;
  wick: WildsEpoch;
  /** The world border as the server named it (0.14). */
  border: ChunkRect;
  /** Entity states by id (bodies are in the chunks). */
  states: Map<string, EntityStateView>;
  /** Entity ids this player personally claimed (chests, POIs). */
  claims: Set<string>;
  discoveries: Map<string, WildsDiscovery>;
  /** Fallen lanterns; `x, y` are world tiles. */
  lanterns: Map<string, WildsLanternView>;
  materials: Record<string, number>;
  /** This player's Echo assignments: site id → member, and whether it is settled. */
  echoes: Map<string, { member: string; settled: boolean }>;
  /** Player-made ground changes per chunk (`cx,cy`), tiles chunk-local (section 3). */
  ground: Map<string, GroundChange[]>;
  /** Named ways by id (their geometry is the server's: `path`, `signA`, `signB`). */
  ways: Map<string, WildsWay>;
  /** Held chunks (`cx,cy`): the older wick epoch each keeps its land in (roadmap 0.12). */
  held: Map<string, WildsEpoch>;
  /** The last refresh failed: this is the Wilds as last seen, shown but not interactive. */
  stale: boolean;
  /** Bumps on every change; the scene re-renders when it moves. */
  version: number;
}

export { NEAR_RADIUS };
/** A chunk's near read is reused for this long when you walk back into it. */
export const NEAR_MAX_AGE_MS = 10_000;

let view: WildsView | null = null;
const fetchedAt = new Map<string, number>();
/** Reads in flight, by owner (generation and link) plus centre: a second caller joins the first. */
const inflight = new Map<string, Promise<boolean>>();
/**
 * The store's lifetime: bumps when the view is forgotten (a world move, the
 * turning) or starts over. A read remembers it as it is asked, and its answer
 * (or failure) is dropped once it has moved: no answer revives land the
 * store let go of.
 */
let generation = 0;

// A fall that left a lantern changed the Wilds: the next entry reads again.
bus.on(EV.fallSettled, ({ lantern }) => {
  if (lantern === 'placed') fetchedAt.clear();
});

/**
 * One server-owned material balance everywhere (materials-order.ts): this
 * store's mirror follows every adoption, the Home side's included. One the
 * store makes itself is published by its own bump.
 */
let adopting = false;
/** The link the view was read through: whose balance its mirror holds (materials-order.ts). */
let viewLink: object | null = null;
mirrorMaterials('wilds', () => viewLink, (m) => {
  if (!view) return;
  view.materials = materialsRecord(m);
  if (!adopting) emitMaterials();
});

/** Balances read or answered at `at`, for both mirrors: false (and nothing set) if every count held is newer. */
function takeMaterials(m: Record<string, number>, at: number): boolean {
  adopting = true;
  try {
    return adoptMaterials(materialsRecord(m), at, viewLink);
  } finally {
    adopting = false;
  }
}

const unread = (kind: WildsEpochKind): WildsEpoch => ({ id: '', kind, worldSeed: '', generatorVersion: 0, season: '', endsAt: null });

/** The view as last read (stale or not), or null before the first read. */
export function wildsView(): WildsView | null {
  return view;
}

/**
 * The view, only while it is fresh and the link is online: what interaction
 * offers, claims, relights and Echo settling read. Null otherwise.
 */
export function wildsLive(session: Session): WildsView | null {
  return view && !view.stale && session.link?.status === 'online' ? view : null;
}

/** Is the Wilds shown as last seen (a stale view, or no connection)? */
export function wildsStale(session: Session): boolean {
  return view !== null && wildsLive(session) === null;
}

/** Wilds materials for the character panel (`null` until the Wilds load), with unanswered lays and lifts on top. */
export function wildsMaterials(): Record<string, number> | null {
  if (!view) return null;
  const out = { ...view.materials };
  for (const [token, p] of pendingMaterials) if (!committedInView(token)) out[p.id] = (out[p.id] ?? 0) + p.delta;
  return out;
}

export function wildsEpoch(kind: WildsEpochKind): WildsEpoch {
  return view ? view[kind] : unread(kind);
}

/** The epoch a chunk is made in (a held chunk's pinned one, the Tangle's still one, else the wick's), or null before a read. */
export function chunkEpoch(cx: number, cy: number): WildsEpoch | null {
  const held = view?.held.get(chunkKey(cx, cy));
  if (held) return held;
  const e = wildsEpoch(epochKindAt(cx, cy));
  return e.id ? e : null;
}

/** Is the chunk held (pinned to a wick epoch across turnings) as last read? */
export function chunkHeld(cx: number, cy: number): boolean {
  return view?.held.has(chunkKey(cx, cy)) ?? false;
}

/** The world border as last read, or null. */
export function wildsBorder(): ChunkRect | null {
  return view?.border ?? null;
}

/** Inside the border the server named (the client treats everything past it as solid). */
export function insideNamedBorder(cx: number, cy: number): boolean {
  const f = view?.border;
  return !!f && cx >= f.minCx && cx <= f.maxCx && cy >= f.minCy && cy <= f.maxCy;
}

/** When the wick ends (Unix seconds), or null before a read. */
export function wickEndsAt(): number | null {
  return view?.wick.endsAt ?? null;
}

/**
 * Has the wick this store holds ended? The server's `endsAt` against the
 * game's clock (the server is what refuses an ended epoch).
 */
export function wickEnded(): boolean {
  const end = view?.wick.endsAt;
  return end !== null && end !== undefined && gameNow() >= end;
}

/**
 * Forget the Wilds (a world move, or the turning): the next read starts
 * over, and no view of the old world's or the old wick's land is reused.
 */
export function resetWilds(opts: { quiet?: boolean } = {}): void {
  view = null;
  viewLink = null;
  generation += 1;
  fetchedAt.clear();
  inflight.clear();
  forgetPredictions();
  forgetOrder();
  readWanted = false;
  if (!opts.quiet) bus.emit(EV.wilds, { materials: null });
}

function materialsRecord(list: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of MATERIALS) out[m.id] = 0;
  for (const [id, qty] of Object.entries(list)) out[id] = (out[id] ?? 0) + Number(qty);
  return out;
}

/** Publish the mirror (with unanswered lays and lifts) to the panel: not an adoption, so the Home side isn't told. */
function emitMaterials(): void {
  const materials = wildsMaterials();
  if (!materials) return;
  bus.emit(EV.wilds, { materials });
}

function bump(): void {
  if (view) view.version += 1;
  emitMaterials();
}

/** Available now? (A depleted camp or node shows its timer until the next read projects its cycle.) */
export function entityAvailable(e: Pick<WildsEntityView, 'state' | 'available_at'>, nowSec: number): boolean {
  if (e.state === 'cleared' || e.state === 'harvested') return e.available_at > 0 && nowSec >= e.available_at;
  if (e.state === 'charted') return false;
  return true;
}

/**
 * The cycle a camp or node is in now. A depleted one whose timer has passed
 * is available in its next cycle, exactly one ahead, as the server's read
 * projects it (server/internal/api/wilds.go, `projected`): a camp come round
 * on its timer is fought under the cycle the claim's fresh read will name.
 */
export function entityCycle(e: Pick<WildsEntityView, 'state' | 'available_at' | 'cycle'>, nowSec: number): number {
  return (e.state === 'cleared' || e.state === 'harvested') && entityAvailable(e, nowSec) ? e.cycle + 1 : e.cycle;
}

/**
 * Whether this reader may claim a camp now, by the server's word for its
 * exact cycle (`camp_claimable`: that cycle fell with them as a witness and
 * they haven't claimed it). A camp come round on its timer is in its next
 * cycle, and the word was for the last one: not claimable.
 */
export function campClaimable(e: Pick<WildsEntityView, 'kind' | 'state' | 'available_at' | 'cycle' | 'camp_claimable'>, nowSec: number): boolean {
  return e.kind === 'camp' && e.camp_claimable && entityCycle(e, nowSec) === e.cycle;
}

function lanternView(l: WildsLantern): WildsLanternView {
  return { id: l.id, ownerId: l.ownerId, displayName: l.displayName, x: l.x, y: l.y, litBy: l.litBy ?? null, at: l.at, litAt: l.litAt ?? null };
}

function epochView(e: WildsEpochPb, kind: WildsEpochKind): WildsEpoch {
  return { id: e.id, kind, worldSeed: e.worldSeed, generatorVersion: e.generatorVersion, season: e.season, endsAt: e.endsAt ?? null };
}

/** The chunk an entity id names (`<kind>:<cx>:<cy>:<i>`), or null. */
export function entityChunk(id: string): { cx: number; cy: number } | null {
  const m = /^[a-z-]+:(-?\d+):(-?\d+):\d+$/.exec(id);
  return m ? { cx: Number(m[1]), cy: Number(m[2]) } : null;
}

/** The window of chunks a read around (cx, cy) covers. */
export function nearWindow(cx: number, cy: number, radius = NEAR_RADIUS): { cx: number; cy: number }[] {
  const out: { cx: number; cy: number }[] = [];
  for (let y = cy - radius; y <= cy + radius; y++) for (let x = cx - radius; x <= cx + radius; x++) out.push({ cx: x, cy: y });
  return out;
}

/**
 * Merge a near read into the view (exported for tests): the read's window
 * replaces what the view held for those chunks; everything else stays.
 * A read in another wick epoch starts the view over. Returns whether the
 * wick turned (a held wick, then another), or null when the answer is older
 * than what the view holds and was dropped: it names an older wick than
 * the one held, or another epoch than a read asked after it adopted.
 *
 * `since` is the read's order mark (readMark, taken as it was asked). What a
 * later read or an answer set after it was asked is newer and kept: a chunk a
 * later read covered, an entity, claim, lantern, Echo, chunk's ground, way,
 * the balances or the border. `link`: the link it was read through (whose
 * material balance it carries; refreshNear passes it).
 */
export function applyNear(res: WildsNearResult, since: number = markNow(), link: object | null = viewLink): boolean | null {
  const still = epochView(res.still!, 'still');
  const wick = epochView(res.wick!, 'wick');
  const turned = !!view && !!view.wick.id && view.wick.id !== wick.id;
  const restart = !view || turned || view.still.id !== still.id;
  // A late answer from before the view started over, or naming a wick that ended before the held one, can't turn it back.
  if (view && restart && (since < startedAt || (view.wick.endsAt !== null && wick.endsAt !== null && wick.endsAt < view.wick.endsAt))) return null;
  if (restart) {
    view = {
      still,
      wick,
      border: { minCx: 0, minCy: 0, maxCx: -1, maxCy: -1 },
      states: new Map(),
      claims: new Set(),
      discoveries: new Map(),
      lanterns: new Map(),
      materials: {},
      echoes: new Map(),
      ground: new Map(),
      ways: new Map(),
      held: new Map(),
      land: new Map(),
      stale: false,
      version: (view?.version ?? 0) + 1,
    };
    if (turned) {
      fetchedAt.clear();
      // Reads asked in the old wick answer for land that is gone.
      generation += 1;
      inflight.clear();
    }
    forgetPredictions();
    forgetOrder();
    startedAt = since;
  }
  const v = view!;
  viewLink = link;
  v.still = still;
  v.wick = wick;
  // Newer than this read: set by a later read or an answer after it was asked.
  const newer = (at: number | undefined) => (at ?? 0) > since;
  const r = res.border!.rect!;
  if (!newer(borderSeq)) {
    v.border = { minCx: r.minCx, minCy: r.minCy, maxCx: r.maxCx, maxCy: r.maxCy };
    borderSeq = since;
  }
  const c = res.center!;
  const radius = res.radius;
  // The window's chunks this read speaks for: none a later read already covered.
  const ours = new Set<string>();
  for (const at of nearWindow(c.cx, c.cy, radius)) {
    const key = chunkKey(at.cx, at.cy);
    if (newer(readSeq.get(key))) continue;
    ours.add(key);
    readSeq.set(key, since);
  }
  // Held chunks: the epoch each of the window's is pinned to, for the chunks this read speaks for.
  for (const key of ours) v.held.delete(key);
  for (const n of res.chunks) {
    const k = n.chunk;
    if (n.source !== 'held' || !k || !ours.has(chunkKey(k.cx, k.cy))) continue;
    const older = res.held.find((e) => e.id === n.epoch);
    const pinned = n.epoch === wick.id ? wick : older ? epochView(older, 'wick') : null;
    if (pinned) v.held.set(chunkKey(k.cx, k.cy), pinned);
  }
  for (const land of res.land?.chunks ?? []) {
    const k = land.chunk;
    const key = k ? chunkKey(k.cx,k.cy) : '';
    if (k && !newer(readSeq.get(key)) && !newer(landSeq.get(key))) {
      v.land.set(key, land);
      landSeq.set(key, since);
    }
  }
  // Adding what the read names: anywhere no later read spoke for (an id naming no chunk: wherever).
  const speaks = (key: string) => ours.has(key) || !newer(readSeq.get(key));
  const idChunk = (id: string) => {
    const at = entityChunk(id);
    return at ? chunkKey(at.cx, at.cy) : null;
  };
  const ownChunk = (id: string) => {
    const key = idChunk(id);
    return key !== null && ours.has(key);
  };
  const named = (id: string) => {
    const key = idChunk(id);
    if (newer(entitySeq.get(id)) || (key !== null && !speaks(key))) return false;
    // No chunk to order it by: the id itself carries this read's mark.
    if (key === null) entitySeq.set(id, since);
    return true;
  };
  const tileChunk = (t: { x: number; y: number }) => chunkKey(Math.floor(t.x / CHUNK_TILES), Math.floor(t.y / CHUNK_TILES));
  for (const id of [...v.states.keys()]) if (ownChunk(id) && !newer(entitySeq.get(id))) v.states.delete(id);
  for (const s of res.entities) if (named(s.id)) v.states.set(s.id, stateView(s));
  for (const id of [...v.claims]) if (ownChunk(id) && !newer(entitySeq.get(id))) v.claims.delete(id);
  for (const p of res.personalClaims) if (named(p.entityId)) v.claims.add(p.entityId);
  for (const d of res.discoveries) {
    const id = placeKey(d.entityId, d.epoch, wick.id);
    v.discoveries.set(id, { entityId: id, poiId: d.poiId, discovererId: d.discovererId, displayName: d.displayName });
  }
  for (const [id, l] of [...v.lanterns]) if (ours.has(tileChunk(l)) && !newer(lanternSeq.get(id))) v.lanterns.delete(id);
  for (const l of res.lanterns) if (speaks(tileChunk(l)) && !newer(lanternSeq.get(l.id))) v.lanterns.set(l.id, lanternView(l));
  for (const a of res.echoes) {
    if (newer(echoSeq.get(a.site))) continue;
    v.echoes.set(a.site, { member: a.member, settled: a.settled });
    echoSeq.set(a.site, since);
  }
  for (const key of [...v.ground.keys()]) if (ours.has(key) && !newer(chunkSeq.get(key))) v.ground.delete(key);
  for (const g of res.ground) {
    if (!g.chunk) continue;
    const key = chunkKey(g.chunk.cx, g.chunk.cy);
    if (speaks(key) && !newer(chunkSeq.get(key))) v.ground.set(key, [...(g.changes?.changes ?? [])]);
  }
  merged.clear();
  // The read names every way whose path crosses its window: one it no longer names is gone (lifted by anyone).
  const returned = new Set(res.ways.map((w) => w.id));
  for (const [id, w] of [...v.ways]) {
    if (returned.has(id) || newer(waySeq.get(id))) continue;
    if (w.path.some((t) => ours.has(tileChunk(t)))) v.ways.delete(id);
  }
  for (const w of res.ways) {
    // A way crossing a chunk a later read spoke for is that read's to name (it may have gone).
    if (newer(waySeq.get(w.id)) || !w.path.every((t) => speaks(tileChunk(t)))) continue;
    v.ways.set(w.id, w);
    waySeq.set(w.id, since);
  }
  // The one balance: this read's counts, except any newer than it.
  takeMaterials(res.materials, since);
  // A new view starts from the balance held (this read's counts, and any newer ones).
  if (restart) v.materials = materialsRecord(heldMaterials(link) ?? res.materials);
  v.stale = false;
  return turned;
}

function stateView(s: WildsEntityState): EntityStateView {
  return { cycle: s.cycle, state: s.state as WildsEntityView['state'], available_at: s.availableAt, by: s.by ?? null, at: s.at ?? null, camp_claimable: s.campClaimable };
}

// ------------------------------------------------------------ order

/**
 * Answers and near reads overwrite the same mirrors, so they are ordered on
 * the clock the Home side shares (materials-order.ts): a read takes the next
 * mark as it is asked, and every applied answer takes the next for what it set (an entity's state and claim, a lantern, an Echo,
 * a chunk's ground, a way, the balances). A read marks what it set with its
 * own mark, and keeps whatever a later read or an answer set after it was
 * asked: two reads answered backwards leave the later one's view.
 */
/** The latest read that spoke for each chunk (`cx,cy`). */
const readSeq = new Map<string, number>();
const entitySeq = new Map<string, number>();
const lanternSeq = new Map<string, number>();
const echoSeq = new Map<string, number>();
const chunkSeq = new Map<string, number>();
const waySeq = new Map<string, number>();
/** The latest read that spoke for each chunk's land status (a near read, or refreshLand). */
const landSeq = new Map<string, number>();
let borderSeq = 0;
/** The mark of the read the view started over from: an older one can't start it over again. */
let startedAt = 0;
/** The latest read that succeeded: an older read's failure doesn't make it stale. */
let goodSeq = 0;

function forgetOrder(): void {
  readSeq.clear();
  landSeq.clear();
  entitySeq.clear();
  lanternSeq.clear();
  echoSeq.clear();
  chunkSeq.clear();
  waySeq.clear();
  borderSeq = 0;
  goodSeq = 0;
}

/** The order mark of what the store holds now: a read asked now takes the next (refreshNear; tests). */
export function readMark(): number {
  return nextMark();
}

/** A read is wanted: something the store held turned out wrong (a refusal, an answer for land that has turned). */
let readWanted = false;

/**
 * The land status of the chunk the hero just stepped into (the HUD's land
 * chip). A near read speaks only for the chunk the server last saw you in,
 * which can lag a step behind, so this asks the map's status read for this
 * one chunk: standing in it is exploring it. Kept unless a later read spoke
 * for the chunk meanwhile; a failure keeps what was known. False when no
 * answer came (offline, or the read failed): the chip asks again later.
 */
export async function refreshLand(session: Session, cx: number, cy: number): Promise<boolean> {
  const link = session.link;
  if (!link?.online || !view) return false;
  const gen = generation;
  const since = readMark();
  const key = chunkKey(cx, cy);
  try {
    const res = await link.api.operations.mapStatus([{ cx, cy }]);
    const land = res.chunks[0];
    // Answered: dropped only because the land it spoke for is gone, or a later read spoke first.
    if (generation !== gen || session.link !== link || !view || res.wick !== view.wick.id || !land) return true;
    if ((landSeq.get(key) ?? 0) > since) return true;
    landSeq.set(key, since);
    view.land.set(key, land);
    bump();
    return true;
  } catch {
    // The chip keeps what it knew.
    return false;
  }
}

/**
 * Bumps when one of your operations changed the land's holds or visits (a
 * lamp set, filled, lit, tended, lifted or taken down; a path laid or
 * lifted). Every status the chip holds may be out of date then: it asks for
 * the chunk underfoot again (./land-here.ts), and for others as you step in.
 */
let landRev = 0;

/** The land-change count (./land-here.ts compares it). */
export function landRevision(): number {
  return landRev;
}

/** One of your operations changed the land: the chip's statuses are out of date. */
export function invalidateLand(): void {
  landRev += 1;
}

/** Ask for a fresh near read: the scene takes the request (takeReadRequest), and no earlier read counts as recent. */
export function requestRead(): void {
  readWanted = true;
  fetchedAt.clear();
  if (view) view.version += 1;
}

/** Is a fresh read wanted (without taking the request)? */
export function readRequested(): boolean {
  return readWanted;
}

/** The scene's turn: true once per request. */
export function takeReadRequest(): boolean {
  const was = readWanted;
  readWanted = false;
  return was;
}

/** The entities of a loaded chunk, each with its state. */
export function chunkThings(cx: number, cy: number): WildsThing[] {
  const epoch = chunkEpoch(cx, cy);
  const t = epoch ? cachedTerrain(epoch.id, cx, cy) : null;
  if (!t) return [];
  return t.entities.map((b) => thingOf(b, cx, cy));
}

function thingOf(body: EntityBody, cx: number, cy: number): WildsThing {
  const s = view?.states.get(body.id);
  return {
    ...body,
    enemies: [...body.enemies],
    cx,
    cy,
    cycle: s?.cycle ?? 0,
    state: s?.state ?? 'available',
    available_at: s?.available_at ?? 0,
    by: s?.by ?? null,
    at: s?.at ?? null,
    camp_claimable: s?.camp_claimable ?? false,
  };
}

/** A loaded chunk's terrain in its current epoch, or null. */
export function chunkTerrain(cx: number, cy: number): ChunkTerrain | null {
  const epoch = chunkEpoch(cx, cy);
  return epoch ? cachedTerrain(epoch.id, cx, cy) : null;
}

/** Load a chunk's body in its current epoch (null past the border, on fixed ground, or before a read). */
export async function loadWildsChunk(session: Session, cx: number, cy: number): Promise<ChunkTerrain | null> {
  const link = session.link;
  const epoch = chunkEpoch(cx, cy);
  // Fixed ground has no generated chunk to fetch: its own come under its pseudo-epoch (./fixed.ts).
  if (!link || !epoch || !insideNamedBorder(cx, cy) || sourceOf(cx, cy).kind === 'fixed') return null;
  return loadChunk(link.api.operations, epoch.id, cx, cy);
}

/**
 * Read the Wilds around chunk (cx, cy) and load the window's chunks. A
 * chunk read less than `maxAgeMs` ago is reused. Never moves the hero.
 * Returns whether the view is usable.
 */
export async function refreshNear(session: Session, cx: number, cy: number, maxAgeMs = 0): Promise<boolean> {
  const link = session.link;
  if (!link) return false;
  const key = chunkKey(cx, cy);
  // The read's owner: this store's lifetime and the link (the world) it reads through.
  const gen = generation;
  const owner = `${gen}|${linkId(link)}|${key}`;
  const joined = inflight.get(owner);
  if (joined) return joined;
  // Still this read's world: no reset, turning or world move since it was asked.
  const current = () => generation === gen && session.link === link;
  const run = async (): Promise<boolean> => {
    const at = fetchedAt.get(key);
    if (view && !view.stale && at !== undefined && Date.now() - at < maxAgeMs) return true;
    const since = readMark();
    try {
      const res = await link.api.operations.near(cx, cy);
      if (!current()) return false;
      const priorWick = view?.wick.id ?? '';
      const turned = applyNear(res, since, link);
      // Older than what the view holds: nothing to adopt, and the view is no fresher for it.
      if (turned === null) return wildsLive(session) !== null;
      const after = generation;
      fetchedAt.set(key, Date.now());
      goodSeq = Math.max(goodSeq, since);
      await Promise.all(nearWindow(cx, cy).filter((c) => insideNamedBorder(c.cx, c.cy)).map((c) => loadWildsChunk(session, c.cx, c.cy).catch(() => null)));
      // Forgotten while its chunks loaded: the land it read is gone.
      if (generation !== after || session.link !== link || !view) return false;
      if (priorWick !== view.wick.id) void pruneChunks([view.still.id, view.wick.id, ...new Set([...view.held.values()].map((e) => e.id))]);
      bump();
      if (turned) bus.emit(EV.turning, { reason: 'epoch-ended' });
      return true;
    } catch {
      // An old read's failure says nothing about the view held now.
      if (!current()) return false;
      // The last view stays to look at, marked stale; nothing in it is offered (a later read that worked says otherwise).
      if (view && !view.stale && goodSeq < since) {
        view.stale = true;
        bump();
      }
      return false;
    }
  };
  const p = run().finally(() => {
    if (inflight.get(owner) === p) inflight.delete(owner);
  });
  inflight.set(owner, p);
  return p;
}

/** A stable id per link object (a world move brings another link). */
const linkIds = new WeakMap<object, number>();
let links = 0;
function linkId(link: object): number {
  let id = linkIds.get(link);
  if (id === undefined) linkIds.set(link, (id = ++links));
  return id;
}

/**
 * Everything a session needs before it can play in the Wilds: a near read
 * around the saved position and its chunks. Await this before building the
 * Wilds scene. True only for a fresh view. `maxAgeMs` lets a re-entry use a
 * recent read.
 */
export async function prepareWilds(session: Session, maxAgeMs = 0): Promise<boolean> {
  if (!session.link) return false;
  if (!isWildsArea(session.state.area)) return wildsLive(session) !== null;
  const { cx, cy } = chunkOfPixel(session.state.position.x, session.state.position.y);
  // The fixed footprints' chunks too (the Commons): the first window attaches them behind the fade.
  const [read] = await Promise.all([refreshNear(session, cx, cy, maxAgeMs), prepareFixed(session)]);
  return read;
}

/**
 * A server claim answer: entity state, loot, balances. The state is kept
 * (and ordered ahead of any read asked before it) only while the entity's
 * chunk is still in the epoch the claim was made in; otherwise the land
 * turned meanwhile, and the Wilds are read again. The balances are the
 * account's, epoch or not.
 */
export function applyClaim(result: WildsClaimResult): LootDrop {
  if (!view) throw new Error('wilds: claim before the Wilds loaded');
  const at = nextMark();
  const s = result.entity;
  if (s) {
    const chunk = entityChunk(s.id);
    const current = chunk ? chunkEpoch(chunk.cx, chunk.cy)?.id : view.wick.id;
    if (current && (s.epoch || result.epoch) === current) {
      view.states.set(s.id, stateView(s));
      if (/^(chest|poi|rumour):/.test(s.id)) view.claims.add(s.id);
      entitySeq.set(s.id, at);
    } else requestRead();
  }
  // The answer carries the post-grant balances: both mirrors follow.
  takeMaterials(result.materials, at);
  bump();
  return { materials: (result.loot?.materials ?? []).map((m) => ({ id: m.id, qty: m.qty })), trinket: result.loot?.trinket ?? null };
}

/** A relight's answer: the lanterns it names, in its epoch (each lantern's chunk's); false (and a read wanted) for land that turned. */
export function applyLanterns(lanterns: WildsLantern[], epoch: string): boolean {
  if (!view) return false;
  const at = nextMark();
  let kept = true;
  for (const l of lanterns) {
    if (chunkEpoch(Math.floor(l.x / CHUNK_TILES), Math.floor(l.y / CHUNK_TILES))?.id !== epoch) {
      kept = false;
      continue;
    }
    view.lanterns.set(l.id, lanternView(l));
    lanternSeq.set(l.id, at);
  }
  if (!kept) requestRead();
  bump();
  return kept;
}

/** Record a settled Echo in the view (the answer to settle-echo), in an epoch the view holds. */
export function applyEchoSettled(site: string, epoch: string): boolean {
  const a = view?.echoes.get(site);
  if (!view || !a) return false;
  if (epoch !== view.wick.id && epoch !== view.still.id) {
    requestRead();
    return false;
  }
  a.settled = true;
  echoSeq.set(site, nextMark());
  bump();
  return true;
}

/**
 * A chunk's ground changes (tiles chunk-local): as last read or answered,
 * with this player's unanswered clears, lays and lifts on top. The same
 * array comes back until something changes (the ground view caches by it).
 */
export function groundChanges(cx: number, cy: number): readonly GroundChange[] {
  const key = chunkKey(cx, cy);
  const server = view?.ground.get(key) ?? NONE;
  const mine = predicted.get(key);
  if (!mine?.size) return server;
  const had = merged.get(key);
  if (had) return had;
  const at = new Map(server.map((c) => [tileKey(c.tx, c.ty), c]));
  for (const [tile, p] of mine) {
    if (p.change) at.set(tile, p.change);
    else at.delete(tile);
  }
  const out = [...at.values()];
  merged.set(key, out);
  return out;
}

// ------------------------------------------------------------ predicted paths

const NONE: readonly GroundChange[] = [];
/** Unanswered path operations by chunk, then tile: the change they make (null: the tile's change goes). */
const predicted = new Map<string, Map<string, { token: number; change: GroundChange | null }>>();
/** Where each prediction stands (chunk key and tile), by token. */
const predictedAt = new Map<number, { chunk: string; tile: string; change: GroundChange | null; by: string }>();

/**
 * Does the server's ground the view holds already show this prediction
 * (the operation committed, and a read taken since says so)? Then its
 * material is in the balances that came with it, and isn't counted again.
 */
function committedInView(token: number): boolean {
  const at = predictedAt.get(token);
  if (!at || !view) return false;
  const now = (view.ground.get(at.chunk) ?? NONE).find((c) => tileKey(c.tx, c.ty) === at.tile) ?? null;
  if (at.change) return !!now && now.change === at.change.change && now.by === at.change.by;
  // A lift: the tile no longer carries the path its lifter laid.
  return !!at.by && (!now || now.change === 'cleared' || now.by !== at.by);
}
/** Material debits and refunds of unanswered lays and lifts, by token. */
const pendingMaterials = new Map<number, { id: string; delta: number }>();
const merged = new Map<string, GroundChange[]>();
let tokens = 0;

function forgetPredictions(): void {
  predicted.clear();
  predictedAt.clear();
  pendingMaterials.clear();
  merged.clear();
}

/**
 * Show a path operation before its answer (server-first.md 3): the tile's
 * change (`null`: lifted away) and, for a lay or a lift, the material it
 * takes or gives back. Returns the token its answer settles.
 */
export function predictGround(cx: number, cy: number, tx: number, ty: number, change: GroundChange | null, material?: { id: string; delta: number }, by = ''): number {
  const token = ++tokens;
  const key = chunkKey(cx, cy);
  let mine = predicted.get(key);
  if (!mine) predicted.set(key, (mine = new Map()));
  mine.set(tileKey(tx, ty), { token, change });
  predictedAt.set(token, { chunk: key, tile: tileKey(tx, ty), change, by: change?.by ?? by });
  if (material) pendingMaterials.set(token, material);
  merged.delete(key);
  bump();
  return token;
}

/** A prediction's answer came (or it was refused): it stops showing. */
export function settlePrediction(token: number): void {
  pendingMaterials.delete(token);
  predictedAt.delete(token);
  for (const [key, mine] of predicted) {
    for (const [tile, p] of mine) if (p.token === token) mine.delete(tile);
    if (!mine.size) predicted.delete(key);
    merged.delete(key);
  }
  bump();
}

/**
 * A path operation's answer: the chunk's changes now, the balances, and the
 * ways it made, broke or moved. Ground tagged with another epoch than the
 * chunk's current one (the land turned meanwhile) and ways of another wick
 * are not applied; false then, and the caller reads the world again.
 */
export function applyPathAnswer(ground: ChunkGroundChanges | undefined, materials: Record<string, number>, ways: { made?: readonly WildsWay[]; broken?: readonly string[]; rerouted?: readonly WildsWay[] } = {}): boolean {
  if (!view) return false;
  if (ground?.chunk) {
    const current = chunkEpoch(ground.chunk.cx, ground.chunk.cy);
    if (!current || ground.epoch !== current.id) return false;
  }
  const wick = view.wick.id;
  if ([...(ways.made ?? []), ...(ways.rerouted ?? [])].some((w) => w.epoch !== wick)) return false;
  const at = nextMark();
  if (ground?.chunk) {
    const key = chunkKey(ground.chunk.cx, ground.chunk.cy);
    view.ground.set(key, [...(ground.changes?.changes ?? [])]);
    chunkSeq.set(key, at);
    merged.delete(key);
  }
  takeMaterials(materials, at);
  for (const w of [...(ways.made ?? []), ...(ways.rerouted ?? [])]) {
    view.ways.set(w.id, w);
    waySeq.set(w.id, at);
  }
  for (const id of ways.broken ?? []) {
    view.ways.delete(id);
    waySeq.set(id, at);
  }
  bump();
  return true;
}

/**
 * A place's key in the view: its id for this wick's places, `<id>@<epoch>`
 * for a held chunk's (place ids name a cell, so they repeat across wicks:
 * a held chunk's landmark and this wick's of the same cell are two places).
 * Other ids (a POI's) name their chunk and never repeat.
 */
export function placeKey(id: string, epoch: string, wick: string = view?.wick.id ?? ''): string {
  return !epoch || epoch === wick || !id.startsWith('place:') ? id : `${id}@${epoch}`;
}

/**
 * A discovery answered by the server (yours or the first finder's): the map
 * and the banner name them. Only for the wick held now, or a held chunk's
 * epoch the view holds; false otherwise.
 */
export function applyDiscovery(d: { entityId: string; poiId: string; discovererId: string; displayName: string }, epoch: string): boolean {
  if (!view || (epoch !== view.wick.id && ![...view.held.values()].some((e) => e.id === epoch))) return false;
  const id = placeKey(d.entityId, epoch);
  view.discoveries.set(id, { entityId: id, poiId: d.poiId, discovererId: d.discovererId, displayName: d.displayName });
  bump();
  return true;
}

/** A personal claim seen in a near read (chest/POI ids). */
export function isClaimed(entityId: string): boolean {
  return view?.claims.has(entityId) ?? false;
}

export function discoveryFor(entityId: string): WildsDiscovery | null {
  return view?.discoveries.get(entityId) ?? null;
}

/** Display name of a material or trinket (for toasts). */
export function lootName(id: string): string {
  return MATERIALS.find((m) => m.id === id)?.name ?? TRINKETS.find((t) => t.id === id)?.name ?? id;
}

/** Loot as toast text: "+2 Timber, +1 Amber — the Wilds gave back a Whittled Fox." */
export function lootText(drop: LootDrop): string {
  const parts = drop.materials.map((m) => `+${m.qty} ${lootName(m.id)}`);
  if (drop.trinket) parts.push(`the Wilds gave back: ${lootName(drop.trinket)}`);
  return parts.join(', ');
}

/** A cell place whose landmark is in a loaded chunk, in world tiles (the map, signs and finds name it). */
export interface PlaceAt {
  id: string;
  kind: string;
  tx: number;
  ty: number;
}

/** Every cell place in the loaded chunks, each in its current epoch: this wick's, and held chunks' keyed by their epoch (placeKey). */
export function knownPlaces(): PlaceAt[] {
  if (!view) return [];
  const out: PlaceAt[] = [];
  // Row by row, as the chunks lie (callers pick the first of equals).
  const loaded = [...loadedTerrain()].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  for (const t of loaded) {
    if (chunkEpoch(t.cx, t.cy)?.id !== t.epochId) continue;
    for (const p of t.places) out.push({ id: placeKey(p.id, t.epochId), kind: p.kind, tx: t.cx * t.size + p.tx, ty: t.cy * t.size + p.ty });
  }
  return out;
}

/** Balances an answer carried (a first find's loot): the mirror follows. */
export function applyBalances(materials: Record<string, number>): void {
  if (!view) return;
  takeMaterials(materials, nextMark());
  bump();
}
