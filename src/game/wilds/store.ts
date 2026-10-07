/**
 * The Wilds region store: the client's picture of the Tangle and the outer
 * Wilds, shared by the chunk scenes and the character panel.
 *
 * Two regions, one active: the region the current scene plays in. Reads and
 * claims go to the active region unless a region is named.
 *
 * Connected play — the server owns everything. `refreshWilds` reads
 * GET /api/wilds/region/<id> (epoch, entities with cycles, personal claims,
 * discoveries, lanterns, material balances) and claims go through
 * POST /api/wilds/claim. A claim is always preceded by a fresh read, because
 * a read is what advances a respawn cycle: claiming a node that regrew needs
 * the cycle the read produced (the server rejects the old one). The outer
 * epoch carries its `endsAt`; past it the region has turned.
 *
 * Guests — no server, no shared state (brief item 7). Both regions generate
 * from local epochs: the Tangle's is fixed; the outer Wilds' season follows
 * the shared calendar (lib/wilds/outer.ts), so it turns every wick exactly
 * as it does for connected players. Claims apply locally with the same
 * timers the server uses (content/wilds.json): a harvested node regrows in
 * 300s, a cleared camp returns in 600s, and each chest and POI pays its
 * personal loot once per epoch visit (in memory only). Loot rolls use the
 * same `rollLoot` the server uses. Guest materials persist in the save as
 * `material:<id>:<qty>` pack entries; trinkets are ordinary pack entries.
 */
import { MATERIALS, TRINKETS } from '../../content/expansion-writing.ts';
import { chunkEntities, rollLoot } from '../../lib/wilds/index.ts';
import { epochEnded, guestOuterEpoch } from '../../lib/wilds/outer.ts';
import type { Epoch, LootDrop } from '../../lib/wilds/types.ts';
import type { WildsEntityView, WildsLanternView, WildsMaterials } from '../../lib/api/types.ts';
import { loadWilds } from '../../lib/wilds/data.ts';
import { EV, bus } from '../events';
import { gameNow } from '../clock';
import type { Session } from '../session';
import { OUTER_REGION_ID, WILDS_REGION_ID, guestEpoch, isWildsArea, regionOfState, wildsRegion } from './regions.ts';
import { registerWildsAreas } from './areas.ts';
import { HOME_EV, currentHomesteadMaterials, syncWildsMaterials } from '../homestead.ts';

/**
 * One server-owned material balance everywhere: when the shop (homestead
 * actions) moves it, this store's mirror follows.
 */
let homesteadWatch = false;
function watchHomesteadMaterials(): void {
  if (homesteadWatch) return;
  homesteadWatch = true;
  bus.on(HOME_EV.changed, () => {
    const m = currentHomesteadMaterials();
    if (m && anyConnectedView()) {
      setMaterials(m);
      emitMaterials();
    }
  });
}

/** Register the chunk area kinds for an epoch right now (scene safety). */
export function ensureWildsAreaKinds(epoch: Epoch): void {
  registerWildsAreas(epoch);
}

export interface WildsDiscovery {
  entityId: string;
  poiId: string;
  discovererId: string;
  displayName: string;
}

export interface WildsView {
  /** Server epoch id ('' for guests: mutations take none). */
  epochId: string;
  guest: boolean;
  entities: WildsEntityView[];
  /** Entity ids this player personally claimed (chests, POIs). */
  claims: string[];
  discoveries: WildsDiscovery[];
  lanterns: WildsLanternView[];
  materials: Record<string, number>;
  /** Bumps on every change; scenes re-render when it moves. */
  version: number;
}

interface RegionState {
  epoch: Epoch;
  /** Unix seconds the epoch ends (the outer Wilds); null when permanent. */
  endsAt: number | null;
  view: WildsView | null;
  inflight: Promise<boolean> | null;
  fetchedAt: number;
}

const TIMERS = loadWilds().timers;

