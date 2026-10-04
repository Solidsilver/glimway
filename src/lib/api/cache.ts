/**
 * Local cache of the connected save (design: "Offline connected play").
 * Kept in its own IndexedDB database, apart from the guest save, so connected
 * play never touches the device's guest journey. Holds the state with the
 * revision it was based on, the lease and the tab's clientId, whether it has
 * changes the server hasn't seen, and the recovery copy kept after an offline
 * reconnect merged into newer server progress.
 *
 * No credentials ever go in here. Storage failures are reported, not thrown:
 * the server copy is the durable one.
 */
import { validateSave, type GameState } from '../state.ts';
import { validateHabiticaProfile } from '../habitica/mapping.ts';
import type { HabiticaProfile, VitalsSource } from '../habitica/types.ts';

const DB_NAME = 'fingersnap-connected';
const STORE = 'connected';
const KEY = 'current';

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
  /** The offline copy that a reconnect merged into newer server progress. */
  recovery?: { state: GameState; savedAt: number };
  savedAt: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) {
      reject(new Error('IndexedDB is not available.'));
      return;
    }
    const req = factory.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
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
      savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0,
    };
    if (r.importedProfile != null) out.importedProfile = validateHabiticaProfile(r.importedProfile);
    const rec = r.recovery as { state?: unknown; savedAt?: unknown } | undefined;
    if (rec && typeof rec === 'object') {
      out.recovery = { state: validateSave(rec.state), savedAt: typeof rec.savedAt === 'number' ? rec.savedAt : 0 };
    }
    return out;
  } catch {
    return null;
  }
}

export function loadCache(): Promise<ConnectedCache | null> {
  return serial(async () => {
    try {
      const db = await open();
      try {
        return normalizeCache(await done(db.transaction(STORE).objectStore(STORE).get(KEY)));
      } finally {
        db.close();
      }
    } catch {
      return null;
    }
  });
}

export function saveCache(record: ConnectedCache): Promise<boolean> {
  return serial(async () => {
    try {
      const clean = normalizeCache({ ...record, savedAt: Date.now() });
      if (!clean) return false;
      const db = await open();
      try {
        await done(db.transaction(STORE, 'readwrite').objectStore(STORE).put(clean, KEY));
        return true;
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  });
}

export function clearCache(): Promise<boolean> {
  return serial(async () => {
    try {
      const db = await open();
      try {
        await done(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(KEY));
        return true;
      } finally {
        db.close();
      }
    } catch {
      return false;
    }
  });
}
