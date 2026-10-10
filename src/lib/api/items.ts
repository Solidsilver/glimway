/**
 * The item routes (proto/glimway/v1/items.proto): what the caller carries
 * (GET /api/items) and every keyed item mutation. Responses decode through
 * the generated protobuf-es types (decodeWire) and project onto the game's
 * shapes (absent optionals become null); ProtoJSON's extra spellings are
 * refused (ApiError `bad-response`), as parse.ts did by hand.
 */
import { decodeWire } from './wire.ts';
import {
  type AssetCounts as GeneratedAssetCounts, type Instance as GeneratedInstance,
  type ItemsView as GeneratedItemsView,
} from '../gen/glimway/v1/goods_pb.js';
import {
  ItemsReadSchema, ItemsResultSchema,
  type ItemsRead, type ItemsResult,
  type WearResult as GeneratedWearResult,
} from '../gen/glimway/v1/items_pb.js';
import { ApiError } from './errors.ts';
import { parseSnapshot } from './parse.ts';
import type { AssetCounts, AssetView, Snapshot } from './types.ts';
import type { HomePlantView } from './homestead.ts';

export interface MakerView {
  id: string;
  name: string;
}
export interface FittingView {
  id: string;
  itemDef: string;
  fitting: string;
  condition: number;
  maxCondition: number;
  usesLeft: number;
  maker: MakerView | null;
}
type WearStateName = 'whole' | 'worn' | 'blunt' | 'cracked' | 'dull';
/** One instance: condition in wear points (maxCondition 0: never wears). */
export interface InstanceView {
  id: string;
  itemDef: string;
  condition: number;
  maxCondition: number;
  usesLeft: number;
  state: WearStateName;
  wardenSet: boolean;
  fittings: FittingView[];
  maker: MakerView | null;
  dullness?: number;
  speed?: number;
}
export interface StackView {
  itemDef: string;
  qty: number;
  maker: MakerView | null;
}
export interface SlotView {
  slot: string;
  itemDef: string | null;
  instance: string | null;
}
interface OffHandView {
  open: boolean;
  class: string | null;
  itemDef: string | null;
  instance: string | null;
}
export interface ThanksView {
  fromName: string;
  itemDef: string;
  at: number;
}
/** What the caller carries, in the item model (GET /api/items and every item mutation). */
export interface ItemsView {
  stacks: StackView[];
  instances: InstanceView[];
  /** One per open pocket (one, or two with carry gear). */
  pockets: SlotView[];
  offHand: OffHandView;
  /** World pickups this player has already taken. */
  pickedUp: string[];
  /** Recent thank-yous for things you made. */
  thanks: ThanksView[];
}
export interface ItemsResponse extends Snapshot {
  items: ItemsView;
}
interface WearResult {
  broke: boolean;
  woreOut: boolean;
  state: string;
  wornOut: string[];
  returned: string[];
  itemDef: string;
  usesLeft: number;
  condition: number;
  instance: InstanceView | null;
}
export type ItemsOp = 'use' | 'repair' | 'fit' | 'unfit' | 'give' | 'pocket' | 'offhand' | 'pickup' | 'return' | 'gather' | 'plant' | 'heirloom' | 'ada-oil' | 'buy';
export interface ItemsActionResponse extends Snapshot {
  result: {
    items: ItemsView;
    wear?: WearResult;
    used?: string;
    pickup?: string;
    given?: AssetView;
    mended?: string;
    created?: string[];
    returned?: string;
    paper?: string;
    gathered?: { itemDef: string; qty: number }[];
    plant?: HomePlantView;
    /** A gather that changed home land inside lamplight (a stump stays, open ground stays open). */
    land?: { tile: [number, number]; stump: boolean; cleared: boolean };
    heirloom?: string;
    adaOilCount?: number;
    /** give: the glims handed over (3.4), when any did. */
    glimsGiven?: number;
    /** What a seller just handed over (/api/items/buy), and what it cost in glims. */
    bought?: { seller: string; itemDef: string; qty: number; glims: number };
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

const WEAR_STATES = ['whole', 'worn', 'blunt', 'cracked', 'dull'];
// The request vocabulary (a request Asset can't be glims); reads widen it —
// projectAsset's kind check is the read side's.
const ASSET_KINDS = ['material', 'item', 'decoration', 'instance', 'thanks'];
const READ_ASSET_KINDS = [...ASSET_KINDS, 'glims'];

/** The maker's mark, projected. */
function maker(v: { id: string; name: string } | undefined): MakerView | null {
  if (!v) return null;
  return { id: v.id, name: v.name.slice(0, 64) };
}

/** One instance, projected and checked (state in the vocabulary, wear in range). */
export function projectInstance(v: GeneratedInstance): InstanceView {
  const state = v.state as WearStateName;
  if (!WEAR_STATES.includes(state)) throw new Error('invalid wear state');
  const condition = int(v.condition);
  const maxCondition = int(v.maxCondition);
  if (condition > maxCondition) throw new Error('condition over max');
  return {
    id: v.id,
    itemDef: v.itemDef,
    condition,
    maxCondition,
    usesLeft: int(v.usesLeft),
    state,
    wardenSet: v.wardenSet,
    maker: maker(v.maker ?? undefined),
    fittings: v.fittings.map((f): FittingView => ({
      id: f.id,
      itemDef: f.itemDef,
      fitting: f.fitting,
      condition: int(f.condition),
      maxCondition: int(f.maxCondition),
      usesLeft: int(f.usesLeft),
      maker: maker(f.maker ?? undefined),
    })),
    ...(v.dullness !== undefined ? { dullness: v.dullness } : {}),
    ...(v.speed !== undefined ? { speed: v.speed } : {}),
  };
}

/** Carried counts, projected (a missing key stays missing). */
export function projectCounts(v: GeneratedAssetCounts | undefined): AssetCounts {
  const out: AssetCounts = { materials: countMap(v?.materials), items: countMap(v?.items), decorations: countMap(v?.decorations) };
  if (v?.instances?.length) out.instances = v.instances.map(projectInstance);
  return out;
}

export function projectItemsView(v: GeneratedItemsView): ItemsView {
  if (!v.offHand) throw new Error('missing off hand');
  return {
    stacks: v.stacks.map((s): StackView => ({ itemDef: s.itemDef, qty: int(s.qty, 1), maker: maker(s.maker ?? undefined) })),
    instances: v.instances.map(projectInstance),
    pockets: v.pockets.map((p): SlotView => ({ slot: p.slot, itemDef: p.itemDef ?? null, instance: p.instance ?? null })),
    offHand: { open: v.offHand.open, class: v.offHand.class ?? null, itemDef: v.offHand.itemDef ?? null, instance: v.offHand.instance ?? null },
    pickedUp: v.pickedUp.filter((p): p is string => typeof p === 'string'),
    thanks: v.thanks.map((t): ThanksView => ({ fromName: t.fromName.slice(0, 64), itemDef: t.itemDef, at: num(t.at) })),
  };
}

function wear(v: GeneratedWearResult | undefined): WearResult | undefined {
  if (!v) return undefined;
  return {
    broke: v.broke,
    woreOut: v.woreOut,
    state: v.state,
    wornOut: v.wornOut,
    returned: v.returned,
    itemDef: v.itemDef,
    usesLeft: int(v.usesLeft),
    condition: int(v.condition),
    instance: v.instance ? projectInstance(v.instance) : null,
  };
}

/** Goods on the move, projected (kind in the vocabulary, empty optionals gone). Reads only: a gold letter shows as kind "gold" (display only), while a request Asset still can't carry it. */
export function projectAsset(v: { kind: string; id: string; qty: number; instance: string; maker?: string } | undefined): AssetView | undefined {
  if (!v) return undefined;
  if (!READ_ASSET_KINDS.includes(v.kind)) throw new Error('invalid asset kind');
  const out: AssetView = { kind: v.kind as AssetView['kind'], id: v.id, qty: int(v.qty, 0) };
  if (v.instance) out.instance = v.instance;
  if (v.maker) out.maker = v.maker;
  return out;
}

function result(r: ItemsResult): ItemsActionResponse['result'] {
  if (!r.items) throw new Error('missing items');
  const out: ItemsActionResponse['result'] = { items: projectItemsView(r.items) };
  if (r.wear) out.wear = wear(r.wear);
  if (r.used) out.used = r.used;
  if (r.pickup) out.pickup = r.pickup;
  if (r.mended) out.mended = r.mended;
  if (r.returned) out.returned = r.returned;
  if (r.paper) out.paper = r.paper;
  const given = projectAsset(r.given);
  if (given) out.given = given;
  if (r.created?.length) out.created = r.created.filter((c): c is string => typeof c === 'string');
  if (r.heirloom) out.heirloom = r.heirloom;
  if (r.adaOilCount) out.adaOilCount = int(r.adaOilCount);
  if (r.glimsGiven) out.glimsGiven = int(r.glimsGiven);
  if (r.bought) out.bought = { seller: r.bought.seller, itemDef: r.bought.itemDef, qty: int(r.bought.qty), glims: int(r.bought.glims) };
  if (r.gathered?.length) out.gathered = r.gathered.map((g) => ({ itemDef: g.itemDef, qty: int(g.qty) }));
  if (r.plant) {
    out.plant = {
      id: r.plant.id,
      itemDef: r.plant.itemDef,
      x: int(r.plant.x),
      y: int(r.plant.y),
      plantedAt: r.plant.plantedAt ?? undefined,
      plantedDay: r.plant.plantedDay ?? undefined,
      lit: r.plant.lit,
    };
  }
  if (r.land) {
    const tile = r.land.tile;
    out.land = {
      tile: tile.length === 2 ? [int(tile[0]), int(tile[1])] : [0, 0],
      stump: r.land.stump,
      cleared: r.land.cleared,
    };
  }
  return out;
}

/** GET /api/items — what the caller carries. */
export function parseItems(raw: unknown): ItemsResponse {
  return decoded(() => {
    const o = raw as Record<string, unknown>;
    const read = decodeWire(ItemsReadSchema, (o.result !== undefined ? o.result : o)) as ItemsRead;
    if (!read.items) throw new Error('missing items');
    return { ...parseSnapshot(raw), items: projectItemsView(read.items) };
  });
}

/** A keyed item mutation (use, repair, fit, unfit, give, pocket, …, buy). */
export function parseItemsAction(raw: unknown): ItemsActionResponse {
  return decoded(() => {
    const o = raw as Record<string, unknown>;
    if (!o.result || typeof o.result !== 'object') throw new Error('missing result');
    const r = decodeWire(ItemsResultSchema, (o.result ?? null)) as ItemsResult;
    return { ...parseSnapshot(raw), result: result(r) };
  });
}

/** Shared domain parser for the server-first mixed envelope. */
export function parseItemsResult(raw: unknown): ItemsActionResponse['result'] {
  return decoded(() => result(decodeWire(ItemsResultSchema, raw) as ItemsResult));
}
