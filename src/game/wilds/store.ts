/**
 * The Wilds region store: the client's picture of the Tangle and the outer
 * Wilds, shared by the chunk scenes and the character panel.
 *
 * Two regions, one active: the region the current scene plays in. Reads and
 * claims go to the active region unless a region is named.
 *
 * The server owns everything (server-first.md 3). `refreshWilds` reads
 * GET /api/wilds/region/<id> (the epoch, every entity's cycle and state,
 * personal claims, discoveries, lanterns, material balances and this
 * player's Echo assignments), then loads that epoch's chunks (terrain, decor,
 * sites and the entities' bodies; game/wilds/chunks.ts). The view merges each
 * entity's body with its state. A depleted camp or node whose timer has run
 * shows its next cycle in the read; a claim must name that cycle, so a claim
 * is always preceded by a fresh read. The outer epoch carries its `endsAt`;
 * past it the region has turned.
 *
 * Freshness: a view is fresh once a region read and all its chunks have
 * loaded. When a later refresh fails, the last view stays to look at but is
 * marked `stale`; `wildsLive` (what offers and claims read) returns nothing
 * for a stale view or while the link is not online, so nothing can be claimed,
 * settled or relit until a fresh read lands (server-first.md 3.3).
 *
 * There is no local play: without a server the Wilds don't open.
 */
import { MATERIALS, TRINKETS } from '../../content/expansion-writing.ts';
import type { WildsEntityView, WildsLanternView } from '../../lib/api/types.ts';
import type { WildsLantern } from '../../lib/gen/glimway/v1/wilds_pb.js';
import type { WildsClaimResult } from '../../lib/gen/glimway/v1/operations_pb.js';
import { EV, bus } from '../events.ts';
import { gameNow } from '../clock.ts';
import type { Session } from '../session.ts';
import { OUTER_REGION_ID, WILDS_REGION_ID, isWildsArea, regionOfState, wildsRegion } from './regions.ts';
import { registerWildsAreas } from './areas.ts';
import { loadRegionChunks, pruneChunks } from './chunks.ts';
import type { EntityBody } from './terrain.ts';
import { currentHomesteadMaterials, syncWildsMaterials } from '../homestead.ts';

/** A region's epoch as the server named it in the last read. */
export interface WildsEpoch {
  /** '' until the region has been read. */
  id: string;
  worldSeed: string;
  regionId: string;
  generatorVersion: number;
  season: string;
  /** Unix seconds the epoch ends (the outer Wilds); null when permanent. */
  endsAt: number | null;
}

export interface LootDrop {
  materials: { id: string; qty: number }[];
  /** Glim-free trinket id, or null. */
  trinket: string | null;
}

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
    if (m && anyView()) {
      setMaterials(m);
      emitMaterials();
    }
  });
}

/** Register the chunk area kinds for an epoch right now (scene safety). */
export function ensureWildsAreaKinds(epoch: WildsEpoch): void {
  if (epoch.id) registerWildsAreas(epoch);
}

export interface WildsDiscovery {
  entityId: string;
  poiId: string;
  discovererId: string;
  displayName: string;
}

export interface WildsView {
  /** The server epoch id mutations name. */
  epochId: string;
  entities: WildsEntityView[];
  /** Entity ids this player personally claimed (chests, POIs). */
  claims: string[];
  discoveries: WildsDiscovery[];
  lanterns: WildsLanternView[];
  materials: Record<string, number>;
  /** This player's Echo assignments: site id → member, and whether it is settled. */
  echoes: Map<string, { member: string; settled: boolean }>;
  /** The last refresh failed: this is the Wilds as last seen, shown but not interactive. */
  stale: boolean;
  /** Bumps on every change; scenes re-render when it moves. */
  version: number;
}

interface RegionState {
  epoch: WildsEpoch;
  view: WildsView | null;
  inflight: Promise<boolean> | null;
  fetchedAt: number;
}

const regions = new Map<string, RegionState>();
let active: string = WILDS_REGION_ID;

// A fall that left a lantern changed the region: the next entry reads it
// again instead of reusing a recent read (prepareWilds' maxAge).
bus.on(EV.fallSettled, ({ lantern }) => {
  if (lantern !== 'placed') return;
  for (const r of regions.values()) r.fetchedAt = 0;
});

function unread(regionId: string): WildsEpoch {
  return { id: '', worldSeed: '', regionId, generatorVersion: 0, season: '', endsAt: null };
}

function regionState(id: string): RegionState {
  let r = regions.get(id);
  if (!r) {
    r = { epoch: unread(id), view: null, inflight: null, fetchedAt: 0 };
    regions.set(id, r);
  }
  return r;
}

