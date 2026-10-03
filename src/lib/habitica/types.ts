/**
 * Habitica import contract types — PUBLISHED FIRST.
 *
 * `snap_runtime` mirrors this file when wiring the CharacterPanel import UI.
 * Nothing here ever holds credentials at rest: `HabiticaCredentials` is an
 * in-memory-only transport for the read-only client and is structurally
 * excluded from every persisted/exported shape (`HabiticaProfile`,
 * `SaveDocumentV2`, `LoadedSave`).
 *
 * See docs/import-contract.md for the module API and rules.
 */
import type { GameState } from '../state.ts';

/** Habitica playable classes (user.stats.class). */
export type HabiticaClass = 'warrior' | 'mage' | 'rogue' | 'healer';

/** Effective stats, statsComputed formula — see docs/habitica-foundations.md. */
export interface EffectiveStats {
  str: number;
  int: number;
  con: number;
  per: number;
}

/**
 * API credentials, held in memory only for the lifetime of a sync session.
 * NEVER serialize: not into GameState, saves, exports, logs, URLs, or source.
 */
export interface HabiticaCredentials {
  userId: string;
  apiToken: string;
  /** X-Client value in 'UserID-appname' form (API usage guidelines). */
  clientTag: string;
}

export interface HabiticaAppearance {
  size: string;
  shirt: string;
  skin: string;
  hairColor: string;
  /** preferences.hair.base — the base hair style. */
  hairStyle: number;
  background: string;
  /** preferences.hair.bangs — optional hair slot (avatar layering). */
  hairBangs?: number;
  /** preferences.hair.mustache — optional hair slot (avatar layering). */
  hairMustache?: number;
  /** preferences.hair.beard — optional hair slot (avatar layering). */
  hairBeard?: number;
  /** preferences.hair.flower — optional hair slot; 0 = none (avatar layering). */
  hairFlower?: number;
}

/**
 * Sanitized character snapshot. Free of credentials and of any field the
 * runtime does not need. Stats are EFFECTIVE stats (base + buff + gear +
 * class-match gear + level bonus) with no double-counting.
 */
export interface HabiticaProfile {
  id: string;
  name: string;
  /** null when the account has not selected a class (flags.classSelected false). */
  class: HabiticaClass | null;
  level: number;
  /**
   * stats.exp — XP toward the next level. With `level` it gives the account's
   * lifetime XP, which is what Embers are credited from (src/lib/embers.ts).
   * Optional: profiles saved before Embers existed lack it.
   */
  exp?: number;
  hp: number;
  maxHp: number;
  mp: number;
  /** Derived: 2 * effective INT + 30 (statsComputed). */
  maxMp: number;
  stats: EffectiveStats;
  /** Equipped gear keys by slot (items.gear.equipped) — the ONLY stat source. */
  equipped: Record<string, string | null>;
  /** Owned pet keys. */
  pets: string[];
  /** Owned mount keys. */
  mounts: string[];
  appearance: HabiticaAppearance;
  /**
   * Costume gear keys by slot (items.gear.costume). Visual only — costume
   * never contributes to effective stats.
   */
  costume?: Record<string, string | null>;
  /** Whether the account shows costume visuals (preferences.costume). */
  useCostume?: boolean;
  /** items.currentPet — the selected companion, not merely an owned pet. */
  selectedPet?: string | null;
  /** items.currentMount — the selected mount, not merely an owned mount. */
  selectedMount?: string | null;
}

/**
 * Read-only Habitica surface. There are deliberately NO write methods:
 * Fingersnap never scores tasks, spends gold, changes stats, or touches
 * inventory (plan boundary).
 */
export interface HabiticaClient {
  fetchProfile(): Promise<HabiticaProfile>;
}

/**
 * Per-item stat contribution used by the effective-stat formula. Values come
 * from a gear-stat lookup (fixtures now; a content snapshot later) — the
 * /user payload itself carries only equipped item KEYS.
 */
