/**
 * IndexedDB with transactions, for the outbox (src/lib/api/outbox.ts):
 * requests succeed before their transaction commits, writes become visible
 * only on `complete`, and a test can abort a transaction after its requests
 * succeeded or hold commits. Read-write transactions run one at a time, as
 * IndexedDB serializes overlapping ones across connections.
 */

type Handler = ((ev: unknown) => void) | null;

class Req<T> {
  result!: T;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

export class TxIDB {
  /** Committed data. */
  readonly data = new Map<string, unknown>();
  /** Abort this many of the next read-write transactions after their requests succeed. */
  abortNext = 0;
  /** While true, read-write transactions wait to commit until `release()`. */
  holding = false;
  /** Fail `open` (IndexedDB unavailable). */
  failOpen = false;
  commits = 0;
  private held: Array<() => void> = [];
  private writer: Promise<void> = Promise.resolve();
  private created = false;

  release(): void {
    this.holding = false;
    for (const go of this.held.splice(0)) go();
  }

  readonly factory = {
    open: (_name: string, _version: number) => {
      const req = new Req<unknown>();
      setTimeout(() => {
        if (this.failOpen) {
          req.error = new Error('blocked');
          req.onerror?.({});
          return;
        }
        const db = this.db();
        req.result = db;
        if (!this.created) {
          this.created = true;
          req.onupgradeneeded?.({});
        }
        req.onsuccess?.({});
      }, 0);
      return req as unknown as IDBOpenDBRequest;
    },
  };

  private db() {
    return {
      objectStoreNames: { contains: () => this.created },
      createObjectStore: () => ({}),
      transaction: (_store: string, mode: IDBTransactionMode) => this.transaction(mode),
      close: () => undefined,
    };
  }

  private transaction(mode: IDBTransactionMode) {
    const pending = new Map<string, unknown>();
    const deleted = new Set<string>();
    let outstanding = 0;
    let aborted = false;
    let finished = false;
    let release!: () => void;
    const done = new Promise<void>((r) => (release = r));
    // A read-write transaction waits for the one before it.
    const start = mode === 'readwrite' ? this.writer : Promise.resolve();
    if (mode === 'readwrite') this.writer = this.writer.then(() => done);
    const tx = {
      oncomplete: null as Handler,
      onabort: null as Handler,
      onerror: null as Handler,
      abort: () => {
        if (finished) return;
        aborted = true;
        finished = true;
        setTimeout(() => {
          tx.onabort?.({});
          release();
        }, 0);
      },
      objectStore: () => store,
    };
    const read = (key: string) => (deleted.has(key) ? undefined : pending.has(key) ? pending.get(key) : this.data.get(key));
    const finish = () => {
      if (finished || outstanding > 0) return;
      const commit = () => {
        if (finished) return;
        finished = true;
        if (mode === 'readwrite' && this.abortNext > 0) {
          this.abortNext -= 1;
          aborted = true;
          tx.onabort?.({});
          release();
          return;
        }
        for (const k of deleted) this.data.delete(k);
        for (const [k, v] of pending) this.data.set(k, v);
        if (mode === 'readwrite') this.commits += 1;
        tx.oncomplete?.({});
        release();
      };
      if (mode === 'readwrite' && this.holding) this.held.push(commit);
      else commit();
    };
    const request = <T>(fn: () => T) => {
      const req = new Req<T>();
      outstanding += 1;
      void start.then(() =>
        queueMicrotask(() => {
          if (aborted) return;
          req.result = fn();
          req.onsuccess?.({});
          outstanding -= 1;
          if (outstanding === 0) setTimeout(finish, 0);
        }),
      );
      return req;
    };
    const store = {
      get: (key: string) => request(() => structuredClone(read(key))),
      getAll: () => request(() => [...new Set([...this.data.keys(), ...pending.keys()])].filter((k) => !deleted.has(k)).map((k) => structuredClone(read(k)))),
      put: (value: { id: string }) =>
        request(() => {
          deleted.delete(value.id);
          pending.set(value.id, structuredClone(value));
          return value.id;
        }),
      delete: (key: string) =>
        request(() => {
          pending.delete(key);
          deleted.add(key);
          return undefined;
        }),
    };
    return tx;
  }
}