function anyView(): boolean {
  return [...regions.values()].some((r) => r.view);
}

/** The region the current scene plays in (reads and claims default to it). */
export function setActiveWildsRegion(id: string): void {
  active = id === OUTER_REGION_ID ? OUTER_REGION_ID : WILDS_REGION_ID;
}

/** Wilds materials for the character panel (`null` until the Wilds load). */
export function wildsMaterials(): Record<string, number> | null {
  const v = regionState(active).view ?? [...regions.values()].find((r) => r.view)?.view ?? null;
  return v ? { ...v.materials } : null;
}

export function wildsView(region: string = active): WildsView | null {
  return regionState(region).view;
}

/**
 * The view, only while it is fresh and the link is online: what interaction
 * offers, claims, relights and Echo settling read. Null otherwise.
 */
export function wildsLive(session: Session, region: string = active): WildsView | null {
  const v = regionState(region).view;
  return v && !v.stale && session.link?.status === 'online' ? v : null;
}

/** Is the region shown as last seen (a stale view, or no connection)? */
export function wildsStale(session: Session, region: string = active): boolean {
  const v = regionState(region).view;
  return v !== null && wildsLive(session, region) === null;
}

export function wildsEpoch(region: string = active): WildsEpoch {
  return regionState(region).epoch;
}

/** When the region's epoch ends (Unix seconds), or null for the permanent Tangle. */
export function wildsEpochEndsAt(region: string = active): number | null {
  return regionState(region).epoch.endsAt;
}

/**
 * Has the outer Wilds' epoch this store holds ended? The server's `endsAt`
 * against the real clock (the server is what refuses an ended epoch).
 */
export function outerTurned(_session: Session): boolean {
  const r = regions.get(OUTER_REGION_ID);
  if (!r?.view || r.epoch.endsAt === null) return false;
  // The game's clock (the dev/playtest clock when it has been moved).
  return gameNow() >= r.epoch.endsAt;
}

/** Forget a region's state (the Turning): the next read names the new epoch. */
export function resetWildsRegion(id: string): void {
  regions.delete(id);
}

/**
 * Forget every region (a world move): the next read fetches the new world's
 * epochs, and no view of the old world's Wilds is reused.
 */
export function resetWilds(): void {
  regions.clear();
  bus.emit(EV.wilds, { materials: null });
}

function materialsRecord(list: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of MATERIALS) out[m.id] = 0;
  for (const [id, qty] of Object.entries(list)) out[id] = (out[id] ?? 0) + Number(qty);
  return out;
}

/** One balance across both regions' views. */
function setMaterials(m: Record<string, number>): void {
  for (const r of regions.values()) if (r.view) r.view.materials = { ...m };
}

function emitMaterials(): void {
  const materials = wildsMaterials();
  if (!materials) return;
  bus.emit(EV.wilds, { materials });
  // One server-owned balance everywhere: the shop's mirror follows.
  syncWildsMaterials(materials);
}

function bump(view: WildsView | null): void {
  if (view) view.version += 1;
  emitMaterials();
}

/** Available now? (A depleted camp or node shows its timer until the next read projects its cycle.) */
export function entityAvailable(e: WildsEntityView, nowSec: number): boolean {
  if (e.state === 'cleared' || e.state === 'harvested') return e.available_at > 0 && nowSec >= e.available_at;
  if (e.state === 'charted') return false;
  return true;
}

function lanternView(l: WildsLantern): WildsLanternView {
  return { id: l.id, ownerId: l.ownerId, displayName: l.displayName, x: l.x, y: l.y, litBy: l.litBy ?? null, at: l.at, litAt: l.litAt ?? null };
}

type StateLike = { id: string; cycle: number; state: string; availableAt: number; by?: string; at?: number };

function entityView(body: EntityBody, s: StateLike | undefined): WildsEntityView {
  return {
    ...body,
    enemies: [...body.enemies],
    cycle: s?.cycle ?? 0,
    state: (s?.state ?? 'available') as WildsEntityView['state'],
    available_at: s?.availableAt ?? 0,
    by: s?.by ?? null,
    at: s?.at ?? null,
  };
}

/**
 * Load/refresh a region (default: the active one): the region read, then its
 * epoch's chunks. Never moves the hero. Returns whether the region is usable.
 */