export interface GearItemStats {
  str?: number;
  int?: number;
  con?: number;
  per?: number;
  klass?: string;
  specialClass?: string;
}

export type GearStatsLookup = (itemKey: string) => GearItemStats | undefined;

/** Where current vitals came from. Governs defeat recovery and sync rules. */
export type VitalsSource = 'demo' | 'imported';

/** Optional save metadata carried alongside GameState (save format 2). */
export interface SaveExtras {
  vitalsSource: VitalsSource;
  importedProfile?: HabiticaProfile;
}

/**
 * Portable save document, format 2. `version` is the GameState schema
 * version (still 1); `saveFormat` versions the wrapper. Format 1 documents
 * (no saveFormat) load as vitalsSource 'demo' with no imported profile.
 */
export interface SaveDocumentV2 {
  kind: 'fingersnap-save';
  version: 1;
  saveFormat: 2;
  exportedAt: string;
  state: GameState;
  vitalsSource: VitalsSource;
  importedProfile?: HabiticaProfile;
}

export interface SaveGameOptions {
  /**
   * Set true only after the player has explicitly chosen to discard a corrupt
   * save. Default false: a corrupt stored save is never overwritten silently.
   */
  overwriteCorrupt?: boolean;
  /** Overrides stored provenance; when omitted, existing provenance is kept. */
  vitalsSource?: VitalsSource;
  /**
   * `undefined` preserves the stored imported profile (baseline).
   * `null` explicitly clears it — used by demo rollback and any reset that
   * leaves imported provenance. A profile object replaces the baseline.
   */
  importedProfile?: HabiticaProfile | null;
}

/** Full loaded save: state plus provenance metadata. */
export interface LoadedSave {
  state: GameState;
  vitalsSource: VitalsSource;
  importedProfile?: HabiticaProfile;
}

/** Loose view of the GET /api/v3/user `data` payload used by fixtures/mapping. */
export interface HabiticaUserJson {
  _id?: string;
  id?: string;
  stats?: {
    hp?: number;
    maxHealth?: number;
    mp?: number;
    maxMP?: number;
    lvl?: number;
    class?: string;
    str?: number;
    int?: number;
    con?: number;
    per?: number;
    buffs?: Record<string, unknown>;
    [k: string]: unknown;
  };
  items?: {
    gear?: {
      equipped?: Record<string, unknown>;
      costume?: Record<string, unknown>;
      [k: string]: unknown;
    };
    pets?: Record<string, unknown>;
    mounts?: Record<string, unknown>;
    currentPet?: unknown;
    currentMount?: unknown;
    [k: string]: unknown;
  };
  preferences?: Record<string, unknown>;
  profile?: { name?: unknown; [k: string]: unknown };
  flags?: { classSelected?: unknown; [k: string]: unknown };
  [k: string]: unknown;
}

/**
 * Shared combat contract for the runtime (src/lib/combat.ts). The runtime
 * implements effects; this is the numbers/identity surface. Extreme imported
 * stats are bounded with diminishing returns.
 */
export type SignatureAbility = 'bolt' | 'cleave' | 'dash' | 'heal';

export interface CombatKit {
  /** null for the classless starter kit. */
  class: HabiticaClass | null;
  /** Character display name (profile name, or demo name for the starter kit). */
  name: string;
  basicName: string;
  signatureName: string;
  signature: SignatureAbility;
  meleeDamage: number;
  signatureDamage: number;
  /** Fraction of incoming damage absorbed, 0..~0.45. */
  mitigation: number;
  /** Critical hit chance, 0..~0.45. */
  critChance: number;
  manaCost: number;
  /** Seconds between signature uses. */
  cooldown: number;
  healAmount: number;
}

/** Why a sync was rejected. The save (including its baseline) is unchanged. */
export type SyncRejectReason = 'not-at-safe-boundary' | 'account-switch';

export type SyncStatus = 'imported' | 'synced' | 'unchanged' | 'rejected';
