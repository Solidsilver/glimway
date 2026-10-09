/**
 * The predictor (design server-first 2.4, "What the game shows"): the newest
 * server `PlayerState` this client adopted, with its unanswered operations
 * applied on top by each operation's predict function.
 *
 * A predictor may be wrong; a rule may not. Everything here is a copy of a
 * server rule kept only to draw the game before the answer comes: when the
 * copy is wrong the server refuses or clamps and the prediction rolls back.
 * No network, no storage.
 */
import { toJson } from '@bufbuild/protobuf';
import { HabiticaProfileSchema } from '../gen/glimway/v1/profile_pb.js';
import type { PlayerState } from '../gen/glimway/v1/state_pb.js';
import type { HomeView } from './homestead.ts';
import { validateHabiticaProfile } from '../habitica/mapping.ts';
import type { HabiticaProfile } from '../habitica/types.ts';
import { profileFor } from '../profile.ts';
import { reachStep } from '../quests.ts';
import { createNewGame, validateSave, type GameState } from '../state.ts';

/** Marks that hold discoveries and curated defeats (design 2.2, `content/story.json`). */
export const FOUND = 'found:';
export const DEFEATED = 'defeated:';

/**
 * Mark namespaces the client may write (`client` in `content/story.json`).
 * Everything else is server-written and only ever arrives in a state.
 */
const CLIENT_PREFIXES = ['seen:', 'met:', 'heard:', 'guide:', 'nudge:', 'unmoored:', FOUND, DEFEATED];
const CLIENT_MARKS = ['home:met-silas', 'home:arrived'];

export function isClientMark(mark: string): boolean {
  return CLIENT_MARKS.includes(mark) || CLIENT_PREFIXES.some((p) => mark.startsWith(p) && mark.length > p.length);
}

const VILLAGE_SPAWN = { x: 400, y: 300 };

/** Wilds places name their region: `wilds:inner-1`, `wilds:outer-1`. */
const WILDS_PLACE = /^wilds:([A-Za-z0-9_-]{1,64})$/;

/** A server place's area as the game keeps it (`wilds` plus the region marker). */
export function areaOfPlace(area: string): { area: string; wildsRegion?: string } {
  const m = WILDS_PLACE.exec(area);
  if (m) return m[1] === 'inner-1' ? { area: 'wilds' } : { area: 'wilds', wildsRegion: m[1] };
  return { area };
}

/** The `where.area` for the game's place. */
export function placeArea(state: Pick<GameState, 'area' | 'wildsRegion'>): string {
  return state.area === 'wilds' ? `wilds:${state.wildsRegion ?? 'inner-1'}` : state.area;
}

/** `Where` as ProtoJSON, rounded to whole pixels. */
export interface WhereJson {
  area: string;
  x: number;
  y: number;
}

export function whereOf(state: Pick<GameState, 'area' | 'wildsRegion' | 'position'>): WhereJson {
  return { area: placeArea(state), x: Math.round(state.position.x), y: Math.round(state.position.y) };
}

export function profileOf(p: PlayerState): HabiticaProfile | null {
  if (!p.profile || p.account?.profileSource !== 'habitica') return null;
  return profileFor({ profileSource: 'habitica', profile: validateHabiticaProfile(toJson(HabiticaProfileSchema, p.profile, { alwaysEmitImplicit: true })) });
}

/**
 * The game's state for a server `PlayerState`. Marks are the single source:
 * `found:` marks are the discoveries, `defeated:` marks the curated defeats,
 * the rest are flags.
 */
