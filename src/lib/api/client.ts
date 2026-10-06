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
  parseCalendar,
  parseContribute,
  parseCraft,
  parseMail,
  parseMailAction,
  parseProjects,
  parseStorage,
  parseStorageMove,
  parseCommons,
  parseHome,
  parseHomeAction,
  parseItems,
  parseItemsAction,
  parseCreatedInvite,
  parseInviteList,
  parsePlay,
  parseProgress,
  parseSnapshot,
  parseState,
  parseSpend,
  parseSync,
  parseWildsClaim,
  parseWildsDefeat,
  parseWildsLantern,
  parseWildsRegion,
} from './parse.ts';
import { createQueue, type SerialQueue } from './queue.ts';
import type {
  Asset,
  CalendarResponse,
  ContributeResponse,
  CraftResponse,
  MailActionResponse,
  MailResponse,
  ProjectsResponse,
  StorageMoveResponse,
  StorageResponse,
  ChestId,
  CommonsResponse,
  HomeActionRequest,
  HomeActionResponse,
  HomeOp,
  HomeResponse,
  ItemsActionResponse,
  ItemsOp,
  ItemsResponse,
  CreatedInvite,
  InviteList,
  LoginRequest,
  OriginRequest,
  PlayResponse,
  ProgressRequest,
  ProgressResponse,
  Snapshot,
  StateResponse,
  SpendRequest,
  SpendResponse,
  SyncRequest,
  SyncResponse,
  WildsClaimRequest,
  WildsClaimResponse,
  WildsDefeatRequest,
  WildsDefeatResponse,
  WildsLanternRequest,
  WildsLanternResponse,
  WildsRegionResponse,
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
  state(lease?: string | null): Promise<StateResponse>;
  origin(req: OriginRequest): Promise<Snapshot>;
  play(req: { clientId: string; takeOver?: boolean }): Promise<PlayResponse>;
  progress(req: ProgressRequest, opts?: { keepalive?: boolean }): Promise<ProgressResponse>;
  sync(req: SyncRequest): Promise<SyncResponse>;
  spend(req: SpendRequest): Promise<SpendResponse>;
  createInvite(): Promise<CreatedInvite>;
  listInvites(): Promise<InviteList>;
  revokeInvite(id: string): Promise<void>;
  wildsRegion(regionId: string): Promise<WildsRegionResponse>;
  wildsClaim(req: WildsClaimRequest): Promise<WildsClaimResponse>;
  wildsDefeat(req: WildsDefeatRequest): Promise<WildsDefeatResponse>;
  wildsLantern(req: WildsLanternRequest): Promise<WildsLanternResponse>;

  /** The homestead behind a Commons gate (null home: unclaimed land; read-only for visitors). */
  home(gate: number): Promise<HomeResponse>;
  /** The Commons lane: every gate shown, who holds it, and deed invitations. */
  commons(): Promise<CommonsResponse>;
  /** A keyed homestead mutation (claim, buy, place, …, joint, leave). */
  homeAction(op: HomeOp, req: HomeActionRequest): Promise<HomeActionResponse>;
  /** The Hearthwick calendar (public, no session). */
  calendar(): Promise<CalendarResponse>;
  /** Workshop storage: carried and stored counts. */
  storage(): Promise<StorageResponse>;
  storageMove(req: Envelope & { direction: 'deposit' | 'withdraw'; asset: Asset; chest?: ChestId }): Promise<StorageMoveResponse>;
  craft(req: Envelope & { recipeId: string; qty: number }): Promise<CraftResponse>;
  mail(page?: { cursor?: string; pendingCursor?: string }): Promise<MailResponse>;
  mailSend(req: Envelope & { toId: string; asset: Asset }): Promise<MailActionResponse>;
  mailClaim(id: string, req: Envelope): Promise<MailActionResponse>;
  /** Take back unclaimed mail (server fix round 5; 404/405 from older servers). */
  mailRecall(id: string, req: Envelope): Promise<MailActionResponse>;
  projects(): Promise<ProjectsResponse>;
  contribute(id: string, req: Envelope & { materials: Record<string, number> }): Promise<ContributeResponse>;
  /** What you carry in the item model: stacks, instances, pockets, the off hand. */
  items(): Promise<ItemsResponse>;
  /** A keyed item mutation (use, repair, fit, unfit, give, pocket, offhand, pickup). */
  itemAction(op: ItemsOp, req: Envelope & Record<string, unknown>): Promise<ItemsActionResponse>;
}

