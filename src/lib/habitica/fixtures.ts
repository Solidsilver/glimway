import type {
  EffectiveStats,
  GearItemStats,
  GearStatsLookup,
  HabiticaClass,
  HabiticaUserJson,
} from './types.ts';
import { MAX_HEALTH } from './mapping.ts';

/**
 * Fixture profiles for the import foundation: realistic GET /api/v3/user
 * `data` payloads plus the gear-stat table and hand-computed effective stats
 * the mapping must produce. Field paths are verified against THESE, never
 * against a live account. Gear stats are fixture-authored test data (the
 * /user payload carries equipped keys only). Payloads stay realistic: no
 * fabricated computed fields — the schema stores no stats.maxHealth / maxMP.
 */
export interface HabiticaFixture {
  key: string;
  description: string;
  user: HabiticaUserJson;
  gearStats: Record<string, GearItemStats>;
  expected: {
    class: HabiticaClass | null;
    level: number;
    hp: number;
    maxHp: number;
    mp: number;
    maxMp: number;
    stats: EffectiveStats;
    useCostume?: boolean;
    selectedPet?: string | null;
    selectedMount?: string | null;
    costumeSlots?: string[];
  };
}

function userFixture(
  overrides: {
    id?: string;
    name?: string;
    level: number;
    class: string | null;
    hp: number;
    mp: number;
    base: EffectiveStats;
    buffs: Partial<EffectiveStats>;
    equipped: Record<string, string>;
    costume?: Record<string, string>;
    useCostume?: boolean;
    currentPet?: string;
    currentMount?: string;
    pets?: Record<string, number>;
    mounts?: Record<string, boolean>;
  },
): HabiticaUserJson {
  const hairColor = 'brown';
  return {
    _id: overrides.id ?? 'fixture-user-000000000000000000000001',
    stats: {
      hp: overrides.hp,
      mp: overrides.mp,
      lvl: overrides.level,
      class: overrides.class ?? 'warrior',
      exp: 120.5,
      gp: 25,
      points: 0,
      str: overrides.base.str,
      int: overrides.base.int,
      con: overrides.base.con,
      per: overrides.base.per,
      buffs: {
        str: overrides.buffs.str ?? 0,
        int: overrides.buffs.int ?? 0,
        con: overrides.buffs.con ?? 0,
        per: overrides.buffs.per ?? 0,
        snowball: 0,
        spookySparkles: 0,
        shinySeed: 0,
        seafoam: 0,
      },
      training: { str: 0, int: 0, con: 0, per: 0 },
    },
    items: {
      gear: {
        equipped: {
          weapon: overrides.equipped.weapon ?? 'weapon_base_0',
          shield: overrides.equipped.shield ?? 'shield_base_0',
          armor: overrides.equipped.armor ?? 'armor_base_0',
          head: overrides.equipped.head ?? 'head_base_0',
          back: overrides.equipped.back ?? 'back_base_0',
          body: overrides.equipped.body ?? 'body_base_0',
          eyewear: overrides.equipped.eyewear ?? 'eyewear_base_0',
          headAccessory: overrides.equipped.headAccessory ?? 'headAccessory_base_0',
        },
        costume: overrides.costume ?? {},
        owned: {},
      },
      currentPet: overrides.currentPet ?? '',
      currentMount: overrides.currentMount ?? '',
      pets: overrides.pets ?? { 'Wolf-Base': 1 },
      mounts: overrides.mounts ?? { 'Wolf-Base': true },
      quests: {},
      special: {},
    },
    preferences: {
      size: 'slim',
      shirt: 'blue',
      skin: 'normal',
      hair: { color: hairColor, base: 1, bangs: 0, beard: 0, mustache: 0, flower: 0 },
      background: 'intro',
      chair: 'none',
      dateFormat: 'MM/dd/yyyy',
      costume: overrides.useCostume ?? false,
      sleep: false,
    },
    profile: { name: overrides.name ?? 'Fixture Hero' },
    flags: { classSelected: overrides.class !== null, tutorial: {} },
  };
}

