/**
 * The Wilds store: the client's picture of the open map, keyed by chunk
 * (docs/design/open-map.md 2.4, 2.5), shared by the scene and the panels.
 *
 * The server owns everything (server-first.md 3). `refreshNear` reads
 * GET /api/wilds/near/<cx>/<cy>: the still and wick epochs, the frontier,
 * and for the 5×5 chunks around (cx, cy) every entity's cycle and state,
 * personal claims, discoveries, fallen lanterns, Echo assignments, ground
 * changes, the glimpse past the frontier, named ways and material balances.
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
 * The turning: a read that names another wick epoch than the one held means
 * the Beyond turned. The store starts over from that read and the scene
 * plays it (EV.turning); nobody is sent home (decision 10).
 *
 * There is no local play: without a server the Wilds don't open.
 */
import { MATERIALS, TRINKETS } from '../../content/expansion-writing.ts';
import type { WildsEntityView, WildsLanternView } from '../../lib/api/types.ts';
import type { ChunkGroundChanges, GroundChange, WildsEpoch as WildsEpochPb, WildsLantern, WildsNearResult, WildsWay } from '../../lib/gen/glimway/v1/wilds_pb.js';
import { tileKey } from '../../lib/tile.ts';
import type { WildsClaimResult } from '../../lib/gen/glimway/v1/operations_pb.js';
import { epochKindAt } from '../../lib/wilds/coords.ts';
import { NEAR_RADIUS } from '../../lib/api/near.ts';
import type { WildsEpochKind } from '../../lib/wilds/types.ts';
import { EV, bus } from '../events.ts';
import { gameNow } from '../clock.ts';
import type { Session } from '../session.ts';
import { CHUNK_TILES, chunkKey, chunkOfPixel, isWildsArea } from './coords.ts';
import { loadChunk, pruneChunks, cachedTerrain } from './chunks.ts';
import type { ChunkTerrain, EntityBody } from './terrain.ts';
import { currentHomesteadMaterials, syncWildsMaterials } from '../homestead.ts';

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

/** The frontier the server enforces, as an inclusive chunk rectangle (0.8; 0.9 adds held chunks). */
export interface FrontierRect {
  minCx: number;
  minCy: number;
  maxCx: number;
  maxCy: number;
}

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

/** A chunk past the frontier, seen through the veil (decision 22). */
export interface Glimpse {
  land: string;
  river: boolean;
}

type EntityStateView = Pick<WildsEntityView, 'cycle' | 'state' | 'available_at' | 'by' | 'at'>;

export interface WildsView {
  still: WildsEpoch;
  wick: WildsEpoch;
  frontier: FrontierRect;
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
  /** The glimpse past the frontier, per chunk (`cx,cy`). */
  glimpse: Map<string, Glimpse>;
  /** Named ways by id (their geometry is the server's: `path`, `signA`, `signB`). */
  ways: Map<string, WildsWay>;
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
let inflight: { key: string; run: Promise<boolean> } | null = null;

// A fall that left a lantern changed the Wilds: the next entry reads again.
bus.on(EV.fallSettled, ({ lantern }) => {
  if (lantern === 'placed') fetchedAt.clear();
});

/**
 * One server-owned material balance everywhere: when the shop (homestead
 * actions) moves it, this store's mirror follows.
 */
let homesteadWatch = false;
function watchHomesteadMaterials(): void {
  if (homesteadWatch) return;
  homesteadWatch = true;
  bus.on(EV.homeChanged, () => {
    const m = currentHomesteadMaterials();
    if (m && view) {
      view.materials = { ...m };
      emitMaterials();
    }
  });
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
  for (const p of pendingMaterials.values()) out[p.id] = (out[p.id] ?? 0) + p.delta;
  return out;
}

export function wildsEpoch(kind: WildsEpochKind): WildsEpoch {
  return view ? view[kind] : unread(kind);
}

/** The epoch a chunk is made in (the Tangle's still one, else the wick's), or null before a read. */
export function chunkEpoch(cx: number, cy: number): WildsEpoch | null {
  const e = wildsEpoch(epochKindAt(cx, cy));
  return e.id ? e : null;
}

/** The frontier as last read, or null. */
export function wildsFrontier(): FrontierRect | null {
  return view?.frontier ?? null;
}

/** Inside the frontier the server named (the client treats everything else as solid). */
export function insideNamedFrontier(cx: number, cy: number): boolean {
  const f = view?.frontier;
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
  fetchedAt.clear();
  inflight = null;
  forgetPredictions();
  if (!opts.quiet) bus.emit(EV.wilds, { materials: null });
}

function materialsRecord(list: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of MATERIALS) out[m.id] = 0;
  for (const [id, qty] of Object.entries(list)) out[id] = (out[id] ?? 0) + Number(qty);
  return out;
}

