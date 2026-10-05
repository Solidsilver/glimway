/**
 * The Wilds region store: the client's picture of the Tangle, shared by the
 * chunk scenes and the character panel.
 *
 * Connected play — the server owns everything. `refreshWilds` reads
 * GET /api/wilds/region/inner-1 (epoch, entities with cycles, personal
 * claims, discoveries, lanterns, material balances) and claims go through
 * POST /api/wilds/claim. A claim is always preceded by a fresh read, because
 * a read is what advances a respawn cycle: claiming a node that regrew needs
 * the cycle the read produced (the server rejects the old one).
 *
 * Guests — no server, no shared state (brief item 7). The Tangle generates
 * from a fixed local epoch (regions.ts) and claims apply locally with the
 * same timers the server uses (content/wilds.json): a harvested node regrows
 * in 300s, a cleared camp returns in 600s, and each chest and POI pays its
 * personal loot once per visit (in memory only). Loot rolls use the same
 * `rollLoot` the server uses, so guest loot matches the generator. Guest
 * materials persist in the save as `material:<id>:<qty>` pack entries;
 * trinkets are ordinary pack entries.
 */
import { MATERIALS, TRINKETS } from '../../content/expansion-writing.ts';
import { chunkEntities, rollLoot } from '../../lib/wilds/index.ts';
import type { Epoch, LootDrop, WildsEntityKind } from '../../lib/wilds/types.ts';
import type { WildsEntityView, WildsLanternView, WildsMaterials } from '../../lib/api/types.ts';
import { loadWilds } from '../../lib/wilds/data.ts';
import { EV, bus } from '../events';
import type { Session } from '../session';
import { WILDS_REGION_ID, guestEpoch, isWildsArea } from './regions.ts';
import { registerWildsAreas } from './areas.ts';

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

const TIMERS = loadWilds().timers;

let view: WildsView | null = null;
let epoch: Epoch = guestEpoch();
let inflight: Promise<boolean> | null = null;
let fetchedAt = 0;

/** Wilds materials for the character panel (`null` until the Wilds load). */
export function wildsMaterials(): Record<string, number> | null {
  return view ? { ...view.materials } : null;
}

export function wildsView(): WildsView | null {
  return view;
}

export function wildsEpoch(): Epoch {
  return epoch;
}

function materialsRecord(list: { id: string; qty: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of MATERIALS) out[m.id] = 0;
  for (const m of list) out[m.id] = (out[m.id] ?? 0) + m.qty;
  return out;
}

function emitMaterials(): void {
  if (!view) return;
  bus.emit(EV.wilds, { materials: wildsMaterials() });
}

