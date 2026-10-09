/**
 * Request/response shapes of the Glimway server, mirroring the Go
 * handlers in server/internal/api and the snapshot in server/internal/store
 * (answers are checked by ./parse.ts).
 */
import type { AreaId, GameState, QuestStage } from '../state.ts';
import type { HabiticaProfile, VitalsSource } from '../habitica/types.ts';
import type { PlayerState } from '../gen/glimway/v1/state_pb.js';

// The homestead, gate-shelf, woodpile and item route types moved to the
// generated schema's modules (homestead.ts, items.ts).
export type {
  HomeMember, HomeView, HomePlantView, HomeResponse, HomeOp, HomeAction, HomeActionRequest, HomeActionResponse,
  ShelfSlotView, ShelfView, ShelfRequest, ShelfResponse, ShelfActionResponse,
  WoodpileStack, WoodpileView, WoodpileResponse, WoodpileActionResponse,
} from './homestead.ts';
export type {
  MakerView, FittingView, InstanceView, StackView, SlotView, ThanksView, ItemsView, ItemsResponse, ItemsOp, ItemsActionResponse,
} from './items.ts';
// The projections above are this module's vocabulary too (the workshop,
// repairs and mail answers embed them).
import type { HomeMember, HomeView } from './homestead.ts';
import type { InstanceView, ItemsView } from './items.ts';

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
// The item-model types (MakerView, InstanceView, ItemsView, ItemsResponse,
// ItemsOp, ItemsActionResponse…) moved to items.ts with their parsers.

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

// The gate-shelf and woodpile types moved to homestead.ts with their parsers.

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

// The v3 facade uses generated contracts directly. The GameState interfaces
// above remain only for the intermediate domain/Link compilation bridge.
export type { PlayerState, Envelope as OperationEnvelope, SessionResponse as SessionReply, PlayResponse as PlayReply, StateResponse as StateReply, Refusal as OperationRefusal } from '../gen/glimway/v1/state_pb.js';
export type { OpHeader, Where, ReportBarrier, Vitals, Place } from '../gen/glimway/v1/op_pb.js';
export type { ReportRequest, ReportResult, ItemQty, QuestStepRequest, QuestStepResult, MarkRequest, MarkResult, TakePaperRequest, TakePaperResult, SettleEchoRequest, SettleEchoResult, FallRequest, FallResult, ProfileReport, ProfileResult } from '../gen/glimway/v1/operations_pb.js';
export type { WildsChunk, WildsRegionResult, HomesteadLand, EchoAssignment } from '../gen/glimway/v1/wilds_pb.js';
