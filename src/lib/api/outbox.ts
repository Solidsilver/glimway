/**
 * The outbox (design server-first 2.4): this device's unanswered operations
 * for one account, in order, with their exact request bytes, kept in
 * IndexedDB so a closed tab or a reload replays them with the same keys.
 *
 * - **Ownership.** One record per `(account, device)`. `device` is the
 *   random id in localStorage (`claimDeviceId`), never the per-tab lease
 *   client. Another account's record on the same device is left alone.
 * - **Persist first.** An entry is written before it is sent.
 * - **Frozen bytes.** `body` is the request with an empty `op.lease` and no
 *   report barrier; a replay fills in only those two.
 * - **Lifetime.** Entries older than six days, or made under another
 *   contract, are dropped (`expired`); idempotency rows last seven days, so
 *   no key is replayed after the server has forgotten it.
 *
 * The record also carries what an offline start needs: the last adopted
 * state, the report book, and the tab's lease. No credentials ever go in.
 * Storage failures are reported, not thrown: the link then keeps the outbox
 * in memory and offline play is off.
 */
import type { JsonValue } from '@bufbuild/protobuf';
import type { StoredReports } from './reports.ts';

const DB_NAME = 'glimway-outbox';
const DB_VERSION = 1;
const STORE = 'records';

export const OUTBOX_LIFETIME_MS = 6 * 24 * 60 * 60 * 1000;

/** Operations the outbox carries. `mutation` is a keyed domain route (items, homesteads, mail…). */
export type OutboxKind = 'quest-step' | 'mark' | 'take-paper' | 'settle-echo' | 'fall' | 'spend' | 'wilds-claim' | 'wilds-lantern' | 'mutation'
  | 'companions' | 'stall' | 'mount-out' | 'mount-home' | 'stable-extend';
const KINDS: readonly OutboxKind[] = ['quest-step', 'mark', 'take-paper', 'settle-echo', 'fall', 'spend', 'wilds-claim', 'wilds-lantern', 'mutation',
  'companions', 'stall', 'mount-out', 'mount-home', 'stable-extend'];

export interface OutboxEntry {
  /** Order within the record (allocated by the sender under the lock). */
  id: number;
  kind: OutboxKind;
  /** The request path. */
  path: string;
  key: string;
  /** The frozen request JSON: `op.lease` empty, no `op.report`. */
  body: string;
  /** The contract number it was made under. */
  contract: number;
  /** Milliseconds. */
  createdAt: number;
  /** It may have reached the server (an unanswered send). */
  sent: boolean;
  /** Needs a report barrier (vitals-dependent). */
  barrier: boolean;
  /** Predicted and allowed without a connection. */
  offline: boolean;
  /** A fall's predicted recovery (the vitals overlay's point for its answer), stored with it. */
  fall?: { hp: number; mana: number };
}

export interface OutboxRecord {
  account: string;
  device: string;
  /** The next entry id. */
  nextId: number;
  entries: OutboxEntry[];
  /** The newest adopted `PlayerState`, as ProtoJSON. */
  server: JsonValue | null;
  reports: StoredReports | null;
  /** The tab that last sent (its client id) and the lease it held. */
  client: string;
  lease: string | null;
  name: string;
  worldId: string;
  /** Logged out with unsent work kept for the next sign-in. */
  loggedOut: boolean;
  /** Raised by each new owner (`claim`); an owner's write must carry the current one. */
  fence: number;
  savedAt: number;
}

export function emptyRecord(account: string, device: string): OutboxRecord {
  return { account, device, nextId: 1, entries: [], server: null, reports: null, client: '', lease: null, name: '', worldId: '', loggedOut: false, fence: 0, savedAt: 0 };
}

const recordKey = (account: string, device: string) => JSON.stringify([account, device]);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, fallback = ''): string => (typeof v === 'string' ? v : fallback);
const whole = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

