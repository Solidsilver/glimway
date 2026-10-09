/**
 * The homestead routes (proto/glimway/v1/homestead.proto): the gate read,
 * the keyed lane mutations, the gate shelf and the woodpile. Responses
 * decode through the generated protobuf-es types (fromJson) and project
 * onto the game's shapes: tile pairs stay [x, y] tuples, absent optionals
 * stay null, and ProtoJSON's extra spellings are refused (ApiError
 * `bad-response`), as parse.ts did by hand.
 */
import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import {
  HomesteadReadSchema, HomesteadResultSchema, ShelfReadSchema, ShelfResultSchema,
  WoodpileReadSchema, WoodpileResultSchema,
  type HomesteadRead, type HomesteadResult,
  type ShelfRead, type ShelfResult, type ShelfView as GeneratedShelfView,
  type WoodpileRead, type WoodpileResult, type WoodpileView as GeneratedWoodpileView,
} from '../gen/glimway/v1/homestead_pb.js';
import { type HomeView as GeneratedHomeView } from '../gen/glimway/v1/goods_pb.js';
import { ApiError } from './errors.ts';
import { parseSnapshot } from './parse.ts';
import { projectAsset, projectCounts } from './items.ts';
import type { Asset, AssetCounts, Snapshot } from './types.ts';
import type { HomeInstance } from '../homestead.ts';

export interface HomeMember {
  id: string;
  displayName: string;
}

export interface HomePlantView {
  id: string;
  itemDef: string;
  x: number;
  y: number;
  plantedAt?: number;
  plantedDay?: number;
  lit: boolean;
}

/**
 * A homestead (GET /api/homestead/gate/:g, and every homestead POST): its
 * land's changes, its placed pieces, and the caller's own pack of
 * decorations when the caller is a member.
 */
export interface HomeView {
  id: string;
  gate: number;
  worldId: string;
  tier: number;
  members: HomeMember[];
  /** The caller is on the deed. */
  member: boolean;
  /** No members for a while: overgrown, dark windows, a weathered sign. */
  desolate: boolean;
  vacantSince: number | null;
  landSeed: number;
  /** Tiles Silas has cleared (trees, stumps, boulders gone). */
  cleared: [number, number][];
  postsBought: number;
  /** What the next lantern post costs. */
  nextPost: Record<string, number>;
  /** null below the Cottage (tier 1). */
  indoor: { width: number; height: number } | null;
  items: HomeInstance[];
  stumps: [number, number][];
  plants: HomePlantView[];
}

export interface HomeResponse extends Snapshot {
  gate: number;
  landSeed: number;
  home: HomeView | null;
  materials: Record<string, number>;
}

export type HomeOp = 'buy' | 'place' | 'move' | 'remove' | 'upgrade' | 'claim' | 'clear' | 'invite' | 'joint' | 'leave';

/** The op-specific fields of a homestead POST (lease, rev, key and progress are added by the link). */
export type HomeAction =
  | { op: 'buy'; itemDef: string }
  | { op: 'place' | 'move'; itemId: string; scene: 'indoor' | 'outdoor' | 'gate'; x?: number; y?: number; rotation?: number; name?: string }
  | { op: 'remove'; itemId: string }
  | { op: 'upgrade'; tier: number }
  | { op: 'claim'; gate: number }
  | { op: 'clear'; x: number; y: number }
  | { op: 'invite'; to: string }
  | { op: 'joint'; homeId: string; to: string }
  | { op: 'leave' };

export interface HomeActionRequest {
  op: { lease: string; key: string };
  where: { area: string; x: number; y: number };
  itemDef?: string;
  itemId?: string;
  scene?: 'indoor' | 'outdoor' | 'gate';
  x?: number;
  y?: number;
  rotation?: number;
  tier?: number;
  name?: string;
  gate?: number;
  to?: string;
  homeId?: string;
}

export interface HomeActionResponse extends Snapshot {
  result: { home: HomeView | null; materials: Record<string, number>; itemId?: string; status?: 'joined' | 'waiting' };
}

export interface ShelfSlotView {
  slot: number;
  kind: 'material' | 'item' | 'decoration' | 'instance';
  itemDef: string;
  qty: number;
  maker?: { id: string; name: string } | null;
  instance?: string | null;
  stockedBy: string;
  stockedAt: number;
}

export interface ShelfView {
  gate: number;
  homeId: string;
  ownerName: string;
  names: string[];
  slots: ShelfSlotView[];
  takenToday: boolean;
  canStock: boolean;
  hasShelf: boolean;
}

export interface ShelfResponse extends Snapshot {
  shelf: ShelfView;
}

export interface ShelfRequest {
  op: { lease: string; key: string };
  where: { area: string; x: number; y: number };
  /** The shelf's own action (it was `op` before the operation header took that name). */
  action: 'stock' | 'take';
  gate: number;
  slot: number;
  asset?: Asset;
}

