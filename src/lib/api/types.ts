/**
 * Request/response shapes of the Glimway server, mirroring the Go
 * handlers in server/internal/api and the snapshot in server/internal/store
 * (answers are checked by ./parse.ts).
 */
import type { AreaId, GameState, QuestStage } from '../state.ts';
import type { HabiticaProfile, VitalsSource } from '../habitica/types.ts';
import type { HomeInstance } from '../homestead.ts';

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

export type SaveOrigin = 'fresh' | 'migrated';

/** Fields every state-bearing response carries at the top level. */
export interface Snapshot {
  /** The complete merged GameState: replaces the local connected copy. */
  state: GameState;
  rev: number;
  vitalsSource: VitalsSource;
  /** Omitted before origin selection. */
  importedProfile?: HabiticaProfile;
  accountId: string;
  /** The verified player's name, present even before the origin choice ('' from older servers). */
  displayName: string;
  habiticaPartyId: string | null;
  worldId: string;
  /** null until the player picks how to start. */
  saveOrigin: SaveOrigin | null;
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

export interface OriginRequest {
  choice: 'fresh' | 'migrate';
  key: string;
  save?: { state: GameState; vitalsSource?: VitalsSource };
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

/** A world as the server names it: its owner (none for a party's) and how many live there. */
export interface WorldRef {
  id: string;
  /** Empty for a party's world. */
  ownerId: string;
  ownerName: string;
  members: number;
  /** The owner lives there. */
  ownerHere: boolean;
  /** A party's world, owned by no one. */
  party: boolean;
}

/**
 * A first sign-in held for the world choice (POST /api/session, GET
 * /api/world/choice): the account is signed in, but has no world until
 * POST /api/world/choose. Everything else answers `world-choice-required`.
 */
export interface WorldChoice {
  habiticaId: string;
  displayName: string;
  /** The party's world here, and how many live there. */
  partyWorld: WorldRef | null;
  /** The party has no world here yet: choosing it opens one. */
  partyCanOpen: boolean;
  /** Let in through the party: they make no invite codes, even from a world of their own. */
  partyAdmitted: boolean;
}

/** What a move would leave behind (GET /api/world). */
interface WorldLeaving {
  /** Your homestead's gate (-1: none). */
  gate: number;
  /** You are its only member: it goes quiet after you leave. */
  last: boolean;
  /** Parcels you sent that are still on the road (recall them first). */
  outgoing: number;
  /** Parcels waiting for you (they go back to their senders). */
  incoming: number;
  /** Warden-set tools in your homestead's shared chest (they stay behind). */
  wardenTools: number;
  /** Embers a deed costs in the next world (0: your first, free). */
  deedCost: number;
}

/** GET /api/world: your world, your party's world, and when you may next move. */
export interface WorldView {
  world: WorldRef;
  isOwner: boolean;
  /** Your last sign-in reported a party. */
  inParty: boolean;
  /** You live in your party's world. */
  partyHome: boolean;
  /** Your party's world, when you live somewhere else. */
  partyWorld: WorldRef | null;
  /** Your party has no world here yet and you may open it. */
  partyCanOpen: boolean;
  /** A world you own, when you live somewhere else. */
  ownWorld: WorldRef | null;
  /** The party world's join prompt hasn't been shown yet. */
  prompt: boolean;
  leaving: WorldLeaving;
  /** When the next move is allowed (unix seconds, the server's clock; 0: now). One move a day. */
  moveOpensAt: number;
  /** Seconds until then, by the server's clock: count down from this on the device's own. */
  moveOpensIn: number;
  /** You live in a party's world and have left that party. */
  leaver: WorldLeaver | null;
  /** When the server moved you out of a party's world you'd left (0: it didn't), until noticed. */
  movedOutAt: number;
}

/** Living in a party's world after leaving the party (GET /api/world). */
export interface WorldLeaver {
  leftAt: number;
  /** When the next sign-in moves you out (server clock); moveOutIn: seconds until then. */
  moveOutAt: number;
  moveOutIn: number;
  /** You own a world to go to (otherwise one is made for you). */
  hasOwn: boolean;
}

/** POST /api/world/move (keyed). */
export interface WorldMoveResponse extends Snapshot {
  result: { world: WorldView; from: string; leftHome: boolean; returned: number };
}

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

/** One gate on the Commons lane. */
export interface GateInfo {
  gate: number;
  homeId: string | null;
  names: string[];
  members: HomeMember[];
  tier: number;
  desolate: boolean;
  mine: boolean;
  /** Unclaimed: what the deed costs the caller in embers. */
  price: number | null;
  /** The caller was on this empty home's deed and can take it back, free, until the deed is lost. */
  reclaim: boolean;
  shelf?: boolean;
  shelfStocked?: boolean;
}

/** A joint-deed invitation the caller is part of. */
export interface DeedInvite {
  homeId: string;
  gate: number;
  from: { id: string; name: string };
  to: { id: string; name: string };
  expiresAt: number;
  fromConfirmedAt: number | null;
  toConfirmedAt: number | null;
}

export interface CommonsResponse extends Snapshot {
  gates: GateInfo[];
  gateCount: number;
  mine: { homeId: string; gate: number } | null;
  invites: DeedInvite[];
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
  lease: string;
  baseRev: number;
  key: string;
  progress?: Progress;
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

/** Which chest at home: the shared one, or the caller's own small one. */
export type ChestId = 'shared' | 'personal';

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

export interface StorageResponse extends Snapshot, WorkshopView {}

export interface StorageMoveResponse extends Snapshot {
  result: WorkshopView;
}

export interface CraftResponse extends Snapshot {
  result: WorkshopView & { recipeId: string; output: Asset; instanceIds: string[] };
}

/** Made at the cottage hearth (food, remedies, oils): the workshop view plus what the batch made. */
export interface HearthCraftResponse extends Snapshot {
  result: WorkshopView & { recipeId: string; output: Asset };
}

/** A recipe page copied at the writing desk: the workshop view plus the copies. */
export interface DeskCopyResponse extends Snapshot {
  result: WorkshopView & { pageId: string; qty: number };
}

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

export interface Mail {
  id: string;
  worldId: string;
  fromId: string;
  toId: string;
  fromName: string;
  toName: string;
  asset: Asset;
  sentAt: number;
  claimedAt: number | null;
  /** Set when it went back to the sender (recall, 30-day return, recipient removed). */
  returnedAt?: number | null;
  returnReason?: 'recalled' | 'expired' | 'recipient-removed' | null;
}

export interface MailResponse extends Snapshot {
  mail: Mail[];
  /** History continues at `?cursor=` (opaque); pending mail repeats on every page. */
  nextCursor?: string | null;
  /** Only for legacy pending backlogs past the current caps: `?pendingCursor=`. */
  nextPendingCursor?: string | null;
  /** Carried counts (this client's server addition); absent from older servers. */
  inventory?: AssetCounts;
}

export interface MailActionResponse extends Snapshot {
  result: { mailId: string; mail: Mail[]; inventory: AssetCounts; asset?: Asset };
}

export interface ProjectView {
  id: string;
  name: string;
  stage: 'open' | 'in-progress' | 'complete';
  required: Record<string, number>;
  contributed: Record<string, number>;
  /** The caller's own share (this client's server addition). */
  mine: Record<string, number>;
  completedAt: number | null;
  worldFlag: string | null;
  grantablePapers: string[];
}

export interface ProjectsView {
  projects: ProjectView[];
  worldFlags: string[];
  grantablePapers: string[];
}

export interface ProjectsResponse extends Snapshot, ProjectsView {}

export interface ContributeResponse extends Snapshot {
  result: ProjectsView & { projectId: string; materials: Record<string, number> };
}

export interface ChoreView {
  id: string;
  name: string;
  part: string;
  area: string;
  target: string;
  pos: { tx: number; ty: number };
  resident: string;
  hint: string;
  description: string;
}

export interface MendedView {
  repairId: string;
  mendedBy: string;
  displayName: string;
  mendedAt: number;
}

export interface ChoreHistoryView {
  id: string;
  repairId: string;
  repairName: string;
  mendedBy: string;
  displayName: string;
  mendedAt: number;
}

export interface RepairsView {
  open: ChoreView[];
  mended: MendedView[];
  worldFlags: string[];
  history: ChoreHistoryView[];
}

export interface RepairsResponse extends Snapshot, RepairsView {}

export interface MendResult {
  repairs: RepairsView;
  mended: string;
  reaction: string;
  gift?: { kind: string; id: string; qty: number };
  items: ItemsView;
}

export interface MendResponse extends Snapshot {
  result: MendResult;
}

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
  lease: string;
  baseRev: number;
  key: string;
  progress?: Progress;
  op: 'stock' | 'take';
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
export type { ReportRequest, ReportResult, QuestStepRequest, QuestStepResult, MarkRequest, MarkResult, TakePaperRequest, TakePaperResult, SettleEchoRequest, SettleEchoResult, FallRequest, FallResult, ProfileReport, ProfileResult } from '../gen/glimway/v1/operations_pb.js';
export type { WildsChunk, WildsRegionResult, HomesteadLand, EchoAssignment } from '../gen/glimway/v1/wilds_pb.js';