/** Level 2 warrior: level bonus 1; class-matching gear counted twice. */
const lowLevel: HabiticaFixture = {
  key: 'lowLevel',
  description: 'Low-level warrior with starter class gear (verification priority: low-level)',
  user: userFixture({
    id: 'fixture-low-level-000000000000000001',
    name: 'Tansy',
    level: 2,
    class: 'warrior',
    hp: 41,
    mp: 30,
    base: { str: 8, int: 2, con: 6, per: 3 },
    buffs: {},
    equipped: {
      weapon: 'weapon_warrior_1',
      armor: 'armor_warrior_1',
    },
    pets: { 'Wolf-Base': 1, 'Cactus-Base': 1 },
    mounts: {},
  }),
  gearStats: {
    weapon_warrior_1: { str: 2, klass: 'warrior' },
    armor_warrior_1: { con: 1, klass: 'warrior' },
    shield_base_0: {},
    head_base_0: {},
    back_base_0: {},
    body_base_0: {},
    eyewear_base_0: {},
    headAccessory_base_0: {},
    weapon_base_0: {},
  },
  expected: {
    class: 'warrior',
    level: 2,
    hp: 41,
    maxHp: 50,
    mp: 30,
    // effective int 3 -> maxMp 2*3+30
    maxMp: 36,
    // level bonus 1; weapon str 2 gear + 2 class; armor con 1 gear + 1 class
    stats: { str: 13, int: 3, con: 9, per: 4 },
  },
};

/**
 * Level 100 mage at the level cap: buffs included, heavy INT gear with
 * class-match doubling, derived maxMp from effective INT. Real Habitica
 * payloads spell the mage class `wizard` (stats.class) and label wizard
 * gear `klass: 'wizard'` — the mapping must accept both and still apply
 * the class bonus for the internal `mage`.
 */
const highLevel: HabiticaFixture = {
  key: 'highLevel',
  description:
    'Level-cap mage (Habitica class `wizard`) with buffs and heavy INT gear (verification priority: high-level)',
  user: userFixture({
    id: 'fixture-high-level-00000000000000001',
    name: 'Vesper',
    level: 100,
    class: 'wizard',
    hp: 50,
    mp: 300,
    base: { str: 30, int: 65, con: 40, per: 45 },
    buffs: { str: 5, per: 2 },
    equipped: {
      weapon: 'weapon_wizard_1',
      armor: 'armor_wizard_1',
      head: 'head_wizard_1',
      shield: 'shield_mystery',
    },
    pets: { 'Dragon-Red': 1 },
    mounts: { 'Dragon-Red': true, 'Wolf-Base': true },
  }),
  gearStats: {
    weapon_wizard_1: { int: 9, klass: 'wizard' },
    armor_wizard_1: { int: 5, con: 2, klass: 'wizard' },
    head_wizard_1: { int: 4, klass: 'wizard' },
    shield_mystery: { per: 10 },
    shield_base_0: {},
    head_base_0: {},
    back_base_0: {},
    body_base_0: {},
    eyewear_base_0: {},
    headAccessory_base_0: {},
    weapon_base_0: {},
  },
  expected: {
    class: 'mage',
    level: 100,
    hp: 50,
    maxHp: 50,
    mp: 300,
    // effective int 151 -> maxMp 2*151+30
    maxMp: 332,
    // level bonus 50 (capped); buffs str 5 / per 2;
    // INT gear 18 + class 18; con gear 2 + class 2; per gear 10 only
    // (wizard-klass gear matches the internal mage class)
    stats: { str: 85, int: 151, con: 94, per: 107 },
  },
};

/** flags.classSelected false: classless — no class-match bonus at all. */
const classless: HabiticaFixture = {
  key: 'classless',
  description:
    'No class selected (verification priority: classless) — class bonus skipped even for gear matching stats.class',
  user: userFixture({
    id: 'fixture-classless-000000000000000001',
    name: 'Wren',
    level: 5,
    class: null,
    hp: 48,
    mp: 40,
    base: { str: 5, int: 5, con: 5, per: 5 },
    buffs: {},
    equipped: {
      // klass matches the raw stats.class ('warrior' default) but the
      // account is classless, so the class-match bonus must NOT apply.
      weapon: 'weapon_warrior_1',
    },
  }),
  gearStats: {
    weapon_warrior_1: { str: 2, klass: 'warrior' },
    weapon_base_0: {},
    shield_base_0: {},
    head_base_0: {},
    armor_base_0: {},
    back_base_0: {},
    body_base_0: {},
    eyewear_base_0: {},
    headAccessory_base_0: {},
  },
  expected: {
    class: null,
    level: 5,
    hp: 48,
    maxHp: 50,
    mp: 40,
    // effective int 7 -> maxMp 2*7+30
    maxMp: 44,
    // level bonus 2; warrior weapon gets NO class bonus (classless deviation)
    stats: { str: 9, int: 7, con: 7, per: 7 },
  },
};