export function gameStateOf(p: PlayerState): GameState {
  const { place, vitals, story, embers } = p;
  if (!place || !vitals || !story || !embers) throw new Error('incomplete state');
  const flags: string[] = [];
  const discoveries: string[] = [];
  const defeatedEnemies: string[] = [];
  for (const mark of story.marks) {
    if (mark.startsWith(FOUND)) discoveries.push(mark.slice(FOUND.length));
    else if (mark.startsWith(DEFEATED)) defeatedEnemies.push(mark.slice(DEFEATED.length));
    else flags.push(mark);
  }
  // When each quest last reached a gated step (or its first): waits count from it.
  const gateAt = story.gateAt;
  // A place this build can't draw never stops the load: the hero wakes at the village spawn.
  let at: { area: string; wildsRegion?: string; position: { x: number; y: number } } = { ...areaOfPlace(place.area), position: { x: place.x, y: place.y } };
  try {
    validateSave({ ...createNewGame(), ...at });
  } catch {
    console.warn('[glimway] a place this build doesn\u2019t know', place.area);
    at = { area: 'village', position: { ...VILLAGE_SPAWN } };
  }
  return validateSave({
    ...createNewGame(),
    ...at,
    quests: { ...story.quests },
    ...(Object.keys(gateAt).length ? { questGateAt: { ...gateAt } } : {}),
    ...(Object.keys(story.reachedAt).length ? { questReachedAt: { ...story.reachedAt } } : {}),
    hp: vitals.hp,
    maxHp: vitals.maxHp,
    mana: vitals.mana,
    maxMana: vitals.maxMana,
    inventory: [...story.questItems],
    flags,
    discoveries,
    defeatedEnemies,
    playSeconds: story.playSeconds,
    embers: embers.balance,
    xpEmbers: embers.xpEarned,
    emberXp: embers.xpMark,
    ...(place.outerEpoch ? { outerEpoch: place.outerEpoch } : {}),
  });
}

/** Adopt only at an equal or higher version (2.4). */
export function adoptable(held: PlayerState | null, next: PlayerState): boolean {
  return !held || next.version >= held.version;
}

/** What an unanswered operation does to the game's state until its answer. */
export type Prediction =
  | { kind: 'quest-step'; quest: string; to: string }
  | { kind: 'mark'; mark: string }
  | { kind: 'take-paper'; paper: string }
  | { kind: 'settle-echo'; member: string }
  | { kind: 'fall' }
  // Companions and the stable (crafts.md 6.2): they change `PlayerState.companions`, not the game state (`predictCompanions`).
  | { kind: 'companions'; followPet: string; yardPets: string[] }
  | { kind: 'mount-home' }
  | { kind: 'none' };

export interface PredictContext {
  profile: HabiticaProfile | null;
  /** The clock a predicted gate time is stamped with (Unix seconds; defaults to the device's). */
  now?: number;
}

/** `content/vitals.json` fall recovery (B): a quarter of max HP, half of max mana, rounded up. */
const FALL_HP = 0.25;
const FALL_MANA = 0.5;

/** The fall's recovery (design 2.2, "Falls"): a 0-HP baseline stays at 0. */
export function fallRecovery(state: Pick<GameState, 'maxHp' | 'maxMana'>, profile: HabiticaProfile | null): { hp: number; mana: number } {
  const baseHp = profile ? profile.hp : state.maxHp;
  const baseMp = profile ? profile.mp : state.maxMana;
  return {
    hp: Math.max(0, Math.min(baseHp, Math.ceil(state.maxHp * FALL_HP))),
    mana: Math.max(0, Math.min(baseMp, Math.ceil(state.maxMana * FALL_MANA))),
  };
}

const unique = (list: string[], item: string): string[] => (list.includes(item) ? list : [...list, item]);

/** One predict function per operation. Unknown or unpredictable operations change nothing. */
export function predict(state: GameState, op: Prediction, ctx: PredictContext): GameState {
  switch (op.kind) {
    case 'quest-step':
      // Not the next step from here: the answer decides.
      return reachStep(state, op.quest, op.to, ctx.now ?? Math.floor(Date.now() / 1000)) ?? state;
    case 'mark':
      if (op.mark.startsWith(FOUND)) return { ...state, discoveries: unique(state.discoveries, op.mark.slice(FOUND.length)) };
      if (op.mark.startsWith(DEFEATED)) return { ...state, defeatedEnemies: unique(state.defeatedEnemies, op.mark.slice(DEFEATED.length)) };
      return { ...state, flags: unique(state.flags, op.mark) };
    case 'take-paper':
      return { ...state, flags: unique(state.flags, `paper:${op.paper}`) };
    case 'settle-echo':
      return { ...state, flags: unique(state.flags, `echo:${op.member}`) };
    case 'fall':
      return { ...state, ...fallRecovery(state, ctx.profile), area: 'village', position: { ...VILLAGE_SPAWN }, wildsRegion: undefined };
    case 'companions':
    case 'mount-home':
    case 'none':
      return state;
  }
}

