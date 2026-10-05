/**
 * Request/response shapes of the Fingersnap server, mirroring the backend
 * contract (.agent/BACKEND-REPORT.md, "API contract for the frontend").
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
  habiticaId: string;
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

export type SpendKind = 'rest' | 'revive' | 'home-rest' | 'road-lantern' | 'chest';

export interface LoginRequest {
  userId: string;
  token: string;
  invite?: string;
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

/** Invite metadata. `id` is the code's hash; timestamps are Unix seconds. */
export interface InviteInfo {
  id: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

/** Only creation returns the raw code, once. */
export interface CreatedInvite extends InviteInfo {
  /** Readable words plus digits, e.g. `amber-fox-river-lantern-moss-ivy-7392`. Shown once. */
  code: string;
}

export interface InviteList {
  /** Waiting codes plus used history (hash metadata only). */
  invites: InviteInfo[];
  /** Lifetime creations left (CLI codes don't count). Undefined from older servers. */
  remaining?: number;
  /** How many unused codes may wait at once. */
  outstandingLimit?: number;
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

export type WildsEntityKind = 'camp' | 'node' | 'chest' | 'poi';
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

/** A pixel rectangle on the Commons map. */
export interface PlotBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One member's homestead (GET /api/homestead/:id, and every homestead POST). */
export interface HomeView {
  ownerId: string;
  displayName: string;
  worldId: string;
  /** null while the member has no plot yet (a reserved, empty plot). */
  plotIndex: number | null;
  tier: number;
  bounds: PlotBounds | null;
  /** null below the Cottage (tier 1). */
  indoor: { width: number; height: number } | null;
  items: HomeInstance[];
}

export interface HomeResponse extends Snapshot {
  home: HomeView;
  materials: Record<string, number>;
}

/** A Commons roster row (every world member; plotless members last). */
export interface PlotInfo {
  ownerId: string;
  displayName: string;
  tier: number;
  plotIndex: number | null;
  bounds: PlotBounds | null;
}

export interface CommonsResponse extends Snapshot {
  plots: PlotInfo[];
}

export type HomeOp = 'buy' | 'place' | 'move' | 'remove' | 'upgrade';

/** The op-specific fields of a homestead POST (lease, rev, key and progress are added by the link). */
export type HomeAction =
  | { op: 'buy'; itemDef: string }
  | { op: 'place' | 'move'; itemId: string; scene: 'indoor' | 'outdoor'; x: number; y: number; rotation: number }
  | { op: 'remove'; itemId: string }
  | { op: 'upgrade'; tier: number };

export interface HomeActionRequest {
  lease: string;
  baseRev: number;
  key: string;
  progress?: Progress;
  itemDef?: string;
  itemId?: string;
  scene?: 'indoor' | 'outdoor';
  x?: number;
  y?: number;
  rotation?: number;
  tier?: number;
}

export interface HomeActionResponse extends Snapshot {
  result: { home: HomeView; materials: Record<string, number>; itemId?: string };
}
