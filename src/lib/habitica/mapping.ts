import type {
  EffectiveStats,
  GearItemStats,
  GearStatsLookup,
  HabiticaAppearance,
  HabiticaClass,
  HabiticaProfile,
} from './types.ts';

/** Habitica `MAX_LEVEL` (website/common/script/constants.js, verified). */
export const MAX_LEVEL = 100;

/**
 * Habitica `shared.maxHealth` (website/common/script/constants.js
 * `MAX_HEALTH = 50`, verified 2026-10-03). The user schema stores only
 * `stats.hp` (default shared.maxHealth) — `stats.maxHealth` exists solely as
 * a computed field injected when the response is NOT projected by
 * `userFields` (website/server/libs/user/index.js:28). Our client always
 * projects, so max HP derives from this constant unless a payload happens to
 * carry `stats.maxHealth` (legacy/unprojected).
 */
export const MAX_HEALTH = 50;

export class InvalidHabiticaUserError extends Error {
  readonly path: string;

  constructor(message: string, path = '') {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'InvalidHabiticaUserError';
    this.path = path;
  }
}

const CLASSES: readonly string[] = ['warrior', 'mage', 'rogue', 'healer'];

const STAT_KEYS = ['str', 'int', 'con', 'per'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNumber(value: unknown, path: string, opts: { min?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidHabiticaUserError(`expected a finite number, got ${typeof value}`, path);
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new InvalidHabiticaUserError(`expected a number >= ${opts.min}, got ${value}`, path);
  }
  return value;
}

function optionalNumber(value: unknown, path: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  return requireNumber(value, path);
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new InvalidHabiticaUserError(`expected a non-empty string, got ${typeof value}`, path);
  }
  return value;
}

function optionalString(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.length > 0 ? value : fallback;
}

/**
 * Effective stats per Habitica `statsComputed` (see docs/habitica-foundations.md):
 *   base + buff + gearBonus + classBonus + floor(min(lvl, MAX_LEVEL) / 2)
 * Class-matching gear contributes its stat twice (gearBonus + classBonus) —
 * that is Habitica's own formula, not a double-counting bug. Base stats must
 * never be taken from anywhere except user.stats.* (they exclude gear).
 */
export function effectiveStatsFor(
  base: EffectiveStats,
  buffs: EffectiveStats,
  level: number,
  equipped: Record<string, string | null>,
  characterClass: HabiticaClass | null,
  gearStats?: GearStatsLookup,
): EffectiveStats {
  const levelBonus = Math.floor(Math.min(level, MAX_LEVEL) / 2);
  const out = { str: 0, int: 0, con: 0, per: 0 } as EffectiveStats;
  for (const stat of STAT_KEYS) {
    let gearBonus = 0;
    let classBonus = 0;
    for (const itemKey of Object.values(equipped)) {
      if (typeof itemKey !== 'string') continue;
      const item: GearItemStats | undefined = gearStats?.(itemKey);
      if (!item) continue;
      const contribution = item[stat] ?? 0;
      gearBonus += contribution;
      const matchesClass =
        characterClass !== null &&
        (item.klass === characterClass || item.specialClass === characterClass);
      if (matchesClass) classBonus += contribution;
    }
    out[stat] = base[stat] + buffs[stat] + gearBonus + classBonus + levelBonus;
  }
  return out;
}

function readEquipped(raw: unknown): Record<string, string | null> {
  return sanitizeStringMap(raw);
}

function readKeyList(raw: unknown, nonzero: boolean): string[] {
  if (!isRecord(raw)) return [];
  const keys: string[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (nonzero) {
      if (typeof value === 'number' && value !== 0) keys.push(key);
    } else if (value) {
      keys.push(key);
    }
  }
  keys.sort();
  return keys;
}

function readAppearance(raw: unknown): HabiticaAppearance {
  const prefs = isRecord(raw) ? raw : {};
  const hair = isRecord(prefs.hair) ? prefs.hair : {};
  return {
    size: optionalString(prefs.size, ''),
    shirt: optionalString(prefs.shirt, ''),
    skin: optionalString(prefs.skin, ''),
    hairColor: optionalString(hair.color, ''),
    hairStyle: optionalNumber(hair.base, 'preferences.hair.base', 0),
    background: optionalString(prefs.background, ''),
    hairBangs: optionalNumber(hair.bangs, 'preferences.hair.bangs', 0),
    hairMustache: optionalNumber(hair.mustache, 'preferences.hair.mustache', 0),
    hairBeard: optionalNumber(hair.beard, 'preferences.hair.beard', 0),
    hairFlower: optionalNumber(hair.flower, 'preferences.hair.flower', 0),
  };
}

