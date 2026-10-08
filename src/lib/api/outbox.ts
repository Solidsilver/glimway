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
export type OutboxKind = 'quest-step' | 'mark' | 'take-paper' | 'settle-echo' | 'fall' | 'spend' | 'wilds-claim' | 'wilds-lantern' | 'mutation';
const KINDS: readonly OutboxKind[] = ['quest-step', 'mark', 'take-paper', 'settle-echo', 'fall', 'spend', 'wilds-claim', 'wilds-lantern', 'mutation'];

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
  savedAt: number;
}

export function emptyRecord(account: string, device: string): OutboxRecord {
  return { account, device, nextId: 1, entries: [], server: null, reports: null, client: '', lease: null, name: '', worldId: '', loggedOut: false, savedAt: 0 };
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
  return { id, kind: kind as OutboxKind, path, key, body, contract, createdAt, sent: raw.sent === true, barrier: raw.barrier === true, offline: raw.offline === true };
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
    savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : 0,
  };
}

/** Entries too old to replay, or made under another contract (2.4, "Lifetime" and "Contract"). */
export function expired(entries: readonly OutboxEntry[], now: number, contract: number): OutboxEntry[] {
  return entries.filter((e) => e.contract !== contract || now - e.createdAt > OUTBOX_LIFETIME_MS);
}

export interface OutboxStore {
  load(account: string, device: string): Promise<OutboxRecord | null>;
  /** The most recently saved record on this device not kept from a logout (offline start). */
  latest(device: string): Promise<OutboxRecord | null>;
  /** False when the write didn't land. */
  save(record: OutboxRecord): Promise<boolean>;
  clear(account: string, device: string): Promise<boolean>;
  /** Whether writes can land at all (false: a private window, IndexedDB blocked). */
  readonly durable: boolean;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const factory = (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!factory) {
      reject(new Error('IndexedDB is not available.'));
      return;
    }
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('Could not open the outbox.'));
    req.onblocked = () => reject(new Error('The outbox is blocked by another tab.'));
  });
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed.'));
  });
}

/** IndexedDB, one write at a time. */
export function idbOutboxStore(): OutboxStore {
  let chain: Promise<unknown> = Promise.resolve();
  let durable = true;
  const serial = <T>(mode: IDBTransactionMode, fallback: T, fn: (store: IDBObjectStore) => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      try {
        const db = await open();
        try {
          return await fn(db.transaction(STORE, mode).objectStore(STORE));
        } finally {
          db.close();
        }
      } catch {
        if (mode === 'readwrite') durable = false;
        return fallback;
      }
    });
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
  return {
    get durable() {
      return durable;
    },
    load: (account, device) => serial('readonly', null, async (s) => normalizeRecord(await done(s.get(recordKey(account, device))))),
    latest: (device) =>
      serial('readonly', null, async (s) => {
        let best: OutboxRecord | null = null;
        for (const raw of (await done(s.getAll())) as unknown[]) {
          const r = normalizeRecord(raw);
          if (r && r.device === device && !r.loggedOut && r.server && (!best || r.savedAt > best.savedAt)) best = r;
        }
        return best;
      }),
    save: (record) =>
      serial('readwrite', false, async (s) => {
        await done(s.put({ ...structuredClone(record), id: recordKey(record.account, record.device), savedAt: Date.now() }));
        durable = true;
        return true;
      }),
    clear: (account, device) =>
      serial('readwrite', false, async (s) => {
        await done(s.delete(recordKey(account, device)));
        return true;
      }),
  };
}

/** In memory: tests, and the fallback when IndexedDB can't be opened. */
export function memoryOutboxStore(opts: { durable?: boolean } = {}): OutboxStore & { records: Map<string, OutboxRecord> } {
  const records = new Map<string, OutboxRecord>();
  return {
    records,
    durable: opts.durable ?? true,
    async load(account, device) {
      const r = records.get(recordKey(account, device));
      return r ? normalizeRecord(structuredClone(r)) : null;
    },
    async latest(device) {
      let best: OutboxRecord | null = null;
      for (const r of records.values()) if (r.device === device && !r.loggedOut && r.server && (!best || r.savedAt >= best.savedAt)) best = r;
      return best ? normalizeRecord(structuredClone(best)) : null;
    },
    async save(record) {
      if (opts.durable === false) return false;
      records.set(recordKey(record.account, record.device), { ...structuredClone(record), savedAt: Date.now() });
      return true;
    },
    async clear(account, device) {
      records.delete(recordKey(account, device));
      return true;
    },
  };
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
