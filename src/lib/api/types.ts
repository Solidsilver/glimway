/**
 * Request/response shapes of the Glimway server, mirroring the Go
 * handlers in server/internal/api and the snapshot in server/internal/store
 * (answers are checked by ./parse.ts).
 */
import type { AreaId, GameState, QuestStage } from '../state.ts';
import type { HabiticaProfile, VitalsSource } from '../habitica/types.ts';
import type { HomeInstance } from '../homestead.ts';
import type { PlayerState } from '../gen/glimway/v1/state_pb.js';

/** The client-writable progress document (`doc` / `progress`). */
export interface Progress {
  version: 1;
  area: AreaId;
  position: { x: number; y: number };
  quest: QuestStage;
  hp: number;
  mana: number;
  inventory: string[];
  discoveries: string[];
  defeatedEnemies: string[];
  flags: string[];
  playSeconds: number;
}

/** Fields every state-bearing response carries at the top level. */
export interface Snapshot {
  /** The answer's state projected for the game (src/lib/api/predict.ts `gameStateOf`). */
  state: GameState;
  /** The server's typed state, when the answer carried one (the link adopts it by version). */
  player?: PlayerState;
  rev: number;
  vitalsSource: VitalsSource;
  /** Omitted before origin selection. */
  importedProfile?: HabiticaProfile;
  accountId: string;
  /** The verified player's name, present even before the origin choice ('' from older servers). */
  displayName: string;
  habiticaPartyId: string | null;
  worldId: string;
  pending: number;
  verifiedXp: number;
  flagged: boolean;
}

export interface PlayResponse extends Snapshot {
  lease: string;
}

/** GET /api/state. */
export interface StateResponse extends Snapshot {
  /**
   * Whether the `X-Play-Lease` sent is the player's current lease. False for
   * a superseded tab (or no header). Undefined from servers before round 3.
   */
  leaseActive?: boolean;
}

export interface ProgressResponse extends Snapshot {
  status: 'current' | 'stale';
}

export interface SyncResponse extends Snapshot {
  status: 'synced' | 'unchanged';
  /** Signed vitals change from the sync, relative to the carried progress. */
  vitalsCredit: { hp: number; mana: number };
}

export interface SpendResponse extends Snapshot {
  /** `lit:road-1`, `opened:ashwatch-chest`, or '' for rest/revive. */
  outcome: string;
}

type SpendKind = 'rest' | 'revive' | 'home-rest' | 'road-lantern' | 'chest';

export interface LoginRequest {
  userId: string;
  token: string;
  invite?: string;
  /** The Habitica party the client read (lets a party member in without a code; the server checks it). */
  party?: string;
}

export interface ProgressRequest {
  lease: string;
  baseRev: number;
  doc: Progress;
}

export interface SyncRequest {
  lease: string;
  baseRev: number;
  progress: Progress;
  profile: HabiticaProfile;
}

export interface SpendRequest {
  lease: string;
  baseRev: number;
  kind: SpendKind;
  target?: string;
  progress?: Progress;
  key: string;
}

export type { InviteInfo, CreatedInvite, InviteList } from './invites.ts';

// ------------------------------------------------------------- worlds

// The world views and moves (world.proto, decoded in world.ts).
export type { WorldRef, WorldChoice, WorldLeaver, WorldLeaving, WorldView, WorldMoveResponse } from './world.ts';

// ------------------------------------------------------------- the Wilds

/** The frozen epoch a region is generated from (server: `region_epochs`). */
export interface WildsEpoch {
  worldSeed: string;
  regionId: string;
  generatorVersion: number;
  season: string;
  /** Opaque epoch id, sent as `epoch` on every Wilds mutation. */
  id: string;
  startsAt: number;
  endsAt: number | null;
}

type WildsEntityKind = 'camp' | 'node' | 'chest' | 'poi';
export type WildsEntityState = 'available' | 'cleared' | 'harvested' | 'charted';

/**
 * One generated entity plus its shared state. `tx`/`ty` are chunk-local
 * tiles; the chunk is encoded in the id (`<kind>:<cx>:<cy>:<index>`).
 * Timestamps are Unix seconds; `available_at` 0 means available now.
 */
export interface WildsEntityView {
  id: string;
  kind: WildsEntityKind;
  tx: number;
  ty: number;
  enemies: string[];
  material: string;
  tier: number;
  poi: string;
  cycle: number;
  state: WildsEntityState;
  available_at: number;
  by: string | null;
  at: number | null;
}

export interface WildsLoot {
  materials: { id: string; qty: number }[];
  trinket: string | null;
}

/** A fallen hero's lantern, at region-wide tile coordinates. */
export interface WildsLanternView {
  id: string;
  ownerId: string;
  displayName: string;
  x: number;
  y: number;
  litBy: string | null;
  at: number;
  litAt: number | null;
}

export interface WildsMaterials {
  timber: number;
  stone: number;
  fiber: number;
  amber: number;
}

/** GET /api/wilds/region/:id — everything the client renders from. */
export interface WildsRegionResponse extends Snapshot {
  epoch: WildsEpoch;
  entities: WildsEntityView[];
  personalClaims: { entityId: string; at: number }[];
  discoveries: { entityId: string; poiId: string; discovererId: string; displayName: string; at: number }[];
  lanterns: WildsLanternView[];
  materials: WildsMaterials;
}

export interface WildsClaimRequest {
  lease: string;
  baseRev: number;
  epoch: string;
  entityId: string;
  cycle: number;
  key: string;
  progress?: Progress;
}

