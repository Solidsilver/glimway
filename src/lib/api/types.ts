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

// ------------------------------------------------------------ phase 5

/** One kind of goods (a catalogue id, never a decoration instance). */
export interface Asset {
  kind: 'material' | 'item' | 'decoration';
  id: string;
  qty: number;
}

/** Counts by kind; a missing key means zero. Decorations include placed ones. */
export interface AssetCounts {
  materials: Record<string, number>;
  items: Record<string, number>;
  decorations: Record<string, number>;
}

/** GET /api/calendar (public; Unix seconds). */
export interface CalendarResponse {
  wick: string;
  wickNumber: number;
  year: number;
  day: number;
  mark: string;
  festival: string | null;
  startsAt: number;
  nextTurning: number;
  notice: string | null;
  wickDays: number;
}

export interface StorageResponse extends Snapshot {
  home: HomeView;
  inventory: AssetCounts;
  storage: AssetCounts;
}

export interface StorageMoveResponse extends Snapshot {
  result: { home: HomeView; inventory: AssetCounts; storage: AssetCounts };
}

export interface CraftResponse extends Snapshot {
  result: { home: HomeView; inventory: AssetCounts; storage: AssetCounts; recipeId: string; output: Asset; instanceIds: string[] };
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