function emitMaterials(): void {
  const materials = wildsMaterials();
  if (!materials) return;
  bus.emit(EV.wilds, { materials });
  // One server-owned balance everywhere: the shop's mirror follows.
  syncWildsMaterials(materials);
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
 * wick turned (a held wick, then another).
 */
export function applyNear(res: WildsNearResult): boolean {
  const still = epochView(res.still!, 'still');
  const wick = epochView(res.wick!, 'wick');
  const turned = !!view && !!view.wick.id && view.wick.id !== wick.id;
  if (!view || turned || view.still.id !== still.id) {
    view = {
      still,
      wick,
      frontier: { minCx: 0, minCy: 0, maxCx: -1, maxCy: -1 },
      states: new Map(),
      claims: new Set(),
      discoveries: new Map(),
      lanterns: new Map(),
      materials: {},
      echoes: new Map(),
      ground: new Map(),
      glimpse: new Map(),
      ways: new Map(),
      stale: false,
      version: (view?.version ?? 0) + 1,
    };
    if (turned) fetchedAt.clear();
    forgetPredictions();
  }
  const v = view;
  v.still = still;
  v.wick = wick;
  const r = res.frontier!.rect!;
  v.frontier = { minCx: r.minCx, minCy: r.minCy, maxCx: r.maxCx, maxCy: r.maxCy };
  const c = res.center!;
  const radius = res.radius;
  const inWindow = (x: number, y: number) => Math.abs(x - c.cx) <= radius && Math.abs(y - c.cy) <= radius;
  const ownChunk = (id: string) => {
    const at = entityChunk(id);
    return !!at && inWindow(at.cx, at.cy);
  };
  for (const id of [...v.states.keys()]) if (ownChunk(id)) v.states.delete(id);
  for (const s of res.entities) v.states.set(s.id, { cycle: s.cycle, state: s.state as WildsEntityView['state'], available_at: s.availableAt, by: s.by ?? null, at: s.at ?? null });
  for (const id of [...v.claims]) if (ownChunk(id)) v.claims.delete(id);
  for (const p of res.personalClaims) v.claims.add(p.entityId);
  for (const d of res.discoveries) v.discoveries.set(d.entityId, { entityId: d.entityId, poiId: d.poiId, discovererId: d.discovererId, displayName: d.displayName });
  for (const [id, l] of [...v.lanterns]) if (inWindow(Math.floor(l.x / CHUNK_TILES), Math.floor(l.y / CHUNK_TILES))) v.lanterns.delete(id);
  for (const l of res.lanterns) v.lanterns.set(l.id, lanternView(l));
  for (const a of res.echoes) v.echoes.set(a.site, { member: a.member, settled: a.settled });
  for (const key of [...v.ground.keys()]) {
    const [x, y] = key.split(',').map(Number);
    if (inWindow(x!, y!)) v.ground.delete(key);
  }
  for (const g of res.ground) if (g.chunk) v.ground.set(chunkKey(g.chunk.cx, g.chunk.cy), [...(g.changes?.changes ?? [])]);
  merged.clear();
  for (const g of res.glimpse) if (g.chunk) v.glimpse.set(chunkKey(g.chunk.cx, g.chunk.cy), { land: g.land, river: g.river });
  for (const w of res.ways) v.ways.set(w.id, w);
  v.materials = materialsRecord(res.materials);
  v.stale = false;
  return turned;
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
  };
}