/** `server` with `pending` applied in order. */
export function predictedView(server: PlayerState, pending: readonly Prediction[], ctx: PredictContext): GameState {
  let state = gameStateOf(server);
  for (const op of pending) state = predict(state, op, ctx);
  if (state.wildsRegion === undefined) delete state.wildsRegion;
  return state;
}

// ------------------------------------------------------------ companions and the stable

/** The companions the game shows: the server's resolved ones, with unanswered choices on top. */
export interface CompanionsView {
  /** '' is Habitica's current pet. */
  followPet: string;
  yardPets: string[];
  /** '' when every mount is in its stall. */
  mountOut: string;
  mountHome: string;
}

/**
 * `server.companions` with `pending` applied in order (crafts.md 2.4, 3.4).
 * A choice shows at once; the answer (or a refusal) replaces it.
 */
export function predictCompanions(server: PlayerState | null, pending: readonly Prediction[]): CompanionsView {
  const c = server?.companions;
  let view: CompanionsView = { followPet: c?.followPet ?? '', yardPets: [...(c?.yardPets ?? [])], mountOut: c?.mountOut ?? '', mountHome: c?.mountHome ?? '' };
  for (const op of pending) {
    if (op.kind === 'companions') view = { ...view, followPet: op.followPet, yardPets: [...op.yardPets] };
    else if (op.kind === 'mount-home') view = { ...view, mountOut: '' };
  }
  return view;
}

/**
 * A stall shown with its new mount before the answer (`stall`, crafts.md
 * 6.2): the same mount moves out of any other stall of yours rather than
 * standing twice, and '' empties it. A stall that isn't yours to change is
 * left alone (the server will refuse it).
 */
export function predictStall(home: HomeView, stall: number, mount: string, owner: { id: string; name: string }): HomeView {
  const at = home.stalls.find((s) => s.stall === stall);
  if (at && at.mount && at.ownerId !== owner.id) return home;
  const empty = (s: HomeView['stalls'][number]) => ({ ...s, mount: '', ownerId: '', ownerName: '', out: false });
  const stalls = home.stalls.map((s) => {
    if (s.stall === stall) return mount ? { ...s, mount, ownerId: owner.id, ownerName: owner.name, out: false } : empty(s);
    return mount && s.ownerId === owner.id && s.mount === mount ? empty(s) : s;
  });
  if (!at) stalls.push(mount ? { stall, mount, ownerId: owner.id, ownerName: owner.name, out: false } : { stall, mount: '', ownerId: '', ownerName: '', out: false });
  stalls.sort((a, b) => a.stall - b.stall);
  return { ...home, stalls };
}

/** One more bay on the stable (`stable-extend`), up to `max`. */
export function predictStableExtend(home: HomeView, stableItem: string, max: number): HomeView {
  return {
    ...home,
    items: home.items.map((it) => (it.itemDef === stableItem && it.scene === 'outdoor' && (it.stalls ?? 1) < max ? { ...it, stalls: (it.stalls ?? 1) + 1 } : it)),
    stalls: grown(home, stableItem, max),
  };
}

/** The bays with one more, empty, at the east end (when the stable can grow). */
function grown(home: HomeView, stableItem: string, max: number): HomeView['stalls'] {
  const stable = home.items.find((it) => it.itemDef === stableItem && it.scene === 'outdoor');
  const n = stable?.stalls ?? 1;
  if (!stable || n >= max || home.stalls.some((s) => s.stall === n + 1)) return home.stalls;
  return [...home.stalls, { stall: n + 1, mount: '', ownerId: '', ownerName: '', out: false }];
}