const regions = new Map<string, RegionState>();
let active: string = WILDS_REGION_ID;

function regionState(id: string): RegionState {
  let r = regions.get(id);
  if (!r) {
    const epoch = id === OUTER_REGION_ID ? guestOuterEpoch(gameNow()) : guestEpoch();
    r = { epoch, endsAt: null, view: null, inflight: null, fetchedAt: 0 };
    regions.set(id, r);
  }
  return r;
}

function anyConnectedView(): boolean {
  return [...regions.values()].some((r) => r.view && !r.view.guest);
}

/** The region the current scene plays in (reads and claims default to it). */
export function setActiveWildsRegion(id: string): void {
  active = id === OUTER_REGION_ID ? OUTER_REGION_ID : WILDS_REGION_ID;
}

export function activeWildsRegion(): string {
  return active;
}

/** Wilds materials for the character panel (`null` until the Wilds load). */
export function wildsMaterials(): Record<string, number> | null {
  const v = regionState(active).view ?? [...regions.values()].find((r) => r.view)?.view ?? null;
  return v ? { ...v.materials } : null;
}

export function wildsView(region: string = active): WildsView | null {
  return regionState(region).view;
}

export function wildsEpoch(region: string = active): Epoch {
  return regionState(region).epoch;
}

/** When the region's epoch ends (Unix seconds), or null for the permanent Tangle. */
export function wildsEpochEndsAt(region: string = active): number | null {
  const r = regionState(region);
  return r.endsAt;
}

/**
 * Has the outer Wilds' epoch this store holds ended? Guests follow the game
 * clock (the calendar, dev offset included); connected players the server's
 * `endsAt` against the real clock (the server is what refuses an ended epoch).
 */
export function outerTurned(session: Session): boolean {
  const r = regions.get(OUTER_REGION_ID);
  if (!r) return false;
  if (!session.link) return guestOuterEpoch(gameNow()).season !== r.epoch.season;
  return r.view !== null && !r.view.guest && epochEnded(r.epoch.season, Math.floor(Date.now() / 1000), r.endsAt);
}

/**
 * Forget a region's state (the Turning): the next read builds the new epoch.
 * Guests regenerate; connected players refetch.
 */
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

function materialsRecord(list: { id: string; qty: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of MATERIALS) out[m.id] = 0;
  for (const m of list) out[m.id] = (out[m.id] ?? 0) + m.qty;
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
  if (anyConnectedView()) syncWildsMaterials(materials);
}

function bump(view: WildsView | null): void {
  if (view) view.version += 1;
  emitMaterials();
}

/** Entity view with guest timers folded in (server views carry their own). */
export function entityAvailable(e: WildsEntityView, nowSec: number): boolean {
  if (e.state === 'cleared' || e.state === 'harvested') return e.available_at > 0 && nowSec >= e.available_at;
  if (e.state === 'charted') return false;
  return true;
}

// ------------------------------------------------------------ guest mode

// Pack entries that carry a guest's material balance (parser in src/lib/inventory.ts).
import { MATERIAL_ITEM_PREFIX, materialsFromPack as materialsFromInventory } from '../../lib/inventory.ts';

function inventoryWithMaterials(inventory: readonly string[], materials: Record<string, number>): string[] {
  const kept = inventory.filter((i) => !i.startsWith(MATERIAL_ITEM_PREFIX));
  const out = [...kept];
  for (const m of MATERIALS) {
    const qty = Math.max(0, Math.floor(materials[m.id] ?? 0));
    if (qty > 0) out.push(`${MATERIAL_ITEM_PREFIX}${m.id}:${qty}`);
  }
  return out;
}

/** An entity list generated locally, all available (guest mode). */
function guestEntities(epoch: Epoch): WildsEntityView[] {
  const out: WildsEntityView[] = [];
  const region = wildsRegion(epoch.regionId);
  for (let cy = 0; cy < region.gridHeight; cy++) {
    for (let cx = 0; cx < region.gridWidth; cx++) {
      for (const e of chunkEntities(epoch, cx, cy)) {
        out.push({ ...e, cycle: 0, state: 'available', available_at: 0, by: null, at: null });
      }
    }
  }
  return out;
}

