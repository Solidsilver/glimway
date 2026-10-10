/**
 * Habitica gear catalog.
 *
 * Numeric item data and the English gear names (the `text` field) bundled
 * in `content/habitica-gear.json`, snapshotted
 * from Habitica's public content endpoint (see provenance below and
 * docs/habitica-assets.md). No account credentials are used or stored here;
 * the snapshot is a static, unauthenticated content GET.
 *
 * The schema (proto/glimway/content/v1/habitica_gear.proto) carries the
 * vocabulary — unknown keys, nulls and wrong types are refused by the
 * loader (src/lib/content-proto.ts); the snapshot is generated upstream and
 * the old hand-written loader checked nothing per entry, so there are no
 * field rules and none in code.
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
import { decodeContent } from '../content-proto.ts';
import {
  HabiticaGearSchema,
  type HabiticaGearValid,
  type HabiticaGearItemValid,
} from '../gen/glimway/content/v1/habitica_gear_pb.js';
import gearJson from '../../../content/habitica-gear.json' with { type: 'json' };

/** Per-item numeric entry as bundled in habitica-gear.json. */
export type GearCatalogItem = HabiticaGearItemValid;

/** The snapshot: provenance, gear, appearance vocabularies, sprite notes. */
export type GearCatalog = HabiticaGearValid;

/** Validate the raw snapshot. Throws on unknown keys, nulls, wrong types. */
export function validateHabiticaGear(value: unknown): GearCatalog {
  // The schema guarantees the required messages (appearances, its hair),
  // so the valid type's non-optional fields hold.
  return decodeContent(HabiticaGearSchema, value, 'habitica-gear', []) as unknown as GearCatalog;
}

export const CATALOG = validateHabiticaGear(gearJson);

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
