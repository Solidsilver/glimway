/**
 * Pure rules for the connected save (design: "The progress document" and
 * "Revisions, conflicts, and offline play"). No network, no storage.
 */
import { CHARM_ITEM, EMBER_COSTS, FLAGS, type EmberSpend } from '../embers.ts';
import { QUEST_STAGES, validateSave, type GameState, type QuestStage } from '../state.ts';
import type { ApiErrorCode } from './errors.ts';
import type { Progress } from './types.ts';

/** Quest items an upload may carry (backend whitelist). */
export const QUEST_ITEMS: readonly string[] = ['field-journal', 'hearthwick-map', 'lantern-route-rubbing', 'warden-seal'];

/** Economy flags are server-owned: welcome gift, lit lanterns, opened chests. */
export function isServerFlag(flag: string): boolean {
  return flag === FLAGS.welcome || flag.startsWith('lit:') || flag.startsWith('opened:');
}

function later(a: QuestStage, b: QuestStage): QuestStage {
  return QUEST_STAGES.indexOf(a) >= QUEST_STAGES.indexOf(b) ? a : b;
}

function union(base: readonly string[], extra: readonly string[]): string[] {
  const out = [...base];
  for (const v of extra) if (!out.includes(v)) out.push(v);
  return out;
}

/** The client-writable half of a GameState, ready to upload. */
export function toProgress(state: GameState): Progress {
  const s = validateSave(state);
  return {
    version: 1,
    area: s.area,
    position: { x: Math.round(s.position.x), y: Math.round(s.position.y) },
    quest: s.quest,
    hp: Math.max(0, Math.min(s.hp, s.maxHp)),
    mana: Math.max(0, Math.min(s.mana, s.maxMana)),
    inventory: s.inventory.filter((i) => QUEST_ITEMS.includes(i)),
    discoveries: [...s.discoveries],
    defeatedEnemies: [...s.defeatedEnemies],
    flags: s.flags.filter((f) => !isServerFlag(f)),
    playSeconds: Math.max(0, s.playSeconds),
  };
}

/**
 * What an upload of this state would change on the server: story and vitals,
 * not play time (which alone is not worth an upload).
 */
export function docKey(state: GameState): string {
  const { playSeconds: _ignored, ...rest } = toProgress(state);
  return JSON.stringify(rest);
}

/**
 * A reload or lost answer left the cache dirty with an upload already sent.
 * If the server is exactly one revision past it and holds exactly that
 * document, the upload landed: nobody else played, so the reconnect is a
 * current write, not "you played somewhere else".
 */
export function uploadLanded(sent: { rev: number; key: string } | undefined, serverRev: number, serverState: GameState): boolean {
  return !!sent && serverRev === sent.rev + 1 && docKey(serverState) === sent.key;
}

/**
 * How a server state meets the local copy:
 * - `keep-local`: a current upload was accepted. The server holds what was
 *   sent, and the local copy may have moved on while the request was out, so
 *   local vitals, area and position stay (clamped to the server's maxima).
 * - `server`: the server's vitals, area and position win: a stale upload, a
 *   sync, a spend, or a fresh load.
 *
 * Either way, server-owned fields (balances, the XP mark, maxima, economy
 * flags, purchased items) come from the server, and story progress is never
 * lost: quest takes the later stage, sets are unions, play time the maximum.
 */
export type MergeMode = 'keep-local' | 'server';

export function mergeServerState(local: GameState, server: GameState, mode: MergeMode): GameState {
  const l = validateSave(local);
  const s = validateSave(server);
  const merged: GameState = {
    ...s,
    quest: later(s.quest, l.quest),
    discoveries: union(s.discoveries, l.discoveries),
    defeatedEnemies: union(s.defeatedEnemies, l.defeatedEnemies),
    flags: union(s.flags, l.flags.filter((f) => !isServerFlag(f))),
    inventory: union(s.inventory, l.inventory.filter((i) => QUEST_ITEMS.includes(i))),
    playSeconds: Math.max(s.playSeconds, l.playSeconds),
  };
  if (mode === 'keep-local') {
    merged.area = l.area;
    merged.position = { ...l.position };
    merged.hp = Math.min(l.hp, s.maxHp);
    merged.mana = Math.min(l.mana, s.maxMana);
  }
  // Client-only Wilds markers: the region belongs to the position it was
  // saved with, so it survives only when that position does.
  delete merged.wildsRegion;
  delete merged.outerSeason;
  const samePlace = merged.area === l.area && Math.round(merged.position.x) === Math.round(l.position.x) && Math.round(merged.position.y) === Math.round(l.position.y);
  if (l.wildsRegion && samePlace) merged.wildsRegion = l.wildsRegion;
  if (l.outerSeason) merged.outerSeason = l.outerSeason;
  return validateSave(merged);
}

