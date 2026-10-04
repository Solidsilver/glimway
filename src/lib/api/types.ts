/**
 * Request/response shapes of the Fingersnap server, mirroring the backend
 * contract (.agent/BACKEND-REPORT.md, "API contract for the frontend").
 */
import type { AreaId, GameState, QuestStage } from '../state.ts';
import type { HabiticaProfile, VitalsSource } from '../habitica/types.ts';

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

export type SpendKind = 'rest' | 'revive' | 'road-lantern' | 'chest';

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
  code: string;
}