/** A loaded chunk's terrain in its current epoch, or null. */
export function chunkTerrain(cx: number, cy: number): ChunkTerrain | null {
  const epoch = chunkEpoch(cx, cy);
  return epoch ? cachedTerrain(epoch.id, cx, cy) : null;
}

/** Load a chunk's body in its current epoch (null outside the frontier or before a read). */
export async function loadWildsChunk(session: Session, cx: number, cy: number): Promise<ChunkTerrain | null> {
  const link = session.link;
  const epoch = chunkEpoch(cx, cy);
  if (!link || !epoch || !insideNamedFrontier(cx, cy)) return null;
  return loadChunk(link.api.operations, epoch.id, cx, cy);
}

/**
 * Read the Wilds around chunk (cx, cy) and load the window's chunks. A
 * chunk read less than `maxAgeMs` ago is reused. Never moves the hero.
 * Returns whether the view is usable.
 */
export async function refreshNear(session: Session, cx: number, cy: number, maxAgeMs = 0): Promise<boolean> {
  const key = chunkKey(cx, cy);
  if (inflight?.key === key) return inflight.run;
  const run = async (): Promise<boolean> => {
    const link = session.link;
    if (!link) return false;
    const at = fetchedAt.get(key);
    if (view && !view.stale && at !== undefined && Date.now() - at < maxAgeMs) return true;
    try {
      const ops = link.api.operations;
      const res = await ops.near(cx, cy);
      const priorWick = view?.wick.id ?? '';
      const turned = applyNear(res);
      fetchedAt.set(key, Date.now());
      await Promise.all(nearWindow(cx, cy).filter((c) => insideNamedFrontier(c.cx, c.cy)).map((c) => loadWildsChunk(session, c.cx, c.cy).catch(() => null)));
      if (priorWick !== view!.wick.id) void pruneChunks([view!.still.id, view!.wick.id]);
      bump();
      if (turned) bus.emit(EV.turning, { reason: 'epoch-ended' });
      return true;
    } catch {
      // The last view stays to look at, marked stale; nothing in it is offered.
      if (view && !view.stale) {
        view.stale = true;
        bump();
      }
      return false;
    }
  };
  const p = run().finally(() => {
    if (inflight?.run === p) inflight = null;
  });
  inflight = { key, run: p };
  return p;
}

/**
 * Everything a session needs before it can play in the Wilds: a near read
 * around the saved position and its chunks. Await this before building the
 * Wilds scene. True only for a fresh view. `maxAgeMs` lets a re-entry use a
 * recent read.
 */
export async function prepareWilds(session: Session, maxAgeMs = 0): Promise<boolean> {
  if (!session.link) return false;
  watchHomesteadMaterials();
  if (!isWildsArea(session.state.area)) return wildsLive(session) !== null;
  const { cx, cy } = chunkOfPixel(session.state.position.x, session.state.position.y);
  return refreshNear(session, cx, cy, maxAgeMs);
}

/** A server claim answer: entity state, loot, balances. */
export function applyClaim(result: WildsClaimResult): LootDrop {
  if (!view) throw new Error('wilds: claim before the Wilds loaded');
  const s = result.entity;
  if (s) {
    view.states.set(s.id, { cycle: s.cycle, state: s.state as WildsEntityView['state'], available_at: s.availableAt, by: s.by ?? null, at: s.at ?? null });
    if (/^(chest|poi|rumour):/.test(s.id)) view.claims.add(s.id);
  }
  // The answer carries the post-grant balances: replace the mirror.
  view.materials = materialsRecord(result.materials);
  bump();
  return { materials: (result.loot?.materials ?? []).map((m) => ({ id: m.id, qty: m.qty })), trinket: result.loot?.trinket ?? null };
}

