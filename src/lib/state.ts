import { knownRoom } from './rooms.ts';
// Area builders register IDs at runtime; save validation uses SAVE_AREAS below.
export type AreaId = 'village' | 'woodland' | 'ruin' | (string & {});

/** The lantern road's step reached (`'new'` before it starts): what the game's older reads follow. */
export type QuestStage =
  | 'new'
  | 'accepted'
  | 'clue-found'
  | 'guardian-defeated'
  | 'lantern-lit'
  | 'complete';

/** The lantern road's five events, as the scene still fires them (src/lib/quests.ts ROAD_EVENT_STEP). */
export type QuestEvent =
  | 'accept'
  | 'find-clue'
  | 'defeat-guardian'
  | 'light-lantern'
  | 'return-village';

export interface GameState {
  version: 1;
  area: AreaId;
  position: { x: number; y: number };
  /** Quest id → the step reached (src/lib/quests.ts). No entry: not started. */
  quests: Record<string, string>;
  /**
   * The server's (and the predictor's): when each quest last reached a gated
   * step, or its first (Unix seconds). Waits count from it.
   */
  questGateAt?: Record<string, number>;
  hp: number;
  maxHp: number;
  mana: number;
  maxMana: number;
  inventory: string[];
  discoveries: string[];
  defeatedEnemies: string[];
  playSeconds: number;
  /** Ember balance (src/lib/embers.ts). Saves from before Embers load as 0. */
  embers: number;
  /** One-way world flags: lit road lanterns, opened chests, one-off gifts. */
  flags: string[];
  /**
   * Highest lifetime Habitica XP already paid out as embers (0 = not yet
   * known). It only ever rises, so XP lost and earned back never pays twice.
   */
  emberXp: number;
  /**
   * How many of `embers` were earned from Habitica XP (not gifts or quest
   * beats). Only these can revive an imported hero from 0 HP. Always <= embers.
   */
  xpEmbers: number;
  /**
   * Client-only (never uploaded): which Wilds region a saved `wilds`
   * position is in. Absent means the Tangle; `outer-1` the outer Wilds.
   * Positions are region-wide pixels and the server keeps `area: 'wilds'`
   * for both regions, so this is how a reload knows which map to build.
   */
  wildsRegion?: string;
  /** Client-only: the outer epoch (season) this player was last in. */
  outerSeason?: string;
  /** The server's: the outer epoch (id) this player's place was last recorded in. */
  outerEpoch?: string;
}

export class InvalidSaveError extends Error {
  readonly path: string;

  constructor(message: string, path = '') {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'InvalidSaveError';
    this.path = path;
  }
}

// Curated areas are buildable by the existing standalone frontend.
export const AREAS: readonly AreaId[] = ['village', 'woodland', 'ruin'];
const SAVE_AREAS: readonly AreaId[] = [...AREAS, 'commons', 'wilds'];

/** A homestead's land behind Commons gate g: `home:<g>` (0..9999, no leading zeros). */
export const HOME_AREA_RE = /^home:(0|[1-9]\d{0,3})$/;

/** Can a save say it is here? The fixed areas, any homestead's land, and the rooms (a cottage, a village room). */
function isSaveArea(area: unknown): area is AreaId {
  return typeof area === 'string' && ((SAVE_AREAS as readonly string[]).includes(area) || HOME_AREA_RE.test(area) || knownRoom(area));
}

export const QUEST_STAGES: readonly QuestStage[] = [
  'new',
  'accepted',
  'clue-found',
  'guardian-defeated',
  'lantern-lit',
  'complete',
];

export const QUEST_EVENTS: readonly QuestEvent[] = [
  'accept',
  'find-clue',
  'defeat-guardian',
  'light-lantern',
  'return-village',
];

export const SAVE_VERSION = 1 as const;

const DEFAULT_MAX_HP = 40;
const DEFAULT_HP = 40;
const DEFAULT_MAX_MANA = 20;
const DEFAULT_MANA = 20;

