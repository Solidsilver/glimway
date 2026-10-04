/**
 * Habitica gear catalog — Fingersnap M3 (owner: snap_assets).
 *
 * NUMERIC item data bundled in `content/habitica-gear.json`, snapshotted
 * from Habitica's public content endpoint (see provenance below and
 * docs/habitica-assets.md). No account credentials are used or stored here;
 * the snapshot is a static, unauthenticated content GET.
 *
 * License split (do not conflate):
 *   - Item stat definitions derived from Habitica source/content data
 *     (HabitRPG/habitica, GPL v3).
 *   - Art is NOT bundled in this module; upstream sprite URLs live in
 *     avatar.ts and are CC BY-NC-SA 3.0 (see ASSETS.md).
 *
 * `gearStatsFor` is a drop-in `GearStatsLookup` for
 * `toHabiticaProfile(user, gearStatsFor)` (src/lib/habitica/mapping.ts).
 */
import type { GearItemStats } from './types.ts';
import catalogJson from '../../../content/habitica-gear.json' with { type: 'json' };

/** Per-item numeric entry as bundled in habitica-gear.json. */
export interface GearCatalogItem {
  type: string;
  klass: string;
  /** Real class for non-class gear (klass 'special'/'mystery'/'armoire'). */
  specialClass?: string;
  index: string;
  set: string;
  str: number;
  int: number;
  con: number;
  per: number;
  value: number;
  twoHanded?: boolean;
  last?: boolean;
  mystery?: string;
  season?: string;
  event?: string;
  gearSet?: string;
}

export interface GearCatalogProvenance {
  name: string;
  sourceEndpoint: string;
  sourceProject: string;
  sourceRevision: string;
  sourceRevisionDate: string;
  retrievedAt: string;
  clientTag: string;
  auth: string;
  licenses: { gearData: string; art: string };
  counts: { gear: number; pets: number; mounts: number; gifSprites: number };
  modifications: string;
}

export interface GearCatalog {
  $comment: string;
  provenance: GearCatalogProvenance;
  gear: Record<string, GearCatalogItem>;
  pets: string[];
  mounts: string[];
  /** Sprite names rendered as .gif upstream (constants/gifSprites.js). */
  gifSprites: string[];
  appearances: {
    size: string[];
    skin: string[];
    shirt: string[];
    hair: {
      color: string[];
      bangs: string[];
      base: string[];
      mustache: string[];
      beard: string[];
      flower: string[];
    };
    chair: string[];
  };
  /** Catalog keys that are intentional no-visual 'none' pieces (*_base_0). */
  spritelessGear: string[];
  /** Local same-origin cache subset: sprite name -> extension. */
  localSprites: Record<string, string>;
  $rules: Record<string, string>;
}

export const CATALOG = catalogJson as unknown as GearCatalog;

const NONE_PIECES: ReadonlySet<string> = new Set(CATALOG.spritelessGear);

/**
 * Numeric stat contribution for one equipped item key — the catalog lookup
 * the effective-stat formula needs. Returns undefined for unknown keys
 * (never guesses; a missing key contributes nothing).
 */
export function gearStatsFor(key: string): GearItemStats | undefined {
  const item = CATALOG.gear[key];
  if (!item) return undefined;
  const stats: GearItemStats = {
    str: item.str,
    int: item.int,
    con: item.con,
    per: item.per,
    klass: item.klass,
  };
  if (item.specialClass !== undefined) stats.specialClass = item.specialClass;
  return stats;
}

/** Full catalog entry for an item key, or undefined when unknown. */
export function gearItemFor(key: string): GearCatalogItem | undefined {
  return CATALOG.gear[key];
}

export function isKnownGearKey(key: string): boolean {
  return Object.prototype.hasOwnProperty.call(CATALOG.gear, key);
}

/** Upstream rule: two-handed weapons suppress the shield layer. */
export function isTwoHanded(key: string): boolean {
  return CATALOG.gear[key]?.twoHanded === true;
}

/**
 * True for catalog keys with no upstream sprite: the *_base_0 'none' pieces
 * (unequipped slots in Habitica payloads carry these). They render no layer.
 */
export function isNonePiece(key: string): boolean {
  return NONE_PIECES.has(key);
}

export function isPetKey(key: string): boolean {
  return CATALOG.pets.includes(key);
}

export function isMountKey(key: string): boolean {
  return CATALOG.mounts.includes(key);
}

/** Upstream companion sprite names for a validated pet/mount key. */
export function companionSpriteNames(key: string, kind: 'pet' | 'mount'): string[] {
  if (kind === 'pet') return isPetKey(key) ? [`Pet-${key}`] : [];
  if (kind === 'mount') {
    return isMountKey(key) ? [`Mount_Body_${key}`, `Mount_Head_${key}`] : [];
  }
  return [];
}

/** True when the sprite is animated upstream (extension .gif, not .png). */
export function isGifSprite(name: string): boolean {
  return CATALOG.gifSprites.includes(name);
}
