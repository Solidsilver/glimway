export type AreaId = 'village' | 'woodland' | 'ruin';

export type QuestStage =
  | 'new'
  | 'accepted'
  | 'clue-found'
  | 'guardian-defeated'
  | 'lantern-lit'
  | 'complete';

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
  quest: QuestStage;
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
}

export class InvalidSaveError extends Error {
  readonly path: string;

  constructor(message: string, path = '') {
    super(path ? `${message} (at ${path})` : message);
    this.name = 'InvalidSaveError';
    this.path = path;
  }
}

export const AREAS: readonly AreaId[] = ['village', 'woodland', 'ruin'];

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
    quest: 'new',
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

  if (typeof data.area !== 'string' || !(AREAS as readonly string[]).includes(data.area)) {
    throw new InvalidSaveError(
      `expected one of ${AREAS.map((a) => JSON.stringify(a)).join(', ')}, got ${describe(data.area)}`,
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

  if (
    typeof data.quest !== 'string' ||
    !(QUEST_STAGES as readonly string[]).includes(data.quest)
  ) {
    throw new InvalidSaveError(
      `expected one of ${QUEST_STAGES.map((s) => JSON.stringify(s)).join(', ')}, got ${describe(data.quest)}`,
      'quest',
    );
  }

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

  return {
    version: SAVE_VERSION,
    area: data.area as AreaId,
    position: { x, y },
    quest: data.quest as QuestStage,
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

interface QuestTransition {
  from: QuestStage;
  to: QuestStage;
  apply: (state: GameState) => GameState;
}

function addUnique(list: string[], item: string): string[] {
  return list.includes(item) ? [...list] : [...list, item];
}

const TRANSITIONS: Record<QuestEvent, QuestTransition> = {
  accept: {
    from: 'new',
    to: 'accepted',
    apply: (state) => ({ ...state, quest: 'accepted' }),
  },
  'find-clue': {
    from: 'accepted',
    to: 'clue-found',
    apply: (state) => ({
      ...state,
      quest: 'clue-found',
      inventory: addUnique(state.inventory, 'lantern-route-rubbing'),
      discoveries: addUnique(state.discoveries, 'old-route-marker'),
    }),
  },
  'defeat-guardian': {
    from: 'clue-found',
    to: 'guardian-defeated',
    apply: (state) => ({
      ...state,
      quest: 'guardian-defeated',
      inventory: addUnique(state.inventory, 'warden-seal'),
      defeatedEnemies: addUnique(state.defeatedEnemies, 'stone-warden'),
    }),
  },
  'light-lantern': {
    from: 'guardian-defeated',
    to: 'lantern-lit',
    apply: (state) => ({
      ...state,
      quest: 'lantern-lit',
      discoveries: addUnique(state.discoveries, 'hilltop-lantern'),
    }),
  },
  'return-village': {
    from: 'lantern-lit',
    to: 'complete',
    apply: (state) => ({
      ...state,
      quest: 'complete',
      discoveries: addUnique(state.discoveries, 'lantern-road-restored'),
    }),
  },
};

/**
 * Applies a quest event immutably. Only the legal next event for the current
 * stage is accepted; anything else throws with a descriptive error. Returns a
 * new state object; the input is never mutated.
 */
export function advanceQuest(state: GameState, event: QuestEvent): GameState {
  const current = validateSave(state);

  if (typeof event !== 'string' || !(QUEST_EVENTS as readonly string[]).includes(event)) {
    throw new InvalidSaveError(
      `unknown quest event ${describe(event)} (expected one of ${QUEST_EVENTS.map((e) => JSON.stringify(e)).join(', ')})`,
    );
  }

  const transition = TRANSITIONS[event];
  if (current.quest !== transition.from) {
    throw new InvalidSaveError(
      `illegal quest transition: event ${JSON.stringify(event)} requires stage ${JSON.stringify(transition.from)}, but the game is at ${JSON.stringify(current.quest)}`,
    );
  }

  return transition.apply(current);
}

const OBJECTIVES: Record<QuestStage, string> = {
  new: 'Speak with Mara in the Hearthwick square about the dark lantern road.',
  accepted: 'Leave by the east gate, cross Brackenwood, and take a rubbing of the route stone in Ashwatch Ruin.',
  'clue-found': 'Settle the stone warden: when it stops after a lunge, get close and hold up the rubbing.',
  'guardian-defeated': 'Light the hilltop lantern at the old shrine.',
  'lantern-lit': 'Return to Mara in Hearthwick and tell her the light is back.',
  complete:
    'The lantern road glows again. Explore Hearthwick, Brackenwood, and the ruin at your own pace.',
};

export function questObjective(stage: QuestStage): string {
  if (typeof stage !== 'string' || !(QUEST_STAGES as readonly string[]).includes(stage)) {
    throw new InvalidSaveError(
      `unknown quest stage ${describe(stage)} (expected one of ${QUEST_STAGES.map((s) => JSON.stringify(s)).join(', ')})`,
    );
  }
  return OBJECTIVES[stage];
}

/**
 * Demo-only defeat/recovery rule: the player returns to the Hearthwick spawn
 * and recovers full demo health and mana. Quest stage, inventory, discoveries,
 * defeated enemies, and play time are kept, so story progress survives defeat.
 *
 * This is a placeholder for milestone 2. Real imported-Habitica health
 * reconciliation and a final recovery rule are deferred; see
 * docs/runtime-contract.md.
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
