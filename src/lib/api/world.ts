/**
 * The world reads and moves (GET /api/world, POST /api/world/party, prompt,
 * move, leave, notice), decoded through the generated messages
 * (world_pb.ts). Types project the generated ones onto the JSON-shaped
 * application views the game reads; the snapshot envelope is parsed by
 * parse.ts as before.
 */
import { fromJson, type JsonValue } from '@bufbuild/protobuf';
import { WorldChoiceSchema, WorldViewSchema, WorldMoveResultSchema, WorldLeaveResultSchema, type WorldRef as GeneratedWorldRef, type WorldView as GeneratedWorldView, type WorldMoveResult, type WorldLeaveResult } from '../gen/glimway/v1/world_pb.js';
import { ApiError } from './errors.ts';
import { parseSnapshot } from './parse.ts';
import type { Snapshot } from './types.ts';

type Fields<T extends { $typeName: string; $unknown?: unknown }> = Omit<T, '$typeName' | '$unknown'>;

/** A world as the server names it: its owner (none for a party's) and how many live there. */
export type WorldRef = Fields<GeneratedWorldRef>;

function worldRef(ref: GeneratedWorldRef | undefined): WorldRef | null {
  if (!ref) return null;
  const { $typeName, $unknown, ...out } = ref;
  void $typeName;
  // The display name is capped like the old parser's (and the server caps
  // the column it reads at write time).
  return { ...out, ownerName: out.ownerName.slice(0, 128) };
}

function refOrNull(raw: unknown): WorldRef | null {
  return worldRef(raw as GeneratedWorldRef | undefined);
}

/**
 * A first sign-in held for the world choice (POST /api/session, GET
 * /api/world/choice): the account is signed in, but has no world until
 * POST /api/world/choose. Everything else answers `world-choice-required`.
 */
export interface WorldChoice {
  habiticaId: string;
  displayName: string;
  /** The party's world here, and how many live there. */
  partyWorld: WorldRef | null;
  /** The party has no world here yet: choosing it opens one. */
  partyCanOpen: boolean;
  /** Let in through the party: they make no invite codes, even from a world of their own. */
  partyAdmitted: boolean;
}

/** Living in a party's world after leaving the party (GET /api/world). */
export interface WorldLeaver {
  leftAt: number;
  /** When the next sign-in moves you out (server clock); moveOutIn: seconds until then. */
  moveOutAt: number;
  moveOutIn: number;
  /** You own a world to go to (otherwise one is made for you). */
  hasOwn: boolean;
}

/** What a move would leave behind (GET /api/world). */
export interface WorldLeaving {
  /** Your homestead's gate (-1: none). */
  gate: number;
  /** You are its only member: it goes quiet after you leave. */
  last: boolean;
  /** Parcels you sent that are still on the road (recall them first). */
  outgoing: number;
  /** Parcels waiting for you (they go back to their senders). */
  incoming: number;
  /** Warden-set tools in your homestead's shared chest (they stay behind). */
  wardenTools: number;
  /** Embers a deed costs in the next world (0: your first, free). */
  deedCost: number;
}

/** GET /api/world: your world, your party's world, and when you may next move. */
export interface WorldView {
  world: WorldRef;
  isOwner: boolean;
  /** Your last sign-in reported a party. */
  inParty: boolean;
  /** You live in your party's world. */
  partyHome: boolean;
  /** Your party's world, when you live somewhere else. */
  partyWorld: WorldRef | null;
  /** Your party has no world here yet and you may open it. */
  partyCanOpen: boolean;
  /** A world you own, when you live somewhere else. */
  ownWorld: WorldRef | null;
  /** The party world's join prompt hasn't been shown yet. */
  prompt: boolean;
  leaving: WorldLeaving;
  /** When the next move is allowed (unix seconds, the server's clock; 0: now). One move a day. */
  moveOpensAt: number;
  /** Seconds until then, by the server's clock: count down from this on the device's own. */
  moveOpensIn: number;
  /** You live in a party's world and have left that party. */
  leaver: WorldLeaver | null;
  /** When the server moved you out of a party's world you'd left (0: it didn't), until noticed. */
  movedOutAt: number;
}