/**
 * Maps a GET /api/v3/user `data` payload to a sanitized HabiticaProfile.
 * Throws InvalidHabiticaUserError with a field path on missing/invalid
 * required fields. Unknown fields are ignored; nothing credential-shaped is
 * ever copied (the profile shape has no place for it).
 */
export function toHabiticaProfile(user: unknown, gearStats?: GearStatsLookup): HabiticaProfile {
  if (!isRecord(user)) {
    throw new InvalidHabiticaUserError('user payload must be an object');
  }
  const statsRaw = user.stats;
  if (!isRecord(statsRaw)) {
    throw new InvalidHabiticaUserError('expected an object', 'stats');
  }

  const id =
    typeof user._id === 'string' && user._id.length > 0
      ? user._id
      : typeof user.id === 'string' && user.id.length > 0
        ? user.id
        : null;
  if (id === null) {
    throw new InvalidHabiticaUserError('expected a non-empty string (_id or id)', 'id');
  }

  const profileRaw = isRecord(user.profile) ? user.profile : {};
  const name = requireString(profileRaw.name, 'profile.name');

  const flags = isRecord(user.flags) ? user.flags : {};
  const classSelected = flags.classSelected !== false;
  const rawClass = statsRaw.class;
  let characterClass: HabiticaClass | null = null;
  if (classSelected) {
    if (typeof rawClass !== 'string' || !CLASSES.includes(rawClass)) {
      throw new InvalidHabiticaUserError(
        `expected one of ${CLASSES.join(', ')}, got ${JSON.stringify(rawClass)}`,
        'stats.class',
      );
    }
    characterClass = rawClass as HabiticaClass;
  }

  const level = requireNumber(statsRaw.lvl, 'stats.lvl', { min: 1 });
  const exp = Math.max(0, optionalNumber(statsRaw.exp, 'stats.exp', 0));
  const hp = requireNumber(statsRaw.hp, 'stats.hp', { min: 0 });
  const maxHp =
    statsRaw.maxHealth === undefined || statsRaw.maxHealth === null
      ? MAX_HEALTH
      : requireNumber(statsRaw.maxHealth, 'stats.maxHealth', { min: 1 });
  const mp = requireNumber(statsRaw.mp, 'stats.mp', { min: 0 });

  const buffsRaw = isRecord(statsRaw.buffs) ? statsRaw.buffs : {};
  const base = {
    str: requireNumber(statsRaw.str, 'stats.str', { min: 0 }),
    int: requireNumber(statsRaw.int, 'stats.int', { min: 0 }),
    con: requireNumber(statsRaw.con, 'stats.con', { min: 0 }),
    per: requireNumber(statsRaw.per, 'stats.per', { min: 0 }),
  };
  const buffs = {
    str: optionalNumber(buffsRaw.str, 'stats.buffs.str', 0),
    int: optionalNumber(buffsRaw.int, 'stats.buffs.int', 0),
    con: optionalNumber(buffsRaw.con, 'stats.buffs.con', 0),
    per: optionalNumber(buffsRaw.per, 'stats.buffs.per', 0),
  };

  const items = isRecord(user.items) ? user.items : {};
  const gear = isRecord(items.gear) ? items.gear : {};
  const equipped = readEquipped(gear.equipped);

  const stats = effectiveStatsFor(base, buffs, level, equipped, characterClass, gearStats);
  const maxMp = 2 * stats.int + 30;

  return {
    id,
    name,
    class: characterClass,
    level,
    exp,
    hp,
    maxHp,
    mp,
    maxMp,
    stats,
    equipped,
    pets: readKeyList(items.pets, true),
    mounts: readKeyList(items.mounts, false),
    appearance: readAppearance(user.preferences),
    costume: readEquipped(gear.costume),
    useCostume: readUseCostume(user.preferences),
    selectedPet: readCompanion(items.currentPet),
    selectedMount: readCompanion(items.currentMount),
  };
}

function readUseCostume(raw: unknown): boolean {
  const prefs = isRecord(raw) ? raw : {};
  return prefs.costume === true || prefs.costume === 1;
}