export interface WildsClaimResult {
  epoch: string;
  entity: WildsEntityView;
  loot: WildsLoot;
  materials: WildsMaterials;
  wardenSliverFound?: boolean;
  stormDropFound?: boolean;
}

export interface WildsClaimResponse extends Snapshot {
  result: WildsClaimResult;
}

export interface WildsDefeatRequest {
  lease: string;
  baseRev: number;
  epoch: string;
  /** Region-wide tile coordinates ([0,72) for inner-1). */
  x: number;
  y: number;
  key: string;
  progress?: Progress;
}

export interface WildsDefeatResult {
  epoch: string;
  lanternId: string;
  lanterns: WildsLanternView[];
}

export interface WildsDefeatResponse extends Snapshot {
  result: WildsDefeatResult;
}

export interface WildsLanternRequest {
  lease: string;
  baseRev: number;
  epoch: string;
  ownerId: string;
  lanternId: string;
  key: string;
  progress?: Progress;
}

export interface WildsLanternResult {
  epoch: string;
  rewarded: boolean;
  loot: WildsLoot;
  materials: WildsMaterials;
  lanterns: WildsLanternView[];
}

export interface WildsLanternResponse extends Snapshot {
  result: WildsLanternResult;
}

// ------------------------------------------------------------ homesteads

/** A homestead member (everyone on a deed is equal). */
interface HomeMember {
  id: string;
  displayName: string;
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
  stumps?: [number, number][];
  plants?: HomePlantView[];
}

export interface HomePlantView {
  id: string;
  itemDef: string;
  x: number;
  y: number;
  plantedAt?: number;
  plantedDay?: number;
  lit?: boolean;
}

export interface HomeResponse extends Snapshot {
  gate: number;
  landSeed: number;
  home: HomeView | null;
  materials: Record<string, number>;
}

// The Commons read (village.proto, decoded in village.ts).
export type { GateInfo, DeedInvite, CommonsResponse } from './village.ts';

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

// ------------------------------------------------------------ phase 5

/**
 * Goods on the move. Stacks and home goods by catalogue id and count; an
 * `instance` (a tool, off-hand item, carry gear or fitting) one at a time by
 * its id. `maker` picks one maker's stack ('' = unmarked); absent takes any.
 */
export interface Asset {
  kind: 'material' | 'item' | 'decoration' | 'instance' | 'thanks';
  id: string;
  qty: number;
  instance?: string;
  maker?: string;
}

/** Counts by kind; a missing key means zero. Carried decorations are the pack's (placed ones belong to the homestead). */
export interface AssetCounts {
  materials: Record<string, number>;
  items: Record<string, number>;
  decorations: Record<string, number>;
  /** Tools, off-hand items, carry gear and loose fittings, one by one (absent from older servers). */
  instances?: InstanceView[];
}

// ------------------------------------------------------------ items (docs/items/)

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
    given?: Asset;
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
    /** What a seller just handed over (/api/items/buy). */
    bought?: { seller: string; itemDef: string; qty: number; embers: number };
  };
}

export type { CalendarResponse } from './calendar.ts';

/**
 * The workshop: your pack, your own chest (always reachable: it goes with
 * you), and, with a Workshop home, that home and its shared chest. Without
 * one, home and storage are null and `shared` says why.
 */
export interface WorkshopView {
  home: HomeView | null;
  inventory: AssetCounts;
  storage: AssetCounts | null;
  personal: AssetCounts;
  shared: 'open' | 'not-a-member' | 'tier-required' | string;
}

// Storage and crafting answers (village.proto, decoded in village.ts).
export type { ChestId, StorageResponse, StorageMoveResponse, CraftResponse, HearthCraftResponse, DeskCopyResponse } from './village.ts';

/** One stack of green timber on a placed woodpile (seasons after a real day). */
interface WoodpileStack {
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
  result: WorkshopView & { woodpile: WoodpileView; action: 'stack' | 'collect' | string; collectedQty?: number };
}

// Mail, projects and repairs answers (village.proto, decoded in village.ts).
export type {
  Mail, MailResponse, MailActionResponse,
  ProjectView, ProjectsView, ProjectsResponse, ContributeResponse,
  ChoreView, MendedView, ChoreHistoryView, RepairsView, RepairsResponse, MendResult, MendResponse,
} from './village.ts';

// ------------------------------------------------------------ gate shelf

export interface ShelfSlotView {
  slot: number;
  kind: 'material' | 'item' | 'decoration' | 'instance';
  itemDef: string;
  qty: number;
  maker?: MakerView | null;
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
  inventory: AssetCounts;
  taken?: Asset;
  line?: string;
}

// The v3 facade uses generated contracts directly. The GameState interfaces
// above remain only for the intermediate domain/Link compilation bridge.
export type { PlayerState, Envelope as OperationEnvelope, SessionResponse as SessionReply, PlayResponse as PlayReply, StateResponse as StateReply, Refusal as OperationRefusal } from '../gen/glimway/v1/state_pb.js';
export type { OpHeader, Where, ReportBarrier, Vitals, Place } from '../gen/glimway/v1/op_pb.js';
export type { ReportRequest, ReportResult, ItemQty, QuestStepRequest, QuestStepResult, MarkRequest, MarkResult, TakePaperRequest, TakePaperResult, SettleEchoRequest, SettleEchoResult, FallRequest, FallResult, ProfileReport, ProfileResult } from '../gen/glimway/v1/operations_pb.js';
export type { WildsChunk, WildsRegionResult, HomesteadLand, EchoAssignment } from '../gen/glimway/v1/wilds_pb.js';