function normalizeEntry(raw: unknown): OutboxEntry | null {
  if (!isObj(raw)) return null;
  const { id, kind, path, key, body, contract, createdAt } = raw;
  if (!whole(id) || id < 1 || !KINDS.includes(kind as OutboxKind) || typeof path !== 'string' || !path.startsWith('/api/')) return null;
  if (typeof key !== 'string' || !key || typeof body !== 'string' || !whole(contract) || typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;
  try {
    if (!isObj(JSON.parse(body))) return null;
  } catch {
    return null;
  }
  const f = raw.fall;
  const fall = isObj(f) && typeof f.hp === 'number' && typeof f.mana === 'number' && f.hp >= 0 && f.mana >= 0 ? { hp: f.hp, mana: f.mana } : undefined;
  return { id, kind: kind as OutboxKind, path, key, body, contract, createdAt, sent: raw.sent === true, barrier: raw.barrier === true, offline: raw.offline === true, ...(kind === 'fall' && fall ? { fall } : {}) };
}

function normalizeReports(raw: unknown): StoredReports | null {
  if (!isObj(raw) || !isObj(raw.next) || !whole(raw.seq)) return null;
  const n = raw.next;
  const place = isObj(n.place) && typeof n.place.area === 'string' && typeof n.place.x === 'number' && typeof n.place.y === 'number' ? { area: n.place.area, x: n.place.x, y: n.place.y } : null;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
  const c = raw.captured;
  const captured =
    isObj(c) && typeof c.client === 'string' && typeof c.generation === 'string' && whole(c.seq) && c.seq > 0 && isObj(c.place) && typeof c.place.area === 'string'
      ? { client: c.client, generation: c.generation, seq: c.seq, basis: num(c.basis), place: { area: c.place.area, x: num(c.place.x), y: num(c.place.y) }, hp: num(c.hp), mana: num(c.mana), casts: Math.floor(num(c.casts)) }
      : null;
  return {
    client: str(raw.client),
    generation: str(raw.generation),
    seq: raw.seq,
    next: { place, hp: num(n.hp), mana: num(n.mana), casts: Math.floor(num(n.casts)), basis: num(n.basis), boundary: whole(n.boundary) ? n.boundary : null, changed: n.changed === true },
    captured,
  };
}

/** Validate a stored record; anything unreadable counts as none. Bad entries are dropped one by one. */
export function normalizeRecord(raw: unknown): OutboxRecord | null {
  if (!isObj(raw) || typeof raw.account !== 'string' || !raw.account || typeof raw.device !== 'string' || !raw.device) return null;
  const entries = (Array.isArray(raw.entries) ? raw.entries : []).map(normalizeEntry).filter((e): e is OutboxEntry => e !== null);
  entries.sort((a, b) => a.id - b.id);
  const maxId = entries.reduce((m, e) => Math.max(m, e.id), 0);
  return {
    account: raw.account,
    device: raw.device,
    nextId: Math.max(whole(raw.nextId) ? raw.nextId : 1, maxId + 1),
    entries,
    server: isObj(raw.server) ? (raw.server as JsonValue) : null,
    reports: normalizeReports(raw.reports),
    client: str(raw.client),
    lease: typeof raw.lease === 'string' && raw.lease ? raw.lease : null,
    name: str(raw.name).slice(0, 128),
    worldId: str(raw.worldId).slice(0, 128),
    loggedOut: raw.loggedOut === true,
    fence: whole(raw.fence) ? raw.fence : 0,
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
  };
}

/** Entries too old to replay, or made under another contract (2.4, "Lifetime" and "Contract"). */
export function expired(entries: readonly OutboxEntry[], now: number, contract: number): OutboxEntry[] {
  return entries.filter((e) => e.contract !== contract || now - e.createdAt > OUTBOX_LIFETIME_MS);
}

/** How a fenced write came out. `fenced`: another tab owns the record now; nothing was written. */
export type SaveResult = 'saved' | 'fenced' | 'failed';

/**
 * The record's storage. Writes count only once their transaction commits.
 * Only the owner writes: `claim` takes ownership by raising the record's
 * fence in one transaction, and every owner write checks that fence in the
 * same transaction, so a tab that lost ownership (its lock stolen, or a
 * newer tab without Web Locks) can never land a write afterwards.
 */
export interface OutboxStore {
  load(account: string, device: string): Promise<OutboxRecord | null>;
  /** The most recently saved record on this device not kept from a logout (offline start). */
  latest(device: string): Promise<OutboxRecord | null>;
  /** Take ownership: the record as stored (or a fresh one) under a new fence. Null: storage failed. */
  claim(account: string, device: string): Promise<OutboxRecord | null>;
  /** The owner's write, under its fence. */
  save(record: OutboxRecord): Promise<SaveResult>;
  /** The owner's delete, under its fence. */
  clear(account: string, device: string, fence: number): Promise<SaveResult>;
  /** Anyone's delete of a record with nothing unsent in it (a logout with everything answered). */
  clearIfEmpty(account: string, device: string): Promise<boolean>;
  /** Anyone's logout mark: only `loggedOut` changes. */
  markLoggedOut(account: string, device: string, loggedOut: boolean): Promise<boolean>;
  /** Whether IndexedDB is there at all (false: the outbox lives in memory and offline play is off). */
  readonly durable: boolean;
}

type Factory = Pick<IDBFactory, 'open'>;

function open(factory: Factory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the outbox.'));
    req.onblocked = () => reject(new Error('The outbox is blocked by another tab.'));
  });
}

