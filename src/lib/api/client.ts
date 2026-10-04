/**
 * Fingersnap server client. Same-origin JSON with the session cookie, typed
 * errors (errors.ts), validated responses (parse.ts), and one in-order queue
 * (queue.ts) that every call goes through.
 *
 * `run(raw => …)` queues a task that builds its request when it actually
 * starts, so a progress upload behind a spend reads the revision and lease
 * the spend returned, not the ones current when it was queued.
 *
 * The Habitica token passes through `login` only, and is never stored here.
 */
import { ApiError, errorFromResponse } from './errors.ts';
import {
  parseCreatedInvite,
  parseInviteList,
  parsePlay,
  parseProgress,
  parseSnapshot,
  parseSpend,
  parseSync,
} from './parse.ts';
import { createQueue, type SerialQueue } from './queue.ts';
import type {
  CreatedInvite,
  InviteInfo,
  LoginRequest,
  OriginRequest,
  PlayResponse,
  ProgressRequest,
  ProgressResponse,
  Snapshot,
  SpendRequest,
  SpendResponse,
  SyncRequest,
  SyncResponse,
} from './types.ts';

export interface ApiClientOptions {
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Defaults to '' (same origin). */
  baseUrl?: string;
  timeoutMs?: number;
}

/** Unqueued calls. Use them only inside `run`. */
export interface RawApi {
  login(req: LoginRequest): Promise<Snapshot>;
  logout(): Promise<void>;
  state(lease?: string | null): Promise<Snapshot>;
  origin(req: OriginRequest): Promise<Snapshot>;
  play(req: { clientId: string; takeOver?: boolean }): Promise<PlayResponse>;
  progress(req: ProgressRequest, opts?: { keepalive?: boolean }): Promise<ProgressResponse>;
  sync(req: SyncRequest): Promise<SyncResponse>;
  spend(req: SpendRequest): Promise<SpendResponse>;
  createInvite(): Promise<CreatedInvite>;
  listInvites(): Promise<InviteInfo[]>;
  revokeInvite(id: string): Promise<void>;
}

export interface ApiClient extends RawApi {
  /** Queue a task that uses the raw calls; it starts after everything before it settles. */
  run<T>(task: (raw: RawApi) => Promise<T>): Promise<T>;
  readonly queue: SerialQueue;
}

const DEFAULT_TIMEOUT_MS = 15_000;

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const { baseUrl = '', timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const doFetch: typeof fetch = options.fetchImpl ?? ((input, init) => globalThis.fetch(input, init));
  const queue = createQueue();

  async function request(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    body?: unknown,
    extra: { headers?: Record<string, string>; keepalive?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json', ...extra.headers };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${baseUrl}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        cache: 'no-store',
        signal: controller.signal,
        keepalive: extra.keepalive === true,
      });
    } catch {
      throw new ApiError('network');
    } finally {
      clearTimeout(timer);
    }
    const type = response.headers.get('content-type') ?? '';
    let parsed: unknown;
    if (type.toLowerCase().includes('application/json')) {
      try {
        parsed = await response.json();
      } catch {
        parsed = undefined;
      }
    }
    if (!response.ok) throw errorFromResponse(response.status, parsed, response.headers.get('retry-after'));
    // A 200 that is not JSON came from something else (an HTML fallback page).
    if (parsed === undefined) throw new ApiError('unavailable', { status: response.status });
    return parsed;
  }

  const raw: RawApi = {
    async login(req) {
      const body: LoginRequest = { userId: req.userId, token: req.token };
      if (req.invite && req.invite.trim()) body.invite = req.invite.trim();
      return parseSnapshot(await request('POST', '/api/session', body));
    },
    async logout() {
      await request('DELETE', '/api/session');
    },
    async state(lease) {
      return parseSnapshot(await request('GET', '/api/state', undefined, lease ? { headers: { 'X-Play-Lease': lease } } : {}));
    },
    async origin(req) {
      return parseSnapshot(await request('POST', '/api/origin', req));
    },
    async play(req) {
      return parsePlay(await request('POST', '/api/play', { clientId: req.clientId, takeOver: req.takeOver === true }));
    },
    async progress(req, opts) {
      return parseProgress(await request('PUT', '/api/progress', req, { keepalive: opts?.keepalive }));
    },
    async sync(req) {
      return parseSync(await request('POST', '/api/sync', req));
    },
    async spend(req) {
      return parseSpend(await request('POST', '/api/spend', req));
    },
    async createInvite() {
      return parseCreatedInvite(await request('POST', '/api/invites', {}));
    },
    async listInvites() {
      return parseInviteList(await request('GET', '/api/invites'));
    },
    async revokeInvite(id) {
      await request('DELETE', `/api/invites/${encodeURIComponent(id)}`);
    },
  };

  const run = <T>(task: (r: RawApi) => Promise<T>): Promise<T> => queue.run(() => task(raw));

  return {
    run,
    queue,
    login: (req) => run((r) => r.login(req)),
    logout: () => run((r) => r.logout()),
    state: (lease) => run((r) => r.state(lease)),
    origin: (req) => run((r) => r.origin(req)),
    play: (req) => run((r) => r.play(req)),
    progress: (req, opts) => run((r) => r.progress(req, opts)),
    sync: (req) => run((r) => r.sync(req)),
    spend: (req) => run((r) => r.spend(req)),
    createInvite: () => run((r) => r.createInvite()),
    listInvites: () => run((r) => r.listInvites()),
    revokeInvite: (id) => run((r) => r.revokeInvite(id)),
  };
}

/** A fresh idempotency key (spends, origin). Reuse it only to retry the same request. */
export function newKey(): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

const CLIENT_ID_KEY = 'fingersnap:client-id';
let memoryClientId: string | null = null;

/**
 * This tab's play-client id (backend: unique per tab, kept across offline
 * reconnects). sessionStorage survives reloads of the tab but not new tabs.
 */
export function tabClientId(storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeSessionStorage()): string {
  try {
    const stored = storage?.getItem(CLIENT_ID_KEY);
    if (stored && stored.length <= 128) return stored;
    const id = newKey();
    storage?.setItem(CLIENT_ID_KEY, id);
    if (storage) return id;
  } catch {
    /* storage blocked: fall back to memory for this page */
  }
  memoryClientId ??= newKey();
  return memoryClientId;
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