export async function refreshWilds(session: Session, maxAgeMs = 0, region: string = active): Promise<boolean> {
  const r = regionState(region);
  if (r.inflight) return r.inflight;
  const run = async (): Promise<boolean> => {
    const link = session.link;
    if (!link) return false;
    if (r.view && !r.view.stale && Date.now() - r.fetchedAt < maxAgeMs) return true;
    try {
      const ops = link.api.operations;
      const res = await ops.region(region);
      const e = res.epoch!;
      const terrains = await loadRegionChunks(ops, e.id, wildsRegion(region));
      const live = regionState(region);
      const changed = live.epoch.id !== e.id;
      // The outer region came back in another epoch than the one held: its
      // wick ended (the server's clock is past it, whatever this page's
      // says), so the Wilds turn under the player (the scene plays it).
      const turned = changed && !!live.epoch.id && region === OUTER_REGION_ID;
      live.epoch = { id: e.id, worldSeed: e.worldSeed, regionId: e.regionId, generatorVersion: e.generatorVersion, season: e.season, endsAt: e.endsAt ?? null };
      registerWildsAreas(live.epoch);
      const states = new Map(res.entities.map((s) => [s.id, s]));
      const prior = live.view;
      live.view = {
        epochId: e.id,
        entities: terrains.flatMap((t) => t.entities.map((b) => entityView(b, states.get(b.id)))),
        claims: res.personalClaims.map((c) => c.entityId),
        discoveries: res.discoveries.map((d) => ({ entityId: d.entityId, poiId: d.poiId, discovererId: d.discovererId, displayName: d.displayName })),
        lanterns: res.lanterns.map(lanternView),
        materials: materialsRecord(res.materials),
        echoes: new Map(res.echoes.map((a) => [a.site, { member: a.member, settled: a.settled }])),
        stale: false,
        version: (prior?.version ?? 0) + 1,
      };
      setMaterials(live.view.materials);
      live.fetchedAt = Date.now();
      if (changed) void pruneChunks([...regions.values()].map((x) => x.epoch.id).filter(Boolean));
      bump(live.view);
      if (turned) bus.emit(EV.turning, { reason: 'epoch-ended' });
      return true;
    } catch {
      // The last view stays to look at, marked stale; nothing in it is offered.
      const v = regionState(region).view;
      if (v && !v.stale) {
        v.stale = true;
        bump(v);
      }
      return false;
    }
  };
  r.inflight = run().finally(() => {
    const live = regions.get(region);
    if (live) live.inflight = null;
  });
  return r.inflight;
}

/**
 * Everything a session needs before it can play in the Wilds: the region its
 * save is in becomes active, and its epoch and chunks load. Await this before
 * building a Wilds chunk scene. True only for a fresh view. `maxAgeMs` lets chunk re-entries use a recent
 * read instead of refetching every walk.
 */
export async function prepareWilds(session: Session, maxAgeMs = 0): Promise<boolean> {
  const region = regionOfState(session.state);
  if (isWildsArea(session.state.area)) setActiveWildsRegion(region);
  if (!session.link) return false;
  watchHomesteadMaterials();
  if (isWildsArea(session.state.area)) return refreshWilds(session, maxAgeMs, region);
  return wildsLive(session, region) !== null;
}

/** A server claim answer: entity state, loot, balances. */
export function applyClaim(result: WildsClaimResult): LootDrop {
  const view = regionState(active).view;
  if (!view) throw new Error('wilds: claim before the region loaded');
  const s = result.entity;
  const e = s ? view.entities.find((x) => x.id === s.id) : undefined;
  if (e && s) {
    e.cycle = s.cycle;
    e.state = s.state as WildsEntityView['state'];
    e.available_at = s.availableAt;
    e.by = s.by ?? null;
    e.at = s.at ?? null;
    if ((e.kind === 'chest' || e.kind === 'poi') && !view.claims.includes(e.id)) view.claims.push(e.id);
  }
  // The answer carries the post-grant balances: replace the mirror.
  setMaterials(materialsRecord(result.materials));
  bump(view);
  return { materials: (result.loot?.materials ?? []).map((m) => ({ id: m.id, qty: m.qty })), trinket: result.loot?.trinket ?? null };
}

export function applyLanterns(lanterns: WildsLantern[]): void {
  const view = regionState(active).view;
  if (!view) return;
  view.lanterns = lanterns.map(lanternView);
  bump(view);
}

/** Record a settled Echo in the view (the answer to settle-echo). */
export function applyEchoSettled(site: string): void {
  const view = regionState(active).view;
  const a = view?.echoes.get(site);
  if (!view || !a) return;
  a.settled = true;
  bump(view);
}

/** A personal claim seen in a region read (chest/POI ids). */
export function isClaimed(entityId: string): boolean {
  return regionState(active).view?.claims.includes(entityId) ?? false;
}

export function discoveryFor(entityId: string): WildsDiscovery | null {
  return regionState(active).view?.discoveries.find((d) => d.entityId === entityId) ?? null;
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