function bump(): void {
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

/** Pack entries that carry a guest's material balance. */
export const MATERIAL_ITEM_PREFIX = 'material:';

export function materialsFromInventory(inventory: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of MATERIALS) out[m.id] = 0;
  for (const entry of inventory) {
    if (!entry.startsWith(MATERIAL_ITEM_PREFIX)) continue;
    const rest = entry.slice(MATERIAL_ITEM_PREFIX.length);
    const at = rest.lastIndexOf(':');
    const id = rest.slice(0, at);
    const qty = Number(rest.slice(at + 1));
    if (id in out && Number.isInteger(qty) && qty > 0) out[id] = qty;
  }
  return out;
}

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
function guestEntities(): WildsEntityView[] {
  const out: WildsEntityView[] = [];
  const data = loadWilds();
  const region = data.regions.find((r) => r.id === WILDS_REGION_ID)!;
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
 * Make the store usable for a guest session (fixed epoch, entities from the
 * generator, materials read back from the pack). Safe to call again.
 */
function guestInit(session: Session): void {
  epoch = guestEpoch();
  registerWildsAreas(epoch);
  if (!view || !view.guest) {
    const materials = materialsFromInventory(session.state.inventory);
    view = {
      epochId: '',
      guest: true,
      entities: guestEntities(),
      claims: [],
      discoveries: [],
      lanterns: [],
      materials,
      version: 0,
    };
    bump();
  }
}

/**
 * A guest claim: local shared-state rules only. Returns the loot, or null
 * when the entity is not claimable right now (depleted, already claimed, or
 * a camp whose enemies are still up).
 */
export function guestClaim(entityId: string, session: Session): LootDrop | null {
  if (!view || !view.guest) return null;
  const nowSec = Math.floor(Date.now() / 1000);
  advanceReadyGuests(nowSec);
  const e = view.entities.find((x) => x.id === entityId);
  if (!e || isClaimed(entityId) || !entityAvailable(e, nowSec)) return null;
  const drop = rollLoot(epoch, entityId, e.cycle);
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
  applyLoot(session, drop);
  bump();
  return drop;
}

/**
 * Advance every depleted camp/node whose timer has passed (the server does
 * this on read; guests do it locally). Called by the scene's tick.
 */
export function tickWildsGuest(): void {
  if (!view || !view.guest) return;
  advanceReadyGuests(Math.floor(Date.now() / 1000));
}

function advanceReadyGuests(nowSec: number): void {
  if (!view) return;
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
function applyLoot(session: Session, drop: LootDrop): void {
  if (!view) return;
  for (const m of drop.materials) view.materials[m.id] = (view.materials[m.id] ?? 0) + m.qty;
  if (view.guest) {
    // Guests persist materials in the pack; connected play leaves balances
    // to the server (they arrive with each response).
    session.state = {
      ...session.state,
      inventory: inventoryWithMaterials(
        drop.trinket && !session.state.inventory.includes(drop.trinket)
          ? [...session.state.inventory, drop.trinket]
          : session.state.inventory,
        view.materials
      ),
    };
    session.saveSoon();
  }
}

// ------------------------------------------------------------ connected mode

/**
 * Load/refresh the region. Connected: a GET (adopting a newer rev and
 * balances; never moving the hero). Guest: the local synth. Returns whether
 * the region is usable afterwards.
 */
export async function refreshWilds(session: Session, maxAgeMs = 0): Promise<boolean> {
  if (inflight) return inflight;
  const run = async (): Promise<boolean> => {
    if (!session.link) {
      guestInit(session);
      fetchedAt = Date.now();
      return true;
    }
    if (view && !view.guest && Date.now() - fetchedAt < maxAgeMs) return true;
    try {
      const res = await session.link.wildsRegion(WILDS_REGION_ID);
      epoch = {
        worldSeed: res.epoch.worldSeed,
        regionId: res.epoch.regionId,
        generatorVersion: res.epoch.generatorVersion,
        season: res.epoch.season,
      };
      registerWildsAreas(epoch);
      const prior = view && !view.guest ? view : null;
      view = {
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
      fetchedAt = Date.now();
      bump();
      return true;
    } catch {
      return view !== null && !view.guest;
    }
  };
  inflight = run().finally(() => {
    inflight = null;
  });
  return inflight;
}

/**
 * Everything a connected session needs before it can play in the Wilds:
 * guests get their local region immediately; connected players fetch the
 * region (so terrain and entities share the server's epoch). Await this
 * before building a Wilds chunk scene. `maxAgeMs` lets chunk re-entries use
 * a recent read instead of refetching every walk between chunks.
 */
export async function prepareWilds(session: Session, maxAgeMs = 0): Promise<boolean> {
  if (!session.link) {
    guestInit(session);
    return true;
  }
  // Switching from a guest session to a connected one: the guest's local
  // region (and its materials view) does not carry over.
  if (view?.guest) {
    view = null;
    bus.emit(EV.wilds, { materials: null });
  }
  if (isWildsArea(session.state.area)) return refreshWilds(session, maxAgeMs);
  return view !== null && !view.guest;
}

/** A server claim answer: entity state, loot, balances. */
export function applyClaim(result: {
  entity: WildsEntityView;
  loot: { materials: { id: string; qty: number }[]; trinket: string | null };
  materials: WildsMaterials;
}): LootDrop {
  if (!view) throw new Error('wilds: claim before the region loaded');
  const e = view.entities.find((x) => x.id === result.entity.id);
  if (e) Object.assign(e, result.entity);
  if (result.entity.kind === 'chest' || result.entity.kind === 'poi') {
    if (!view.claims.includes(result.entity.id)) view.claims.push(result.entity.id);
  }
  // The response carries the post-grant balances: replace the mirror.
  view.materials = materialsRecord(Object.entries(result.materials).map(([id, qty]) => ({ id, qty: Number(qty) })));
  bump();
  return { materials: result.loot.materials, trinket: result.loot.trinket };
}

export function applyLanterns(lanterns: WildsLanternView[]): void {
  if (!view) return;
  view.lanterns = lanterns;
  bump();
}

/** A personal claim seen in a region read (chest/POI ids). */
export function isClaimed(entityId: string): boolean {
  return view?.claims.includes(entityId) ?? false;
}

export function discoveryFor(entityId: string): WildsDiscovery | null {
  return view?.discoveries.find((d) => d.entityId === entityId) ?? null;
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

/** The generated entity kind of an id, or null. */
export function entityKindOf(id: string): WildsEntityKind | null {
  const kind = id.split(':')[0];
  return kind === 'camp' || kind === 'node' || kind === 'chest' || kind === 'poi' ? kind : null;
}