/** Fractional imported HP — the expedition-difficulty source. */
const lowHp: HabiticaFixture = {
  key: 'lowHp',
  description: 'Rogue at 3.2/50 HP (verification priority: low-HP) — fractional vitals',
  user: userFixture({
    id: 'fixture-low-hp-00000000000000000001',
    name: 'Sable',
    level: 20,
    class: 'rogue',
    hp: 3.2,
    mp: 22,
    base: { str: 15, int: 10, con: 12, per: 20 },
    buffs: { con: 3 },
    equipped: {
      weapon: 'weapon_rogue_1',
    },
  }),
  gearStats: {
    weapon_rogue_1: { str: 2, per: 3, klass: 'rogue' },
    weapon_base_0: {},
    shield_base_0: {},
    head_base_0: {},
    armor_base_0: {},
    back_base_0: {},
    body_base_0: {},
    eyewear_base_0: {},
    headAccessory_base_0: {},
  },
  expected: {
    class: 'rogue',
    level: 20,
    hp: 3.2,
    maxHp: 50,
    mp: 22,
    // effective int 20 -> maxMp 2*20+30
    maxMp: 70,
    // level bonus 10; con buff 3; weapon str 2+2 / per 3+3 (class rogue)
    stats: { str: 29, int: 20, con: 25, per: 36 },
  },
};

/**
 * Mixed equipment: klass match, specialClass match, non-matching klass, and
 * an equipped key missing from the catalog — proves the formula adds each
 * contribution exactly once and ignores unknown items.
 */
const variedEquipment: HabiticaFixture = {
  key: 'variedEquipment',
  description: 'Warrior with mixed klass/specialClass/unknown gear (verification priority: varied-equipment)',
  user: userFixture({
    id: 'fixture-varied-gear-0000000000000001',
    name: 'Orrin',
    level: 50,
    class: 'warrior',
    hp: 42,
    mp: 80,
    base: { str: 25, int: 15, con: 20, per: 18 },
    buffs: { str: 2, int: 2 },
    equipped: {
      weapon: 'weapon_warrior_2',
      shield: 'shield_rogue_1',
      armor: 'armor_special_0',
      head: 'head_mystery',
      back: 'back_cape',
      headAccessory: 'headAccessory_absent',
    },
    costume: {
      weapon: 'weapon_special_1',
      armor: 'armor_special_1',
      head: 'head_special_1',
    },
    useCostume: true,
    currentPet: 'Wolf-Base',
    currentMount: 'Wolf-Base',
  }),
  gearStats: {
    weapon_warrior_2: { str: 12, klass: 'warrior' },
    shield_rogue_1: { per: 6, klass: 'rogue' },
    armor_special_0: { con: 8, specialClass: 'warrior' },
    head_mystery: { int: 10 },
    back_cape: { str: 1 },
    weapon_base_0: {},
    shield_base_0: {},
    head_base_0: {},
    armor_base_0: {},
    body_base_0: {},
    eyewear_base_0: {},
    headAccessory_base_0: {},
    // headAccessory_absent deliberately NOT in this catalog
  },
  expected: {
    class: 'warrior',
    level: 50,
    hp: 42,
    maxHp: MAX_HEALTH,
    mp: 80,
    // effective int 52 -> maxMp 2*52+30
    maxMp: 134,
    // level bonus 25; str: base 25 + buff 2 + gear 13 (12+1) + class 12;
    // int: 15 + 2 + gear 10; con: 20 + gear 8 + class 8 (specialClass);
    // per: 18 + gear 6 (rogue shield does not match warrior)
    // costume contributes nothing to stats
    stats: { str: 77, int: 52, con: 61, per: 49 },
    useCostume: true,
    selectedPet: 'Wolf-Base',
    selectedMount: 'Wolf-Base',
    costumeSlots: ['armor', 'head', 'weapon'],
  },
};

export const FIXTURES: HabiticaFixture[] = [
  lowLevel,
  highLevel,
  classless,
  lowHp,
  variedEquipment,
];

export const FIXTURES_BY_KEY: Record<string, HabiticaFixture> = Object.fromEntries(
  FIXTURES.map((f) => [f.key, f]),
);

/** GearStatsLookup over a fixture's (or any) gear-stat table. */
export function gearLookupFor(table: Record<string, GearItemStats>): GearStatsLookup {
  return (itemKey: string) => table[itemKey];
}
