/**
 * Local cache of the connected save (design: "Offline connected play").
 * Kept in its own IndexedDB database, apart from the guest save, so connected
 * play never touches the device's guest journey.
 *
 * Two kinds of record, both in one store keyed by `id`:
 * - `acct:<habiticaId>`, one per account: the state with the revision it was
 *   based on, the lease and clientId, unsent-change flags, the recovery copy.
 *   Keyed by account so a second account on this browser can never overwrite
 *   the first one's unsent progress.
 * - `orphan:<habiticaId>:<clientId>`: unsent progress from a tab that lost
 *   the lease to another tab. It is never this tab's to upload as current;
 *   the next lease holder uploads it as a stale write (story merges only) and
 *   deletes it, so story made in the takeover window is not lost.
 *
 * No credentials ever go in here. Storage failures are reported, not thrown:
 * the server copy is the durable one.
 */
import { validateSave, type GameState } from '../state.ts';
import { validateHabiticaProfile } from '../habitica/mapping.ts';
import type { HabiticaProfile, VitalsSource } from '../habitica/types.ts';

const DB_NAME = 'fingersnap-connected';
const DB_VERSION = 2;
const STORE = 'records';
/** Version 1 kept a single out-of-line record under this store/key. */
const LEGACY_STORE = 'connected';

export interface ConnectedCache {
  habiticaId: string;
  name: string;
  state: GameState;
  vitalsSource: VitalsSource;
  importedProfile?: HabiticaProfile;
  /** The server revision `state` was based on. */
  rev: number;
  lease: string | null;
  clientId: string;
  /** Local changes the server hasn't accepted yet. */
  dirty: boolean;
  /** Set while the device plays without the server. */
  offline: boolean;
  /** Changes were made while offline (drives the reconnect notice). */
  offlineProgress: boolean;
  /** The last upload sent: if its answer was lost, a reconnect can tell it landed. */
  sent?: { rev: number; key: string };
  /** The player logged out with unsent progress: kept for their next sign-in only. */
  loggedOut?: boolean;
  /** The account's world (seeds homestead land offline). */
  worldId?: string;
  /** The offline copy that a reconnect merged into newer server progress. */
  recovery?: { state: GameState; savedAt: number };
  /** A keyed mutation whose answer was lost: resolved by exact replay (game/link.ts). */
  unresolved?: { op: unknown; body: Record<string, unknown>; at: number };
  savedAt: number;
}

export interface OrphanCopy {
  habiticaId: string;
  clientId: string;
  state: GameState;
  rev: number;
  savedAt: number;
}

const accountKey = (habiticaId: string) => `acct:${habiticaId}`;
const orphanKey = (habiticaId: string, clientId: string) => `orphan:${habiticaId}:${clientId}`;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) {
      reject(new Error('IndexedDB is not available.'));
      return;
    }
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      // Carry a version-1 record over to its account key.
      if (db.objectStoreNames.contains(LEGACY_STORE)) {
        try {
          const tx = req.transaction!;
          const get = tx.objectStore(LEGACY_STORE).get('current');
          get.onsuccess = () => {
            const old = normalizeCache(get.result);
            if (old) tx.objectStore(STORE).put({ ...old, id: accountKey(old.habiticaId) });
            db.deleteObjectStore(LEGACY_STORE);
          };
        } catch {
          /* nothing to carry */
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the connected cache.'));
    req.onblocked = () => reject(new Error('The connected cache is blocked by another tab.'));
  });
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });
}

let chain: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const run = chain.then(task, task);
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Run against the store; any storage failure becomes `fallback`. */
function withStore<T>(mode: IDBTransactionMode, fallback: T, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> {
  return serial(async () => {
    try {
      const db = await open();
      try {
        return await fn(db.transaction(STORE, mode).objectStore(STORE));
      } finally {
        db.close();
      }
    } catch {
      return fallback;
    }
  });
}

/** Validate a stored record; anything unreadable counts as no cache. */
export function normalizeCache(raw: unknown): ConnectedCache | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  try {
    if (typeof r.habiticaId !== 'string' || typeof r.clientId !== 'string') return null;
    if (typeof r.rev !== 'number' || !Number.isInteger(r.rev) || r.rev < 0) return null;
    const out: ConnectedCache = {
      habiticaId: r.habiticaId,
      name: typeof r.name === 'string' ? r.name : '',
      state: validateSave(r.state),
      vitalsSource: r.vitalsSource === 'imported' ? 'imported' : 'demo',
      rev: r.rev,
      lease: typeof r.lease === 'string' ? r.lease : null,
      clientId: r.clientId,
      dirty: r.dirty === true,
      offline: r.offline === true,
      offlineProgress: r.offlineProgress === true,
      savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0,
    };
    if (r.loggedOut === true) out.loggedOut = true;
    if (typeof r.worldId === 'string' && r.worldId.length > 0 && r.worldId.length <= 128) out.worldId = r.worldId;
    const sent = r.sent as { rev?: unknown; key?: unknown } | undefined;
    if (sent && typeof sent === 'object' && typeof sent.rev === 'number' && Number.isInteger(sent.rev) && typeof sent.key === 'string') {
      out.sent = { rev: sent.rev, key: sent.key };
    }
    if (r.importedProfile != null) out.importedProfile = validateHabiticaProfile(r.importedProfile);
    const unresolved = normalizeUnresolved(r.unresolved);
    if (unresolved) out.unresolved = unresolved;
    const rec = r.recovery as { state?: unknown; savedAt?: unknown } | undefined;
    if (rec && typeof rec === 'object') {
      out.recovery = { state: validateSave(rec.state), savedAt: typeof rec.savedAt === 'number' ? rec.savedAt : 0 };
    }
    return out;
  } catch {
    return null;
  }
}

