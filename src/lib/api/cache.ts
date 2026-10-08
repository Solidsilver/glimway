/**
 * The connected cache, reshaped (design server-first 2.4): what the title
 * screen and the account flow read about this device's play, projected from
 * the account's outbox (src/lib/api/outbox.ts). Only the outbox's owner (the
 * link holding it) writes it; this module only reads it, marks it kept after
 * a logout, or clears a record with nothing unsent in it.
 *
 * Records of the old connected cache (`fingersnap-connected`) are a clean
 * break: they are never read.
 */
import { fromJson } from '@bufbuild/protobuf';
import { PlayerStateSchema } from '../gen/glimway/v1/state_pb.js';
import type { GameState } from '../state.ts';
import { claimDeviceId } from './client.ts';
import { outboxStore as outbox, type OutboxRecord } from './outbox.ts';
import { gameStateOf } from './predict.ts';

export interface ConnectedCache {
  accountId: string;
  name: string;
  /** The last state this device adopted, for the title's journey line. */
  state: GameState;
  /** Unanswered operations wait in the outbox. */
  dirty: boolean;
  /** Logged out with unsent work kept for this account's next sign-in. */
  loggedOut?: boolean;
  worldId?: string;
  savedAt: number;
}

function device(): string | null {
  try {
    return claimDeviceId();
  } catch {
    return null;
  }
}

function project(record: OutboxRecord | null): ConnectedCache | null {
  if (!record?.server) return null;
  try {
    const state = gameStateOf(fromJson(PlayerStateSchema, record.server, { ignoreUnknownFields: true }));
    return { accountId: record.account, name: record.name, state, dirty: record.entries.length > 0, savedAt: record.savedAt, ...(record.loggedOut ? { loggedOut: true } : {}), ...(record.worldId ? { worldId: record.worldId } : {}) };
  } catch {
    return null;
  }
}

/** The account's record on this device, or null. */
export async function loadCache(accountId: string): Promise<ConnectedCache | null> {
  const d = device();
  return d ? project(await outbox().load(accountId, d)) : null;
}

/** The most recently played account on this device (offline start). Records kept after a logout are skipped. */
export async function loadLatestCache(): Promise<ConnectedCache | null> {
  const d = device();
  return d ? project(await outbox().latest(d)) : null;
}

/** Only the logout mark is written through here: the outbox's owner writes everything else. */
export async function saveCache(cache: ConnectedCache): Promise<boolean> {
  const d = device();
  return d ? outbox().markLoggedOut(cache.accountId, d, cache.loggedOut === true) : false;
}

/** Forget the account on this device, but never unsent work: a record still holding operations stays. */
export async function clearCache(accountId: string): Promise<boolean> {
  const d = device();
  return d ? outbox().clearIfEmpty(accountId, d) : false;
}