/**
 * Reconnecting after offline play (design steps 2 and 3). `baseRev` is the
 * revision the offline copy was based on, `serverRev` the one the lease
 * response carried.
 * - equal: nothing changed on the server, upload as a current write.
 * - lower: the server moved on, upload as a stale write (story merges only)
 *   with the original baseRev, and tell the player.
 * - higher: impossible unless the server was restored from a backup; treat
 *   it as moved on and send baseRev 0 so only story merges.
 */
export function reconnectPlan(baseRev: number, serverRev: number): { mode: 'current' | 'stale'; baseRev: number } {
  if (baseRev === serverRev) return { mode: 'current', baseRev };
  if (baseRev < serverRev) return { mode: 'stale', baseRev };
  return serverRev === 0 ? { mode: 'current', baseRev: 0 } : { mode: 'stale', baseRev: 0 };
}

/** Whether to show "you played somewhere else" after a reconnect. */
export function reconnectNotice(plan: { mode: 'current' | 'stale' }, hadOfflineProgress: boolean): boolean {
  return plan.mode === 'stale' && hadOfflineProgress;
}

/** A server-side failure (500): the world is up but having trouble. */
export function isTrouble(code: ApiErrorCode): boolean {
  return code === 'internal';
}

/**
 * Wait before the next reconnect try. No network: a steady 8 s. Server
 * trouble: back off from 8 s, doubling, up to 5 minutes, so one bad request
 * isn't resent forever at full rate.
 */
export function retryDelay(failures: number, trouble: boolean): number {
  if (!trouble) return 8_000;
  return Math.min(8_000 * 2 ** Math.max(0, failures - 1), 300_000);
}

/**
 * A spend whose answer was lost: did it happen? Compares the state before
 * the reconnect with the merged one after (outcomes for lanterns and the
 * chest; the ember balance for a rest).
 */
export function spendLanded(spend: EmberSpend, before: GameState, after: GameState): boolean {
  switch (spend.kind) {
    case 'road-lantern':
      return !before.flags.includes(FLAGS.lit(spend.id)) && after.flags.includes(FLAGS.lit(spend.id));
    case 'chest':
      return !before.flags.includes(FLAGS.chest) && after.flags.includes(FLAGS.chest);
    case 'rest':
      return restLanded(before, after, EMBER_COSTS.rest);
    case 'home-rest':
      return restLanded(before, after, EMBER_COSTS.homeRest);
  }
}

/**
 * A rest leaves no outcome flag, and another device can move the balance in
 * the meantime. So it counts as landed only if the vitals went from not full
 * to full *and* the balance dropped by at least its cost (re-review N3).
 */
function restLanded(before: GameState, after: GameState, cost: number): boolean {
  const wasFull = before.hp >= before.maxHp && before.mana >= before.maxMana;
  const isFull = after.hp >= after.maxHp && after.mana >= after.maxMana;
  return !wasFull && isFull && before.embers - after.embers >= cost;
}

/** What a failed call means for the connected session. */
export type FailureAction = 'offline' | 'superseded' | 'elsewhere' | 'reload' | 'signed-out' | 'refused';

export function failureAction(code: ApiErrorCode): FailureAction {
  switch (code) {
    case 'network':
    case 'unavailable':
    case 'internal':
      return 'offline';
    case 'superseded':
      return 'superseded';
    case 'playing-elsewhere':
      return 'elsewhere';
    case 'stale-revision':
    case 'invalid-revision':
      return 'reload';
    case 'unauthorized':
      return 'signed-out';
    default:
      return 'refused';
  }
}

/** Embers that arrived with a server state (quest gifts, sync credit). */
export function embersGained(before: GameState, after: GameState): number {
  return Math.max(0, after.embers - before.embers);
}

/** Whether a state carries progress worth migrating (vs a brand-new journey). */
export function hasProgress(state: GameState): boolean {
  return (
    state.quest !== 'new' ||
    state.embers > 0 ||
    state.discoveries.length > 0 ||
    state.defeatedEnemies.length > 0 ||
    state.playSeconds >= 30 ||
    state.inventory.includes(CHARM_ITEM)
  );
}