export function applyLanterns(lanterns: WildsLantern[]): void {
  if (!view) return;
  for (const l of lanterns) view.lanterns.set(l.id, lanternView(l));
  bump();
}

/** Record a settled Echo in the view (the answer to settle-echo). */
export function applyEchoSettled(site: string): void {
  const a = view?.echoes.get(site);
  if (!view || !a) return;
  a.settled = true;
  bump();
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
/** Material debits and refunds of unanswered lays and lifts, by token. */
const pendingMaterials = new Map<number, { id: string; delta: number }>();
const merged = new Map<string, GroundChange[]>();
let tokens = 0;

function forgetPredictions(): void {
  predicted.clear();
  pendingMaterials.clear();
  merged.clear();
}

/**
 * Show a path operation before its answer (server-first.md 3): the tile's
 * change (`null`: lifted away) and, for a lay or a lift, the material it
 * takes or gives back. Returns the token its answer settles.
 */
export function predictGround(cx: number, cy: number, tx: number, ty: number, change: GroundChange | null, material?: { id: string; delta: number }): number {
  const token = ++tokens;
  const key = chunkKey(cx, cy);
  let mine = predicted.get(key);
  if (!mine) predicted.set(key, (mine = new Map()));
  mine.set(tileKey(tx, ty), { token, change });
  if (material) pendingMaterials.set(token, material);
  merged.delete(key);
  bump();
  return token;
}

/** A prediction's answer came (or it was refused): it stops showing. */
export function settlePrediction(token: number): void {
  pendingMaterials.delete(token);
  for (const [key, mine] of predicted) {
    for (const [tile, p] of mine) if (p.token === token) mine.delete(tile);
    if (!mine.size) predicted.delete(key);
    merged.delete(key);
  }
  bump();
}

/** A path operation's answer: the chunk's changes now, the balances, and the ways it made, broke or moved. */
export function applyPathAnswer(ground: ChunkGroundChanges | undefined, materials: Record<string, number>, ways: { made?: readonly WildsWay[]; broken?: readonly string[]; rerouted?: readonly WildsWay[] } = {}): void {
  if (!view) return;
  if (ground?.chunk) {
    const key = chunkKey(ground.chunk.cx, ground.chunk.cy);
    view.ground.set(key, [...(ground.changes?.changes ?? [])]);
    merged.delete(key);
  }
  view.materials = materialsRecord(materials);
  for (const w of [...(ways.made ?? []), ...(ways.rerouted ?? [])]) view.ways.set(w.id, w);
  for (const id of ways.broken ?? []) view.ways.delete(id);
  bump();
}

/** A discovery answered by the server (yours or the first finder's): the map and the banner name them. */
export function applyDiscovery(d: { entityId: string; poiId: string; discovererId: string; displayName: string }): void {
  if (!view) return;
  view.discoveries.set(d.entityId, { entityId: d.entityId, poiId: d.poiId, discovererId: d.discovererId, displayName: d.displayName });
  bump();
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

/** Every cell place in the frontier's loaded chunks (this wick's land). */
export function knownPlaces(): PlaceAt[] {
  const f = view?.frontier;
  if (!f) return [];
  const out: PlaceAt[] = [];
  for (let cy = f.minCy; cy <= f.maxCy; cy++)
    for (let cx = f.minCx; cx <= f.maxCx; cx++) {
      const t = chunkTerrain(cx, cy);
      if (!t) continue;
      for (const p of t.places) out.push({ id: p.id, kind: p.kind, tx: cx * t.size + p.tx, ty: cy * t.size + p.ty });
    }
  return out;
}

/** Balances an answer carried (a first find's loot): the mirror follows. */
export function applyBalances(materials: Record<string, number>): void {
  if (!view) return;
  view.materials = materialsRecord(materials);
  bump();
}