const DEFAULT_POSITION = { x: 400, y: 300 } as const;

const STARTING_INVENTORY: readonly string[] = ['field-journal', 'hearthwick-map'];

export function createNewGame(): GameState {
  return {
    version: SAVE_VERSION,
    area: 'village',
    position: { x: DEFAULT_POSITION.x, y: DEFAULT_POSITION.y },
    quests: {},
    hp: DEFAULT_HP,
    maxHp: DEFAULT_MAX_HP,
    mana: DEFAULT_MANA,
    maxMana: DEFAULT_MAX_MANA,
    inventory: [...STARTING_INVENTORY],
    discoveries: [],
    defeatedEnemies: [],
    playSeconds: 0,
    embers: 0,
    flags: [],
    emberXp: 0,
    xpEmbers: 0,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireFiniteNumber(
  value: unknown,
  path: string,
  opts: { min?: number; max?: number; maxInclusive?: boolean } = {},
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new InvalidSaveError(
      `expected a finite number, got ${describe(value)}`,
      path,
    );
  }
  if (opts.min !== undefined && value < opts.min) {
    throw new InvalidSaveError(
      `expected a number >= ${opts.min}, got ${value}`,
      path,
    );
  }
  if (opts.max !== undefined) {
    const over =
      opts.maxInclusive === false ? value >= opts.max : value > opts.max;
    if (over) {
      throw new InvalidSaveError(
        `expected a number ${opts.maxInclusive === false ? '<' : '<='} ${opts.max}, got ${value}`,
        path,
      );
    }
  }
  return value;
}

function requireStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new InvalidSaveError(
      `expected an array of strings, got ${describe(value)}`,
      path,
    );
  }
  const out: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== 'string' || item.length === 0) {
      throw new InvalidSaveError(
        `expected a non-empty string, got ${describe(item)}`,
        `${path}[${i}]`,
      );
    }
    out.push(item);
  }
  return out;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return `string ${JSON.stringify(value)}`;
  return `${typeof value} ${String(value)}`;
}

const QUEST_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * The quest record: `quests` (id → step reached). A save from before the
 * quest tree (`quest`, the lantern road's stage) loads as that road's
 * record, with the opening counted done, as migration 029 does on the server.
 */
function validateQuests(data: Record<string, unknown>): Record<string, string> {
  if (data.quests === undefined && typeof data.quest === 'string') {
    if (!(QUEST_STAGES as readonly string[]).includes(data.quest)) {
      throw new InvalidSaveError(`expected one of ${QUEST_STAGES.map((s) => JSON.stringify(s)).join(', ')}, got ${describe(data.quest)}`, 'quest');
    }
    return data.quest === 'new' ? {} : { 'lantern-road': data.quest, signpost: 'light-first-lamp' };
  }
  if (!isPlainObject(data.quests)) {
    throw new InvalidSaveError(`expected an object of quest steps, got ${describe(data.quests)}`, 'quests');
  }
  const out: Record<string, string> = {};
  for (const [id, step] of Object.entries(data.quests)) {
    if (!QUEST_ID_RE.test(id) || typeof step !== 'string' || !QUEST_ID_RE.test(step)) {
      throw new InvalidSaveError(`expected a kebab-case step id, got ${describe(step)}`, `quests.${id}`);
    }
    out[id] = step;
  }
  return out;
}

function numberMap(value: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value)) if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  return out;
}

/**
 * Validates unknown data as a GameState. Throws InvalidSaveError with a
 * descriptive message and field path when the data is invalid. Unknown fields
 * are stripped from the returned value, so credentials or other foreign data
 * can never ride along into runtime state, saves, or exports.
 */