const MUTATION_KINDS = ['home', 'storage', 'craft', 'mail-send', 'mail-claim', 'mail-recall', 'contribute', 'items'];
const ITEM_OPS = ['use', 'repair', 'fit', 'unfit', 'give', 'pocket', 'offhand', 'pickup'];
const HOME_OPS = ['buy', 'place', 'move', 'remove', 'upgrade', 'claim', 'clear', 'invite', 'joint', 'leave'];

/**
 * A lost mutation's exact request (game/link.ts `Unresolved`), kept so the
 * next page replays it rather than paying twice. Malformed records are dropped.
 */
export function normalizeUnresolved(raw: unknown): ConnectedCache['unresolved'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as { op?: Record<string, unknown>; body?: Record<string, unknown>; at?: unknown };
  const op = u.op;
  const body = u.body;
  if (!op || typeof op !== 'object' || !body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  if (!MUTATION_KINDS.includes(op.kind as string)) return undefined;
  if (op.kind === 'home' && !HOME_OPS.includes(op.op as string)) return undefined;
  if (op.kind === 'items' && !ITEM_OPS.includes(op.op as string)) return undefined;
  if (['mail-claim', 'mail-recall', 'contribute'].includes(op.kind as string) && (typeof op.id !== 'string' || !op.id)) return undefined;
  if (op.fields !== undefined && (typeof op.fields !== 'object' || op.fields === null || Array.isArray(op.fields))) return undefined;
  if (typeof body.key !== 'string' || !body.key || !Number.isInteger(body.baseRev)) return undefined;
  return { op: structuredClone(op), body: structuredClone(body), at: typeof u.at === 'number' ? u.at : 0 };
}

export function normalizeOrphan(raw: unknown): OrphanCopy | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  try {
    if (typeof r.habiticaId !== 'string' || typeof r.clientId !== 'string') return null;
    if (typeof r.rev !== 'number' || !Number.isInteger(r.rev) || r.rev < 0) return null;
    return {
      habiticaId: r.habiticaId,
      clientId: r.clientId,
      state: validateSave(r.state),
      rev: r.rev,
      savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0,
    };
  } catch {
    return null;
  }
}

/** The account's record, or null. */
export function loadCache(habiticaId: string): Promise<ConnectedCache | null> {
  return withStore('readonly', null, async (store) => normalizeCache(await done(store.get(accountKey(habiticaId)))));
}

/**
 * The most recently saved account record (offline start, when no server can
 * say who is signed in). Records kept after a logout are skipped.
 */
export function loadLatestCache(): Promise<ConnectedCache | null> {
  return withStore('readonly', null, async (store) => {
    const all = (await done(store.getAll())) as Array<Record<string, unknown>>;
    let best: ConnectedCache | null = null;
    for (const raw of all) {
      if (typeof raw?.id !== 'string' || !raw.id.startsWith('acct:')) continue;
      const rec = normalizeCache(raw);
      if (rec && !rec.loggedOut && (!best || rec.savedAt > best.savedAt)) best = rec;
    }
    return best;
  });
}

export function saveCache(record: ConnectedCache): Promise<boolean> {
  return withStore('readwrite', false, async (store) => {
    const clean = normalizeCache({ ...record, savedAt: Date.now() });
    if (!clean) return false;
    await done(store.put({ ...clean, id: accountKey(clean.habiticaId) }));
    return true;
  });
}

export function clearCache(habiticaId: string): Promise<boolean> {
  return withStore('readwrite', false, async (store) => {
    await done(store.delete(accountKey(habiticaId)));
    return true;
  });
}

export function saveOrphan(orphan: OrphanCopy): Promise<boolean> {
  return withStore('readwrite', false, async (store) => {
    const clean = normalizeOrphan({ ...orphan, savedAt: Date.now() });
    if (!clean) return false;
    await done(store.put({ ...clean, id: orphanKey(clean.habiticaId, clean.clientId) }));
    return true;
  });
}

export function loadOrphans(habiticaId: string): Promise<OrphanCopy[]> {
  return withStore('readonly', [] as OrphanCopy[], async (store) => {
    const all = (await done(store.getAll())) as Array<Record<string, unknown>>;
    const prefix = `orphan:${habiticaId}:`;
    return all
      .filter((raw) => typeof raw?.id === 'string' && raw.id.startsWith(prefix))
      .map(normalizeOrphan)
      .filter((o): o is OrphanCopy => o !== null);
  });
}

export function deleteOrphan(habiticaId: string, clientId: string): Promise<boolean> {
  return withStore('readwrite', false, async (store) => {
    await done(store.delete(orphanKey(habiticaId, clientId)));
    return true;
  });
}

/** The store surface the Link uses (injectable for tests). */
export interface LinkStore {
  save(record: ConnectedCache): Promise<boolean>;
  saveOrphan(orphan: OrphanCopy): Promise<boolean>;
  loadOrphans(habiticaId: string): Promise<OrphanCopy[]>;
  deleteOrphan(habiticaId: string, clientId: string): Promise<boolean>;
}

export const idbLinkStore: LinkStore = { save: saveCache, saveOrphan, loadOrphans, deleteOrphan };