function message(raw: GeneratedWorldView | undefined): WorldView {
  if (!raw || !raw.world) throw new Error('missing world view');
  const leaving = raw.leaving;
  if (!leaving) throw new Error('missing leaving view');
  const gate = leaving.gate >= 0 ? leaving.gate : -1;
  return {
    world: worldRef(raw.world)!,
    isOwner: raw.isOwner,
    inParty: raw.inParty,
    partyHome: raw.partyHome,
    partyWorld: refOrNull(raw.partyWorld),
    partyCanOpen: raw.partyCanOpen,
    ownWorld: refOrNull(raw.ownWorld),
    prompt: raw.prompt,
    leaving: {
      gate,
      last: gate >= 0 && leaving.last,
      outgoing: leaving.outgoing,
      incoming: leaving.incoming,
      wardenTools: leaving.wardenTools,
      deedCost: leaving.deedCost,
    },
    moveOpensAt: raw.moveOpensAt,
    moveOpensIn: raw.moveOpensIn,
    leaver: raw.leaver ? { leftAt: raw.leaver.leftAt, moveOutAt: raw.leaver.moveOutAt, moveOutIn: raw.leaver.moveOutIn, hasOwn: raw.leaver.hasOwn } : null,
    movedOutAt: raw.movedOutAt,
  };
}

function decode<T>(read: () => T): T {
  try { return read(); } catch { throw new ApiError('bad-response'); }
}

export function parseWorld(raw: unknown): WorldView {
  return decode(() => message(fromJson(WorldViewSchema, raw as JsonValue, { ignoreUnknownFields: true })));
}

/** POST /api/world/move and POST /api/world/leave (keyed). */
export interface WorldMoveResponse extends Snapshot {
  result: { world: WorldView; from: string; leftHome: boolean; returned: number };
}

/** A held first sign-in's question, or null when the answer is something else. */
export function parseWorldChoice(raw: unknown): WorldChoice | null {
  const held = (raw as { worldChoice?: unknown } | null)?.worldChoice;
  if (held == null || typeof held !== 'object') return null;
  return decode(() => {
    const c = fromJson(WorldChoiceSchema, held as JsonValue, { ignoreUnknownFields: true });
    if (!c.habiticaId) throw new Error('missing choice');
    const choice: WorldChoice = { habiticaId: c.habiticaId, displayName: c.displayName.slice(0, 128), partyWorld: refOrNull(c.partyWorld), partyCanOpen: c.partyCanOpen, partyAdmitted: c.partyAdmitted };
    return choice;
  });
}

function moveResult(raw: WorldMoveResult | WorldLeaveResult | undefined): WorldMoveResponse['result'] {
  if (!raw) throw new Error('missing move result');
  return { world: message(raw.world), from: raw.from, leftHome: raw.leftHome, returned: raw.returned };
}

/** POST /api/world/move (keyed): the answer sits under `worldMove`. */
export function parseWorldMove(raw: unknown): WorldMoveResponse {
  return decode(() => {
    // The keyed answer carries its result under the Envelope's case name.
    const caseRaw = (raw as Record<string, unknown> | null)?.worldMove;
    if (!caseRaw || typeof caseRaw !== 'object') throw new Error('missing move result');
    return { ...parseSnapshot(raw), result: moveResult(fromJson(WorldMoveResultSchema, caseRaw as JsonValue, { ignoreUnknownFields: true })) };
  });
}

/** POST /api/world/leave (keyed): its own Envelope case, own message. */
export function parseWorldLeave(raw: unknown): WorldMoveResponse {
  return decode(() => {
    const caseRaw = (raw as Record<string, unknown> | null)?.worldLeave;
    if (!caseRaw || typeof caseRaw !== 'object') throw new Error('missing leave result');
    return { ...parseSnapshot(raw), result: moveResult(fromJson(WorldLeaveResultSchema, caseRaw as JsonValue, { ignoreUnknownFields: true })) };
  });
}
