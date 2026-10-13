/**
 * Minimal in-memory IndexedDB stand-in for Node tests. Implements only the
 * surface src/lib/save.ts uses: open with versioned upgrade, object store
 * creation keyed by `id`, and get/getAll/put/delete requests with async success
 * handlers. Data persists across open/close within a process so reload
 * behavior can be tested; call resetFakeIndexedDB() between tests.
 */

type AnyHandler = ((ev: { target: unknown }) => void) | null;

class FakeRequest<T> {
  result!: T;
  error: unknown = null;
  onsuccess: AnyHandler = null;
  onerror: AnyHandler = null;
  onupgradeneeded: AnyHandler = null;
  onblocked: AnyHandler = null;
}

function fireSuccess(request: FakeRequest<unknown>): void {
  queueMicrotask(() => {
    if (request.onsuccess) request.onsuccess({ target: request });
  });
}

interface FakeStore {
  name: string;
  data: Map<string, unknown>;
}

interface FakeDatabase {
  name: string;
  version: number;
  stores: Map<string, FakeStore>;
  closed: boolean;
}

const databases = new Map<string, FakeDatabase>();
let abortNextTransaction = false

function makeOpenRequest(dbName: string, version: number): FakeRequest<unknown> {
  const request = new FakeRequest<unknown>();

  queueMicrotask(() => {
    let db = databases.get(dbName);
    const isNew = !db;
    if (!db) {
      db = { name: dbName, version, stores: new Map(), closed: false };
      databases.set(dbName, db);
    }
    const needsUpgrade = isNew || version > db.version;
    if (needsUpgrade) {
      db.version = version;
      const handle = makeDatabaseHandle(db);
      (request as FakeRequest<unknown>).result = handle;
      if (request.onupgradeneeded) request.onupgradeneeded({ target: request });
    }
    (request as FakeRequest<unknown>).result = makeDatabaseHandle(db);
    fireSuccess(request);
  });

  return request;
}

function makeDatabaseHandle(db: FakeDatabase): Record<string, unknown> {
  return {
    get objectStoreNames() {
      return {
        contains: (name: string) => db.stores.has(name),
      };
    },
    createObjectStore(name: string, _options?: unknown) {
      if (!db.stores.has(name)) {
        db.stores.set(name, { name, data: new Map() });
      }
      return makeStoreHandle(db, name);
    },
    transaction(_names: unknown, _mode?: string) {
      const tx: Record<string, unknown> = {
        commit: [] as (() => void)[],
        objectStore: (name: string) => {
          const store = db.stores.get(name);
          if (!store) {
            throw new Error(`FakeIndexedDB: no object store ${JSON.stringify(name)}`);
          }
          return makeStoreHandle(db, name, tx);
        },
      };
      return tx
    },
    close() {
      db.closed = true;
    },
  };
}

function makeStoreHandle(db: FakeDatabase, name: string, tx?: Record<string, unknown>): Record<string, unknown> {
  const store = db.stores.get(name);
  if (!store) {
    throw new Error(`FakeIndexedDB: no object store ${JSON.stringify(name)}`);
  }
  return {
    get(key: string) {
      const request = new FakeRequest<unknown>();
      queueMicrotask(() => {
        request.result = store.data.has(key) ? store.data.get(key) : undefined;
        fireSuccess(request);
        finishTransaction(tx)
      });
      return request;
    },
    put(value: { id?: string }) {
      const request = new FakeRequest<unknown>();
      queueMicrotask(() => {
        const key = value.id;
        if (typeof key !== 'string') {
          request.error = new Error('FakeIndexedDB: put() value needs a string id');
          if (request.onerror) request.onerror({ target: request });
          return;
        }
        ;(tx?.commit as (() => void)[] | undefined)?.push(() => store.data.set(key, value))
        request.result = key;
        fireSuccess(request);
        finishTransaction(tx)
      });
      return request;
    },
    getAll() {
      const request = new FakeRequest<unknown>();
      queueMicrotask(() => {
        request.result = [...store.data.values()];
        fireSuccess(request);
      });
      return request;
    },
    delete(key: string) {
      const request = new FakeRequest<unknown>();
      queueMicrotask(() => {
        ;(tx?.commit as (() => void)[] | undefined)?.push(() => store.data.delete(key))
        fireSuccess(request);
        finishTransaction(tx)
      });
      return request;
    },
  };
}

function finishTransaction(tx?: Record<string, unknown>): void {
  if (!tx) return
  const event = abortNextTransaction ? 'onabort' : 'oncomplete'
  abortNextTransaction = false
  queueMicrotask(() => {
    if (event === 'oncomplete') for (const commit of tx.commit as (() => void)[]) commit()
    ;(tx[event] as ((ev: { target: unknown }) => void) | null)?.({ target: tx })
  })
}

export function installFakeIndexedDB(): void {
  (globalThis as { indexedDB?: unknown }).indexedDB = {
    open: (name: string, version: number) => makeOpenRequest(name, version),
  };
}

export function resetFakeIndexedDB(): void {
  databases.clear();
  abortNextTransaction = false
}

/** Make the next object-store request succeed, then abort its transaction. */
export function abortNextFakeTransaction(): void { abortNextTransaction = true }

/**
 * Writes a raw record straight into the store, bypassing saveGame validation.
 * Tests use this to create corrupt saves.
 */
export function seedRawRecord(
  dbName: string,
  storeName: string,
  record: { id: string; [k: string]: unknown },
): void {
  let db = databases.get(dbName);
  if (!db) {
    db = { name: dbName, version: 1, stores: new Map(), closed: false };
    databases.set(dbName, db);
  }
  let store = db.stores.get(storeName);
  if (!store) {
    store = { name: storeName, data: new Map() };
    db.stores.set(storeName, store);
  }
  store.data.set(record.id, record);
}

export function readRawRecord(
  dbName: string,
  storeName: string,
  id: string,
): unknown {
  return databases.get(dbName)?.stores.get(storeName)?.data.get(id);
}