/** The common keyed-mutation fields (Link.mutate fills them). */
export interface Envelope {
  lease: string;
  baseRev: number;
  key: string;
  progress?: unknown;
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
      const invite = req.invite ? normalizeInviteCode(req.invite) : '';
      if (invite) body.invite = invite;
      return parseSnapshot(await request('POST', '/api/session', body));
    },
    async logout() {
      await request('DELETE', '/api/session');
    },
    async state(lease) {
      return parseState(await request('GET', '/api/state', undefined, lease ? { headers: { 'X-Play-Lease': lease } } : {}));
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
    async wildsRegion(regionId) {
      return parseWildsRegion(await request('GET', `/api/wilds/region/${encodeURIComponent(regionId)}`));
    },
    async wildsClaim(req) {
      return parseWildsClaim(await request('POST', '/api/wilds/claim', req));
    },
    async wildsDefeat(req) {
      return parseWildsDefeat(await request('POST', '/api/wilds/defeat', req));
    },
    async wildsLantern(req) {
      return parseWildsLantern(await request('POST', '/api/wilds/lantern', req));
    },
    async home(gate) {
      return parseHome(await request('GET', `/api/homestead/gate/${Math.floor(gate)}`));
    },
    async commons() {
      return parseCommons(await request('GET', '/api/commons'));
    },
    async homeAction(op, req) {
      return parseHomeAction(await request('POST', `/api/homestead/${op}`, req));
    },
    async calendar() {
      return parseCalendar(await request('GET', '/api/calendar'));
    },
    async storage() {
      return parseStorage(await request('GET', '/api/storage'));
    },
    async storageMove(req) {
      return parseStorageMove(await request('POST', '/api/storage', req));
    },
    async craft(req) {
      return parseCraft(await request('POST', '/api/craft', req));
    },
    async mail(page) {
      const q = new URLSearchParams();
      if (page?.cursor) q.set('cursor', page.cursor);
      if (page?.pendingCursor) q.set('pendingCursor', page.pendingCursor);
      const qs = q.toString();
      return parseMail(await request('GET', `/api/mail${qs ? `?${qs}` : ''}`));
    },
    async mailSend(req) {
      return parseMailAction(await request('POST', '/api/mail', req));
    },
    async mailClaim(id, req) {
      return parseMailAction(await request('POST', `/api/mail/${encodeURIComponent(id)}/claim`, req));
    },
    async mailRecall(id, req) {
      return parseMailAction(await request('POST', `/api/mail/${encodeURIComponent(id)}/recall`, req));
    },
    async projects() {
      return parseProjects(await request('GET', '/api/projects'));
    },
    async contribute(id, req) {
      return parseContribute(await request('POST', `/api/projects/${encodeURIComponent(id)}/contribute`, req));
    },
    async items() {
      return parseItems(await request('GET', '/api/items'));
    },
    async itemAction(op, req) {
      return parseItemsAction(await request('POST', `/api/items/${op}`, req));
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
    wildsRegion: (regionId) => run((r) => r.wildsRegion(regionId)),
    wildsClaim: (req) => run((r) => r.wildsClaim(req)),
    wildsDefeat: (req) => run((r) => r.wildsDefeat(req)),
    wildsLantern: (req) => run((r) => r.wildsLantern(req)),
    home: (id) => run((r) => r.home(id)),
    commons: () => run((r) => r.commons()),
    homeAction: (op, req) => run((r) => r.homeAction(op, req)),
    calendar: () => run((r) => r.calendar()),
    storage: () => run((r) => r.storage()),
    storageMove: (req) => run((r) => r.storageMove(req)),
    craft: (req) => run((r) => r.craft(req)),
    mail: (page) => run((r) => r.mail(page)),
    mailSend: (req) => run((r) => r.mailSend(req)),
    mailClaim: (id, req) => run((r) => r.mailClaim(id, req)),
    mailRecall: (id, req) => run((r) => r.mailRecall(id, req)),
    projects: () => run((r) => r.projects()),
    contribute: (id, req) => run((r) => r.contribute(id, req)),
    items: () => run((r) => r.items()),
    itemAction: (op, req) => run((r) => r.itemAction(op, req)),
  };
}

/**
 * Invite codes as people type or paste them: any case, words split by
 * hyphens, spaces or line breaks ("AMBER fox river - lantern…"). Becomes the
 * canonical lowercase hyphenated form. The server normalizes the same way
 * (and still accepts old hex codes, spaced or not).
 */
export function normalizeInviteCode(input: string): string {
  return input
    .slice(0, 512)
    .toLowerCase()
    .split(/[\s\-\u2010-\u2015]+/u)
    .filter(Boolean)
    .join('-');
}

/** Split a readable code for display: words, and the trailing number. */
export function inviteCodeParts(code: string): { words: string[]; number: string } {
  const parts = normalizeInviteCode(code).split('-');
  const last = parts[parts.length - 1] ?? '';
  return /^\d+$/.test(last) && parts.length > 1 ? { words: parts.slice(0, -1), number: last } : { words: parts, number: '' };
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
  /** The id this page holds now (it can change after `reclaim`). */
  readonly id: string;
  /**
   * Check again that no other live page holds our id, e.g. after this page
   * was frozen or sat in the back-forward cache, when it couldn't answer a
   * duplicate's claim. If one does, take a fresh id. Resolves to the id held.
   */
  reclaim(): Promise<string>;
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
  /** Nonce of a re-claim in progress, and whether a live holder answered it. */
  let reclaimNonce: string | null = null;
  let reclaimLost = false;
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
      } else if (m.type === 'mine' && reclaimNonce !== null && m.nonce === reclaimNonce) {
        reclaimLost = true;
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
  const remember = () => {
    try {
      storage?.setItem(CLIENT_ID_KEY, id);
    } catch {
      /* storage blocked */
    }
  };
  return {
    get id() {
      return id;
    },
    async reclaim() {
      if (!channel || reclaimNonce !== null) return id;
      const n = newKey();
      reclaimNonce = n;
      reclaimLost = false;
      // Still the holder meanwhile: we keep answering others' claims.
      channel.postMessage({ type: 'who', id, nonce: n });
      await new Promise((r) => setTimeout(r, waitMs));
      reclaimNonce = null;
      if (reclaimLost) {
        id = newKey();
        remember();
      }
      return id;
    },
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
