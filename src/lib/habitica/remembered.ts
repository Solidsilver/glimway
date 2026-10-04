/**
 * Opt-in "Remember on this device" store for the Habitica User ID + token.
 *
 * Lives in its OWN IndexedDB database, never the `fingersnap` save database,
 * so no save, export or restore path can reach it (see
 * docs/import-contract.md, "Security invariants"). Only ever called by the
 * connect UI; nothing here logs, throws token material, or touches GameState.
 *
 * Every function swallows storage failures (private browsing, blocked
 * IndexedDB): the game works without it, and the caller gets `false` / `null`.
 * The backend is injectable for tests.
 */

export interface RememberedCredentials {
  userId: string
  apiToken: string
}

export interface RememberedBackend {
  read(): Promise<unknown>
  write(value: RememberedCredentials): Promise<void>
  remove(): Promise<void>
}

export const REMEMBER_DB = 'fingersnap-credentials'
const STORE = 'credentials'
const KEY = 'habitica'

function idbBackend(): RememberedBackend {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB
      if (!factory) return reject(new Error('indexeddb-unavailable'))
      const req = factory.open(REMEMBER_DB, 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' })
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(new Error('indexeddb-open-failed'))
      req.onblocked = () => reject(new Error('indexeddb-blocked'))
    })

  const run = async <T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open()
    try {
      return await new Promise<T>((resolve, reject) => {
        const req = op(db.transaction(STORE, mode).objectStore(STORE))
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => reject(new Error('indexeddb-request-failed'))
      })
    } finally {
      db.close()
    }
  }

  return {
    read: () => run('readonly', (s) => s.get(KEY)),
    write: async (v) => {
      await run('readwrite', (s) => s.put({ id: KEY, userId: v.userId, apiToken: v.apiToken }))
    },
    remove: async () => {
      await run('readwrite', (s) => s.delete(KEY))
    }
  }
}

let backend: RememberedBackend | null = null

/** Test hook: swap the storage backend (pass null to restore IndexedDB). */
export function setRememberedBackend(b: RememberedBackend | null): void {
  backend = b
}

const store = (): RememberedBackend => (backend ??= idbBackend())

/** The stored credentials, or null if none / unreadable / malformed. */
export async function loadRemembered(): Promise<RememberedCredentials | null> {
  try {
    const rec = (await store().read()) as { userId?: unknown; apiToken?: unknown } | undefined | null
    if (rec && typeof rec.userId === 'string' && typeof rec.apiToken === 'string' && rec.userId && rec.apiToken) {
      return { userId: rec.userId, apiToken: rec.apiToken }
    }
  } catch {
    /* storage unavailable: behave as "nothing remembered" */
  }
  return null
}

/** True if stored. False means it could NOT be stored (tell the player). */
export async function saveRemembered(creds: RememberedCredentials): Promise<boolean> {
  try {
    await store().write({ userId: creds.userId, apiToken: creds.apiToken })
    return true
  } catch {
    return false
  }
}

/** True if nothing remains stored afterwards. */
export async function forgetRemembered(): Promise<boolean> {
  try {
    await store().remove()
    return true
  } catch {
    return false
  }
}