export interface ShelfActionResponse extends Snapshot {
  shelf: ShelfView;
  inventory: import('./types.ts').AssetCounts;
  taken?: Asset;
  line?: string;
}

/** One stack of green timber on a placed woodpile (seasons after a real day). */
export interface WoodpileStack {
  id: string;
  homesteadId: string;
  accountId: string;
  qty: number;
  stackedAt: number;
  ready: boolean;
  /** Seconds until it is seasoned (0 once ready). */
  remaining: number;
}

export interface WoodpileView {
  homesteadId: string;
  placed: boolean;
  stacks: WoodpileStack[];
  readyCount: number;
  totalTimber: number;
}

/** GET /api/homestead/woodpile: the stacks and the snapshot. */
export interface WoodpileResponse extends Snapshot {
  woodpile: WoodpileView;
}

/** Stack green timber, or collect seasoned timber (POST /api/homestead/woodpile). */
export interface WoodpileActionResponse extends Snapshot {
  result: {
    home: HomeView | null;
    inventory: AssetCounts;
    storage: AssetCounts | null;
    personal: AssetCounts;
    shared: string;
    woodpile: WoodpileView;
    action: 'stack' | 'collect' | string;
    collectedQty?: number;
  };
}

function decoded<T>(read: () => T): T {
  try { return read(); } catch { throw new ApiError('bad-response'); }
}

const int = (v: number | undefined, min = 0): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min) throw new Error('invalid integer');
  return v;
};

const num = (v: number | undefined): number => {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error('invalid number');
  return v;
};

const countMap = (v: Record<string, number> | undefined): Record<string, number> => {
  const out: Record<string, number> = {};
  if (v) for (const [k, n] of Object.entries(v)) if (Number.isInteger(n) && n >= 0) out[k] = n;
  return out;
};

const pair = (c: { x: number; y: number }): [number, number] => [int(c.x), int(c.y)];

type GeneratedHomeInstance = GeneratedHomeView['items'][number];

function homeInstance(v: GeneratedHomeInstance): HomeInstance {
  const placed = v.scene !== undefined;
  if (placed) {
    if (!['indoor', 'outdoor', 'gate'].includes(v.scene!) || ![0, 90, 180, 270].includes(v.rotation ?? -1)) throw new Error('invalid placement');
  }
  return {
    id: v.id,
    itemDef: v.itemDef,
    scene: placed ? (v.scene as HomeInstance['scene']) : null,
    x: placed ? int(v.x) : null,
    y: placed ? int(v.y) : null,
    rotation: placed ? (v.rotation as HomeInstance['rotation']) : null,
    name: v.name ? v.name.slice(0, 80) : null,
  };
}

/** The homestead view, projected (tiles as tuples, nulls kept). */
function projectHome(h: GeneratedHomeView): HomeView {
  if (!h.id || !Array.isArray(h.members)) throw new Error('invalid home');
  return {
    id: h.id,
    gate: int(h.gate),
    worldId: h.worldId,
    tier: int(h.tier),
    members: h.members.map((m): HomeMember => ({ id: m.id, displayName: m.displayName.slice(0, 64) })),
    member: h.member,
    desolate: h.desolate,
    vacantSince: h.vacantSince ?? null,
    landSeed: int(h.landSeed),
    cleared: h.cleared.map(pair),
    stumps: h.stumps.map(pair),
    plants: h.plants.map((p): HomePlantView => ({
      id: p.id,
      itemDef: p.itemDef,
      x: int(p.x),
      y: int(p.y),
      plantedAt: p.plantedAt ?? undefined,
      plantedDay: p.plantedDay ?? undefined,
      lit: p.lit,
    })),
    postsBought: int(h.postsBought),
    nextPost: countMap(h.nextPost),
    indoor: h.indoor ? { width: int(h.indoor.width, 1), height: int(h.indoor.height, 1) } : null,
    items: h.items.map(homeInstance),
  };
}

/** GET /api/homestead/gate/:g — the homestead behind a Commons gate. */
export function parseHome(raw: unknown): HomeResponse {
  return decoded(() => {
    const o = raw as Record<string, unknown>;
    const read = fromJson(HomesteadReadSchema, (o.result !== undefined ? o.result : o) as JsonValue, { ignoreUnknownFields: true }) as HomesteadRead;
    return {
      ...parseSnapshot(raw),
      gate: int(read.gate),
      landSeed: int(read.landSeed),
      home: read.home ? projectHome(read.home) : null,
      materials: countMap(read.materials),
    };
  });
}