/**
 * Make a region usable for a guest session (local epoch, entities from the
 * generator, materials read back from the pack). Safe to call again; a guest
 * outer region whose wick has passed regenerates as the new epoch.
 */
function guestInit(session: Session, id: string): void {
  const r = regionState(id);
  const epoch = id === OUTER_REGION_ID ? guestOuterEpoch(gameNow()) : guestEpoch();
  const turned = epoch.season !== r.epoch.season;
  if (!r.view || !r.view.guest || turned) {
    r.epoch = epoch;
    r.endsAt = null;
    const materials = materialsFromInventory(session.state.inventory);
    r.view = {
      epochId: '',
      guest: true,
      entities: guestEntities(epoch),
      claims: [],
      discoveries: [],
      lanterns: [],
      materials,
      version: (r.view?.version ?? 0) + 1,
    };
    registerWildsAreas(epoch);
    bump(r.view);
  } else registerWildsAreas(r.epoch);
}

/**
 * A guest claim: local shared-state rules only. Returns the loot, or null
 * when the entity is not claimable right now (depleted, already claimed, or
 * a camp whose enemies are still up).
 */
export function guestClaim(entityId: string, session: Session): LootDrop | null {
  const r = regionState(active);
  const view = r.view;
  if (!view || !view.guest) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  advanceReadyGuests(view, nowSec);
  const e = view.entities.find((x) => x.id === entityId);
  if (!e || isClaimed(entityId) || !entityAvailable(e, nowSec)) return null;
  const drop = rollLoot(r.epoch, entityId, e.cycle);
  if (e.kind === 'camp') {
    e.state = 'cleared';
    e.available_at = nowSec + TIMERS.campRespawnSeconds;
  } else if (e.kind === 'node') {
    e.state = 'harvested';
    e.available_at = nowSec + TIMERS.nodeRegrowSeconds;
  } else {
    e.state = e.kind === 'poi' ? 'charted' : 'available';
    e.available_at = 0;
    view.claims.push(entityId);
  }
  e.by = 'you';
  e.at = nowSec;
  applyLoot(session, view, drop);
  bump(view);
  return drop;
}

/**
 * Advance every depleted camp/node whose timer has passed (the server does
 * this on read; guests do it locally). Called by the scene's tick.
 */
export function tickWildsGuest(): void {
  const view = regionState(active).view;
  if (!view || !view.guest) return;
  advanceReadyGuests(view, Math.floor(Date.now() / 1000));
}

function advanceReadyGuests(view: WildsView, nowSec: number): void {
  for (const e of view.entities) {
    if (e.kind !== 'camp' && e.kind !== 'node') continue;
    if (e.state === 'available' || e.available_at <= 0 || nowSec < e.available_at) continue;
    e.state = 'available';
    e.cycle += 1;
    e.available_at = 0;
    e.by = null;
    e.at = null;
  }
}

/** Guest loot lands in the pack (materials as balance entries, trinkets as items). */
function applyLoot(session: Session, view: WildsView, drop: LootDrop): void {
  const materials = { ...view.materials };
  for (const m of drop.materials) materials[m.id] = (materials[m.id] ?? 0) + m.qty;
  setMaterials(materials);
  if (view.guest) {
    // Guests persist materials in the pack; connected play leaves balances
    // to the server (they arrive with each response).
    session.state = {
      ...session.state,
      inventory: inventoryWithMaterials(
        drop.trinket && !session.state.inventory.includes(drop.trinket)
          ? [...session.state.inventory, drop.trinket]
          : session.state.inventory,
        materials
      ),
    };
    session.saveSoon();
  }
}

// ------------------------------------------------------------ connected mode