export function validateSave(data: unknown): GameState {
  if (!isPlainObject(data)) {
    throw new InvalidSaveError(
      `save data must be an object, got ${describe(data)}`,
    );
  }

  if (data.version !== SAVE_VERSION) {
    throw new InvalidSaveError(
      `unsupported save version ${JSON.stringify(data.version)} (expected ${SAVE_VERSION})`,
      'version',
    );
  }

  if (!isSaveArea(data.area)) {
    throw new InvalidSaveError(
      `expected one of ${SAVE_AREAS.map((a) => JSON.stringify(a)).join(', ')} home:<gate> or a room, got ${describe(data.area)}`,
      'area',
    );
  }

  if (!isPlainObject(data.position)) {
    throw new InvalidSaveError(
      `expected an object with numeric x and y, got ${describe(data.position)}`,
      'position',
    );
  }
  const x = requireFiniteNumber(data.position.x, 'position.x');
  const y = requireFiniteNumber(data.position.y, 'position.y');

  const quests = validateQuests(data);
  const questGateAt = isPlainObject(data.questGateAt) ? numberMap(data.questGateAt) : undefined;

  const maxHp = requireFiniteNumber(data.maxHp, 'maxHp', { min: 1 });
  const hp = requireFiniteNumber(data.hp, 'hp', { min: 0, max: maxHp });
  const maxMana = requireFiniteNumber(data.maxMana, 'maxMana', { min: 0 });
  const mana = requireFiniteNumber(data.mana, 'mana', {
    min: 0,
    max: maxMana,
  });

  const inventory = requireStringArray(data.inventory, 'inventory');
  const discoveries = requireStringArray(data.discoveries, 'discoveries');
  const defeatedEnemies = requireStringArray(
    data.defeatedEnemies,
    'defeatedEnemies',
  );
  const playSeconds = requireFiniteNumber(data.playSeconds, 'playSeconds', {
    min: 0,
  });
  // Added after save version 1 shipped: absent means "none yet".
  const embers =
    data.embers === undefined ? 0 : Math.floor(requireFiniteNumber(data.embers, 'embers', { min: 0 }));
  const flags = data.flags === undefined ? [] : requireStringArray(data.flags, 'flags');
  const emberXp =
    data.emberXp === undefined ? 0 : requireFiniteNumber(data.emberXp, 'emberXp', { min: 0 });
  const xpEmbers = Math.min(
    embers,
    data.xpEmbers === undefined ? 0 : Math.floor(requireFiniteNumber(data.xpEmbers, 'xpEmbers', { min: 0 })),
  );

  // Client-only Wilds markers (added later): short strings, else dropped.
  const marker = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : undefined);
  const wildsRegion = data.area === 'wilds' ? marker(data.wildsRegion) : undefined;
  const outerSeason = marker(data.outerSeason);
  const outerEpoch = typeof data.outerEpoch === 'string' && data.outerEpoch.length > 0 && data.outerEpoch.length <= 128 ? data.outerEpoch : undefined;

  return {
    ...(wildsRegion ? { wildsRegion } : {}),
    ...(outerSeason ? { outerSeason } : {}),
    ...(outerEpoch ? { outerEpoch } : {}),
    version: SAVE_VERSION,
    area: data.area as AreaId,
    position: { x, y },
    quests,
    ...(questGateAt ? { questGateAt } : {}),
    hp,
    maxHp,
    mana,
    maxMana,
    inventory,
    discoveries,
    defeatedEnemies,
    playSeconds,
    embers,
    flags,
    emberXp,
    xpEmbers,
  };
}

/**
 * The guest (demo vitals) defeat rule: the player returns to the Hearthwick
 * spawn and recovers full demo health and mana. Quests, inventory,
 * discoveries, defeated enemies, and play time are kept, so story progress
 * survives defeat. Imported vitals go through resolveDefeatRecovery
 * (src/lib/habitica/sync.ts), which caps them; see docs/runtime-contract.md.
 */
export function recoverFromDefeat(state: GameState): GameState {
  const current = validateSave(state);
  return {
    ...current,
    area: 'village',
    position: { x: DEFAULT_POSITION.x, y: DEFAULT_POSITION.y },
    hp: current.maxHp,
    mana: current.maxMana,
  };
}