/** A keyed homestead mutation (claim, buy, place, …, joint, leave). */
export function parseHomeAction(raw: unknown): HomeActionResponse {
  return decoded(() => {
    const o = raw as Record<string, unknown>;
    if (!o.result || typeof o.result !== 'object') throw new Error('missing result');
    const r = fromJson(HomesteadResultSchema, (o.result ?? null) as JsonValue, { ignoreUnknownFields: true }) as HomesteadResult;
    const result: HomeActionResponse['result'] = { home: r.home ? projectHome(r.home) : null, materials: countMap(r.materials) };
    if (r.itemId) result.itemId = r.itemId;
    if (r.status === 'joined' || r.status === 'waiting') result.status = r.status;
    return { ...parseSnapshot(raw), result };
  });
}

function shelfView(v: GeneratedShelfView): ShelfView {
  return {
    gate: int(v.gate),
    homeId: v.homeId,
    ownerName: v.ownerName,
    names: v.names.map((n) => n.slice(0, 64)),
    slots: v.slots.map((s): ShelfSlotView => ({
      slot: int(s.slot),
      kind: s.kind as ShelfSlotView['kind'],
      itemDef: s.itemDef,
      qty: int(s.qty),
      maker: s.maker ? { id: s.maker.id, name: s.maker.name.slice(0, 64) } : null,
      instance: s.instance ?? null,
      stockedBy: s.stockedBy,
      stockedAt: num(s.stockedAt),
    })),
    takenToday: v.takenToday,
    canStock: v.canStock,
    hasShelf: v.hasShelf,
  };
}

/** GET /api/homestead/shelf — the shelf at a Commons gate. */
export function parseShelf(raw: unknown): ShelfResponse {
  return decoded(() => {
    const o = raw as Record<string, unknown>;
    const read = fromJson(ShelfReadSchema, (o.result !== undefined ? o.result : o) as JsonValue, { ignoreUnknownFields: true }) as ShelfRead;
    if (!read.shelf) throw new Error('missing shelf');
    return { ...parseSnapshot(raw), shelf: shelfView(read.shelf) };
  });
}

/** A keyed gate shelf mutation (stock or take). */
export function parseShelfAction(raw: unknown): ShelfActionResponse {
  return decoded(() => {
    const o = raw as Record<string, unknown>;
    if (!o.result || typeof o.result !== 'object') throw new Error('missing result');
    const r = fromJson(ShelfResultSchema, (o.result ?? null) as JsonValue, { ignoreUnknownFields: true }) as ShelfResult;
    if (!r.shelf) throw new Error('missing shelf');
    return {
      ...parseSnapshot(raw),
      shelf: shelfView(r.shelf),
      inventory: projectCounts(r.inventory),
      ...(r.taken ? { taken: projectAsset(r.taken) } : {}),
      ...(r.line ? { line: r.line } : {}),
    };
  });
}

function woodpile(v: GeneratedWoodpileView): WoodpileView {
  return {
    homesteadId: v.homesteadId,
    placed: v.placed,
    stacks: v.stacks.map((s) => {
      const remaining = Math.max(0, num(s.remaining));
      return {
        id: s.id,
        homesteadId: s.homesteadId,
        accountId: s.accountId,
        qty: int(s.qty, 1),
        stackedAt: num(s.stackedAt),
        ready: s.ready || remaining <= 0,
        remaining,
      };
    }),
    readyCount: int(v.readyCount, 0),
    totalTimber: int(v.totalTimber, 0),
  };
}

/** GET /api/homestead/woodpile — the stacks and the snapshot. */
export function parseWoodpileRead(raw: unknown): WoodpileResponse {
  return decoded(() => {
    const o = raw as Record<string, unknown>;
    const read = fromJson(WoodpileReadSchema, (o.result !== undefined ? o.result : o) as JsonValue, { ignoreUnknownFields: true }) as WoodpileRead;
    if (!read.woodpile) throw new Error('missing woodpile');
    return { ...parseSnapshot(raw), woodpile: woodpile(read.woodpile) };
  });
}

/** Stack green timber, or collect seasoned timber (POST /api/homestead/woodpile). */
export function parseWoodpileAction(raw: unknown): WoodpileActionResponse {
  return decoded(() => {
    const o = raw as Record<string, unknown>;
    if (!o.result || typeof o.result !== 'object') throw new Error('missing result');
    const r = fromJson(WoodpileResultSchema, (o.result ?? null) as JsonValue, { ignoreUnknownFields: true }) as WoodpileResult;
    if (!r.woodpile) throw new Error('missing woodpile');
    return {
      ...parseSnapshot(raw),
      result: {
        home: r.home ? projectHome(r.home) : null,
        inventory: projectCounts(r.inventory),
        // A null storage means no shared chest ("not-a-member" and friends
        // say why); an empty one would read as an empty chest.
        storage: r.storage ? projectCounts(r.storage) : null,
        personal: projectCounts(r.personal),
        shared: r.shared,
        woodpile: woodpile(r.woodpile),
        action: r.action,
        collectedQty: r.collectedQty ?? undefined,
      },
    };
  });
}