/** Stored form of a record (its key and a fresh `savedAt`). */
const stored = (record: OutboxRecord) => ({ ...record, id: recordKey(record.account, record.device), savedAt: Date.now() });

/**
 * IndexedDB, one transaction at a time from this page. A transaction's value
 * is reported only on `complete`; `abort` and `error` are failures.
 */
export function idbOutboxStore(factory: Factory | null = (globalThis as { indexedDB?: IDBFactory }).indexedDB ?? null): OutboxStore {
  let chain: Promise<unknown> = Promise.resolve();
  let durable = !!factory;
  /** `cancel` aborts on purpose: the transaction then reports the value set before it, not the fallback. */
  const transact = <T>(mode: IDBTransactionMode, fallback: T, body: (store: IDBObjectStore, cancel: () => void, set: (v: T) => void) => void): Promise<T> => {
    const run = chain.then(async () => {
      if (!factory) return fallback;
      let db: IDBDatabase;
      try {
        db = await open(factory);
      } catch {
        durable = false;
        return fallback;
      }
      durable = true;
      try {
        return await new Promise<T>((resolve) => {
          let value = fallback;
          let cancelled = false;
          const tx = db.transaction(STORE, mode);
          tx.oncomplete = () => resolve(value);
          tx.onabort = () => resolve(cancelled ? value : fallback);
          tx.onerror = () => resolve(cancelled ? value : fallback);
          const cancel = () => {
            cancelled = true;
            tx.abort();
          };
          try {
            body(tx.objectStore(STORE), cancel, (v) => (value = v));
          } catch {
            try {
              tx.abort();
            } catch {
              resolve(fallback);
            }
          }
        });
      } finally {
        db.close();
      }
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  /** Read, then maybe write, inside one transaction. `write` returns the record to put, null to delete, or undefined to leave it. */
  const update = <T>(key: string, fallback: T, write: (current: OutboxRecord | null, set: (v: T) => void, cancel: () => void) => object | null | undefined): Promise<T> =>
    transact('readwrite', fallback, (s, cancel, set) => {
      const get = s.get(key);
      get.onsuccess = () => {
        const next = write(normalizeRecord(get.result), set, cancel);
        if (next === null) s.delete(key);
        else if (next !== undefined) s.put(next);
      };
    });
  return {
    get durable() {
      return durable;
    },
    load: (account, device) =>
      transact<OutboxRecord | null>('readonly', null, (s, _cancel, set) => {
        const get = s.get(recordKey(account, device));
        get.onsuccess = () => set(normalizeRecord(get.result));
      }),
    latest: (device) =>
      transact<OutboxRecord | null>('readonly', null, (s, _cancel, set) => {
        const all = s.getAll();
        all.onsuccess = () => {
          let best: OutboxRecord | null = null;
          for (const raw of all.result as unknown[]) {
            const r = normalizeRecord(raw);
            if (r && r.device === device && !r.loggedOut && r.server && (!best || r.savedAt > best.savedAt)) best = r;
          }
          set(best);
        };
      }),
    claim: (account, device) =>
      update<OutboxRecord | null>(recordKey(account, device), null, (current, set) => {
        const next = { ...(current ?? emptyRecord(account, device)), account, device };
        next.fence = (current?.fence ?? 0) + 1;
        set(next);
        return stored(next);
      }),
    save: (record) => {
      // Snapshot now: the caller keeps changing its copy while this waits its turn.
      const snap = structuredClone(record);
      return update<SaveResult>(recordKey(snap.account, snap.device), 'failed', (current, set, cancel) => {
        if (current && current.fence !== snap.fence) {
          set('fenced');
          cancel();
          return undefined;
        }
        set('saved');
        return stored(snap);
      });
    },
    clear: (account, device, fence) =>
      update<SaveResult>(recordKey(account, device), 'failed', (current, set, cancel) => {
        if (current && current.fence !== fence) {
          set('fenced');
          cancel();
          return undefined;
        }
        set('saved');
        return null;
      }),
    clearIfEmpty: (account, device) =>
      update<boolean>(recordKey(account, device), false, (current, set) => {
        if (current && current.entries.length > 0) return undefined;
        set(true);
        return current ? null : undefined;
      }),
    markLoggedOut: (account, device, loggedOut) =>
      update<boolean>(recordKey(account, device), false, (current, set) => {
        if (!current) return undefined;
        set(true);
        return stored({ ...current, loggedOut });
      }),
  };
}

/** Which writes a test makes fail (`claim`, `save`, `clear`, `mark`). */
export type FailHook = (op: 'claim' | 'save' | 'clear' | 'mark', record?: OutboxRecord) => boolean;

/** In memory: tests, and the fallback when IndexedDB can't be opened (writes then "fail": nothing is durable). */
export function memoryOutboxStore(opts: { durable?: boolean } = {}): OutboxStore & { records: Map<string, OutboxRecord>; fail: FailHook | null } {
  const records = new Map<string, OutboxRecord>();
  const durable = opts.durable ?? true;
  const store = {
    records,
    fail: null as FailHook | null,
    durable,
    async load(account: string, device: string) {
      const r = records.get(recordKey(account, device));
      return r ? normalizeRecord(structuredClone(r)) : null;
    },
    async latest(device: string) {
      let best: OutboxRecord | null = null;
      for (const r of records.values()) if (r.device === device && !r.loggedOut && r.server && (!best || r.savedAt >= best.savedAt)) best = r;
      return best ? normalizeRecord(structuredClone(best)) : null;
    },
    async claim(account: string, device: string) {
      const key = recordKey(account, device);
      const current = records.get(key);
      const next = { ...structuredClone(current ?? emptyRecord(account, device)), fence: (current?.fence ?? 0) + 1 };
      if (!durable) return next;
      if (store.fail?.('claim', next)) return null;
      records.set(key, structuredClone(next));
      return next;
    },
    async save(record: OutboxRecord): Promise<SaveResult> {
      const snap = structuredClone(record);
      await Promise.resolve();
      const current = records.get(recordKey(snap.account, snap.device));
      if (current && current.fence !== snap.fence) return 'fenced';
      if (!durable || store.fail?.('save', snap)) return 'failed';
      records.set(recordKey(snap.account, snap.device), { ...snap, savedAt: Date.now() });
      return 'saved';
    },
    async clear(account: string, device: string, fence: number): Promise<SaveResult> {
      const current = records.get(recordKey(account, device));
      if (current && current.fence !== fence) return 'fenced';
      if (!durable || store.fail?.('clear')) return 'failed';
      records.delete(recordKey(account, device));
      return 'saved';
    },
    async clearIfEmpty(account: string, device: string) {
      const current = records.get(recordKey(account, device));
      if (current && current.entries.length > 0) return false;
      records.delete(recordKey(account, device));
      return true;
    },
    async markLoggedOut(account: string, device: string, loggedOut: boolean) {
      const current = records.get(recordKey(account, device));
      if (!current || store.fail?.('mark', current)) return false;
      records.set(recordKey(account, device), { ...current, loggedOut });
      return true;
    },
  };
  return store;
}

let deviceStore: OutboxStore | null = null;
/** This page's outbox store: IndexedDB, or memory (offline play off) where there is none. */
export function outboxStore(): OutboxStore {
  deviceStore ??= typeof indexedDB === 'undefined' ? memoryOutboxStore({ durable: false }) : idbOutboxStore();
  return deviceStore;
}

// ------------------------------------------------------------ ownership

/** The Web Lock that owns a record's sender and id allocator. */
export const lockName = (account: string, device: string) => `glimway-outbox:${account}:${device}`;

export interface LockLike {
  request(name: string, options: { mode?: 'exclusive'; ifAvailable?: boolean; steal?: boolean; signal?: AbortSignal }, callback: (lock: unknown) => Promise<unknown>): Promise<unknown>;
}

/** A held outbox lock: `lost` resolves when it is stolen or released. */
export interface HeldLock {
  readonly lost: Promise<void>;
  release(): void;
}

/**
 * Hold the outbox lock. `steal` (the player chose Take over) takes it from
 * another tab; otherwise it is taken only if free. Null: another tab on this
 * device holds it. Without Web Locks every tab is its own sender (2.4).
 */
export async function holdLock(locks: LockLike | null, name: string, steal = false): Promise<HeldLock | null> {
  if (!locks) return { lost: new Promise(() => undefined), release: () => undefined };
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  let granted!: (ok: boolean) => void;
  const answer = new Promise<boolean>((r) => (granted = r));
  const lost = locks
    .request(name, steal ? { mode: 'exclusive', steal: true } : { mode: 'exclusive', ifAvailable: true }, async (lock) => {
      if (!lock) {
        granted(false);
        return;
      }
      granted(true);
      await held;
    })
    .then(
      () => granted(false),
      () => granted(false),
    );
  if (!(await answer)) return null;
  return { lost, release };
}

export function browserLocks(): LockLike | null {
  const nav = (globalThis as { navigator?: { locks?: LockLike } }).navigator;
  return nav?.locks ?? null;
}