/** items.currentPet / items.currentMount default to '' — normalize to null. */
function readCompanion(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * Known items.gear.equipped slots. Whitelisted so an unknown key (e.g. a
 * smuggled `apiToken`) can never persist into saves/exports; unknown slots in
 * a future Habitica version are dropped rather than stored.
 */
const GEAR_SLOTS = [
  'weapon',
  'shield',
  'armor',
  'head',
  'headAccessory',
  'back',
  'body',
  'eyewear',
  'weaponSpecial',
] as const;

function sanitizeStringMap(value: unknown): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  if (!isRecord(value)) return out;
  for (const slot of GEAR_SLOTS) {
    const v = value[slot];
    if (v === undefined || v === null) {
      out[slot] = null;
      continue;
    }
    out[slot] = typeof v === 'string' && v.length > 0 ? v : null;
  }
  return out;
}

function sanitizeStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new InvalidHabiticaUserError('expected an array of strings', path);
  }
  return value.map((item, i) => {
    if (typeof item !== 'string' || item.length === 0) {
      throw new InvalidHabiticaUserError('expected a non-empty string', `${path}[${i}]`);
    }
    return item;
  });
}

function sanitizeStats(value: unknown, path: string): EffectiveStats {
  if (!isRecord(value)) {
    throw new InvalidHabiticaUserError('expected an object', path);
  }
  return {
    str: requireNumber(value.str, `${path}.str`, { min: 0 }),
    int: requireNumber(value.int, `${path}.int`, { min: 0 }),
    con: requireNumber(value.con, `${path}.con`, { min: 0 }),
    per: requireNumber(value.per, `${path}.per`, { min: 0 }),
  };
}

/**
 * Validates and sanitizes a profile coming from a save/import. Unknown fields
 * are stripped, so a smuggled credential or token-like key can never be
 * persisted. Throws InvalidHabiticaUserError on malformed data.
 */
export function validateHabiticaProfile(data: unknown): HabiticaProfile {
  if (!isRecord(data)) {
    throw new InvalidHabiticaUserError('profile must be an object');
  }
  const rawClass = data.class;
  let characterClass: HabiticaClass | null = null;
  if (rawClass !== null && rawClass !== undefined) {
    if (typeof rawClass !== 'string' || !CLASSES.includes(rawClass)) {
      throw new InvalidHabiticaUserError(
        `expected one of ${CLASSES.join(', ')} or null, got ${JSON.stringify(rawClass)}`,
        'class',
      );
    }
    characterClass = rawClass as HabiticaClass;
  }

  const appearanceRaw = isRecord(data.appearance) ? data.appearance : {};
  return {
    id: requireString(data.id, 'id'),
    name: requireString(data.name, 'name'),
    class: characterClass,
    level: requireNumber(data.level, 'level', { min: 1 }),
    ...(data.exp === undefined || data.exp === null ? {} : { exp: requireNumber(data.exp, 'exp', { min: 0 }) }),
    hp: requireNumber(data.hp, 'hp', { min: 0 }),
    maxHp: requireNumber(data.maxHp, 'maxHp', { min: 1 }),
    mp: requireNumber(data.mp, 'mp', { min: 0 }),
    maxMp: requireNumber(data.maxMp, 'maxMp', { min: 0 }),
    stats: sanitizeStats(data.stats, 'stats'),
    equipped: sanitizeStringMap(data.equipped),
    pets: sanitizeStringArray(data.pets, 'pets'),
    mounts: sanitizeStringArray(data.mounts, 'mounts'),
    appearance: {
      size: optionalString(appearanceRaw.size, ''),
      shirt: optionalString(appearanceRaw.shirt, ''),
      skin: optionalString(appearanceRaw.skin, ''),
      hairColor: optionalString(appearanceRaw.hairColor, ''),
      hairStyle: optionalNumber(appearanceRaw.hairStyle, 'appearance.hairStyle', 0),
      background: optionalString(appearanceRaw.background, ''),
      hairBangs: optionalNumber(appearanceRaw.hairBangs, 'appearance.hairBangs', 0),
      hairMustache: optionalNumber(appearanceRaw.hairMustache, 'appearance.hairMustache', 0),
      hairBeard: optionalNumber(appearanceRaw.hairBeard, 'appearance.hairBeard', 0),
      hairFlower: optionalNumber(appearanceRaw.hairFlower, 'appearance.hairFlower', 0),
    },
    costume: data.costume === undefined ? {} : sanitizeStringMap(data.costume),
    useCostume: data.useCostume === undefined ? false : data.useCostume === true,
    selectedPet:
      data.selectedPet === undefined || data.selectedPet === null
        ? null
        : requireString(data.selectedPet, 'selectedPet'),
    selectedMount:
      data.selectedMount === undefined || data.selectedMount === null
        ? null
        : requireString(data.selectedMount, 'selectedMount'),
  };
}