/**
 * Load/refresh a region (default: the active one). Connected: a GET
 * (adopting a newer rev and balances; never moving the hero). Guest: the
 * local synth. Returns whether the region is usable afterwards.
 */
export async function refreshWilds(session: Session, maxAgeMs = 0, region: string = active): Promise<boolean> {
  const r = regionState(region);
  if (r.inflight) return r.inflight;
  const run = async (): Promise<boolean> => {
    if (!session.link) {
      guestInit(session, region);
      r.fetchedAt = Date.now();
      return true;
    }
    if (r.view && !r.view.guest && Date.now() - r.fetchedAt < maxAgeMs) return true;
    try {
      const res = await session.link.wildsRegion(region);
      const live = regionState(region);
      live.epoch = {
        worldSeed: res.epoch.worldSeed,
        regionId: res.epoch.regionId,
        generatorVersion: res.epoch.generatorVersion,
        season: res.epoch.season,
      };
      live.endsAt = typeof res.epoch.endsAt === 'number' ? res.epoch.endsAt : null;
      registerWildsAreas(live.epoch);
      const prior = live.view && !live.view.guest ? live.view : null;
      live.view = {
        epochId: res.epoch.id,
        guest: false,
        entities: res.entities,
        claims: res.personalClaims.map((c) => c.entityId),
        discoveries: res.discoveries.map((d) => ({
          entityId: d.entityId,
          poiId: d.poiId,
          discovererId: d.discovererId,
          displayName: d.displayName,
        })),
        lanterns: res.lanterns,
        materials: materialsRecord(Object.entries(res.materials).map(([id, qty]) => ({ id, qty }))),
        version: (prior?.version ?? 0) + 1,
      };
      setMaterials(live.view.materials);
      live.fetchedAt = Date.now();
      bump(live.view);
      return true;
    } catch {
      const v = regionState(region).view;
      return v !== null && !v.guest;
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
 * save is in becomes active; guests get their local region immediately;
 * connected players fetch it (so terrain and entities share the server's
 * epoch). Await this before building a Wilds chunk scene. `maxAgeMs` lets
 * chunk re-entries use a recent read instead of refetching every walk.
 */
export async function prepareWilds(session: Session, maxAgeMs = 0): Promise<boolean> {
  const region = regionOfState(session.state);
  if (isWildsArea(session.state.area)) setActiveWildsRegion(region);
  if (!session.link) {
    guestInit(session, region);
    return true;
  }
  // Switching from a guest session to a connected one: the guest's local
  // regions (and their materials view) do not carry over.
  if ([...regions.values()].some((r) => r.view?.guest)) {
    regions.clear();
    bus.emit(EV.wilds, { materials: null });
  }
  watchHomesteadMaterials();
  if (isWildsArea(session.state.area)) return refreshWilds(session, maxAgeMs, region);
  const v = regionState(region).view;
  return v !== null && !v.guest;
}

/** A server claim answer: entity state, loot, balances. */
export function applyClaim(result: {
  entity: WildsEntityView;
  loot: { materials: { id: string; qty: number }[]; trinket: string | null };
  materials: WildsMaterials;
}): LootDrop {
  const view = regionState(active).view;
  if (!view) throw new Error('wilds: claim before the region loaded');
  const e = view.entities.find((x) => x.id === result.entity.id);
  if (e) Object.assign(e, result.entity);
  if (result.entity.kind === 'chest' || result.entity.kind === 'poi') {
    if (!view.claims.includes(result.entity.id)) view.claims.push(result.entity.id);
  }
  // The response carries the post-grant balances: replace the mirror.
  setMaterials(materialsRecord(Object.entries(result.materials).map(([id, qty]) => ({ id, qty: Number(qty) }))));
  bump(view);
  return { materials: result.loot.materials, trinket: result.loot.trinket };
}

export function applyLanterns(lanterns: WildsLanternView[]): void {
  const view = regionState(active).view;
  if (!view) return;
  view.lanterns = lanterns;
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

