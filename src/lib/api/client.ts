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
  /** Unqueued calls. Only for the page-unload upload, which can't wait its turn. */
  readonly raw: RawApi;
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
    raw,
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
const CLAIM_CHANNEL = 'fingersnap-client';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;
interface ChannelLike {
  postMessage(message: unknown): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  close(): void;
}

export interface ClaimOptions {
  storage?: StorageLike | null;
  /** How long to wait for another live page to say it holds the id. */
  waitMs?: number;
  /** Injectable for tests; defaults to BroadcastChannel when the browser has it. */
  makeChannel?: (name: string) => ChannelLike | null;
  channelName?: string;
}

export interface ClientIdClaim {
  readonly id: string;
  /** Stop answering for this id (tests; a page answers until it closes). */
  close(): void;
}

/**
 * This page's play-client id (backend: unique per tab, kept across offline
 * reconnects and reloads). sessionStorage keeps it across reloads, but a
 * duplicated tab (or a restored session) copies sessionStorage too, and two
 * live pages sharing an id would share one lease. So the stored id is
 * claimed over a BroadcastChannel: a live page holding it answers, and the
 * newcomer takes a fresh id. Two pages claiming at once break the tie by a
 * random nonce. Without BroadcastChannel, the stored id is used as before.
 */
export async function claimClientId(opts: ClaimOptions = {}): Promise<ClientIdClaim> {
  const storage = opts.storage === undefined ? safeSessionStorage() : opts.storage;
  const waitMs = opts.waitMs ?? 150;
  const makeChannel =
    opts.makeChannel ??
    ((name: string) => {
      const BC = (globalThis as { BroadcastChannel?: new (n: string) => ChannelLike }).BroadcastChannel;
      return BC ? new BC(name) : null;
    });

  let id = readStored(storage) ?? newKey();
  const nonce = newKey();
  let held = false;
  let lost = false;
  let channel: ChannelLike | null = null;
  try {
    channel = makeChannel(opts.channelName ?? CLAIM_CHANNEL);
  } catch {
    channel = null;
  }

  if (channel) {
    const ch = channel;
    ch.onmessage = (ev) => {
      const m = ev.data as { type?: string; id?: string; nonce?: string } | null;
      if (!m || m.id !== id) return;
      if (m.type === 'who' && m.nonce !== nonce) {
        // A holder always answers. Two claimers at once: the smaller nonce
        // keeps it. Each side decides for itself, because a channel opened
        // later never hears claims posted before it existed.
        if (held || (m.nonce !== undefined && nonce < m.nonce)) ch.postMessage({ type: 'mine', id, nonce: m.nonce });
        else if (m.nonce !== undefined) lost = true;
      } else if (m.type === 'mine' && m.nonce === nonce && !held) {
        lost = true;
      }
    };
    ch.postMessage({ type: 'who', id, nonce });
    await new Promise((r) => setTimeout(r, waitMs));
    if (lost) id = newKey();
  }
  held = true;
  try {
    storage?.setItem(CLIENT_ID_KEY, id);
  } catch {
    /* storage blocked: the id lives for this page only */
  }
  return {
    id,
    close() {
      if (channel) {
        channel.onmessage = null;
        channel.close();
      }
    },
  };
}

function readStored(storage: StorageLike | null): string | null {
  try {
    const stored = storage?.getItem(CLIENT_ID_KEY);
    return stored && stored.length <= 128 ? stored : null;
  } catch {
    return null;
  }
}

function safeSessionStorage(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}
