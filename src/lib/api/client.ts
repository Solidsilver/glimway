/**
 * Glimway server client. Same-origin JSON with the session cookie, typed
 * errors (errors.ts), validated responses (parse.ts), and one in-order queue
 * (queue.ts) that every call goes through.
 *
 * `run(raw => …)` queues a task that builds its request when it actually
 * starts, so a request behind another reads the lease that one left.
 *
 * The Habitica token passes through `login` only, and is never stored here.
 */
import contract from '../../../content/contract.json' with { type: 'json' };
import { createOperationsApi, type OperationsApi } from './operations.ts';
import { ApiError, errorFromResponse } from './errors.ts';
import {
  parseCalendar,
  parseContribute,
  parseCraft,
  parseDeskCopy,
  parseHearthCraft,
  parseWoodpileRead,
  parseWoodpileAction,
  parseMail,
  parseMailAction,
  parseProjects,
  parseRepairs,
  parseMend,
  parseStorage,
  parseStorageMove,
  parseCommons,
  parseHome,
  parseHomeAction,
  parseShelf,
  parseShelfAction,
  parseItems,
  parseItemsAction,
  parseCreatedInvite,
  parseInviteList,
  parsePlay,
  parseSnapshot,
  parseState,
  parseWildsRegion,
  parseWorld,
  parseWorldChoice,
  parseWorldMove,
} from './parse.ts';
import { createQueue, type SerialQueue } from './queue.ts';
import { parseEntry, type ShelfEntry } from '../papers/library.ts';
import type {
  Asset,
  CalendarResponse,
  ContributeResponse,
  CraftResponse,
  DeskCopyResponse,
  HearthCraftResponse,
  WoodpileResponse,
  WoodpileActionResponse,
  MailActionResponse,
  MailResponse,
  ProjectsResponse,
  RepairsResponse,
  MendResponse,
  ShelfResponse,
  ShelfRequest,
  ShelfActionResponse,
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
  Snapshot,
  StateResponse,
  WildsRegionResponse,
  WorldChoice,
  WorldMoveResponse,
  WorldView,
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
  /**
   * Sign in. A newcomer whose party has a world here (or may open one) comes
   * back signed in but held for the world choice (`WorldChoice`); everyone
   * else gets their snapshot.
   */
  login(req: LoginRequest): Promise<Snapshot | WorldChoice>;
  logout(): Promise<void>;
  state(lease?: string | null): Promise<StateResponse>;
  origin(req: OriginRequest): Promise<Snapshot>;
  play(req: { clientId: string; takeOver?: boolean }): Promise<PlayResponse>;
  createInvite(): Promise<CreatedInvite>;
  listInvites(): Promise<InviteList>;
  revokeInvite(id: string): Promise<void>;
  /** Your world, your party's world, and when you may next move (needs the session only). */
  world(): Promise<WorldView>;
  /** Make your party's world, if it has none yet (it moves no one). No lease. */
  worldParty(): Promise<WorldView>;
  /** The party world's join prompt was shown (once per party world). */
  worldPrompt(worldId: string): Promise<WorldView>;
  /** Move to another world (keyed; from the village or the Commons). */
  worldMove(req: Envelope & { worldId: string }): Promise<WorldMoveResponse>;
  /** Left the party whose world you live in: go to your own world now (keyed; no cooldown). */
  worldLeave(req: Envelope): Promise<WorldMoveResponse>;
  /** The "you were moved out" notice was shown. */
  worldNotice(): Promise<WorldView>;
  /** A held first sign-in's question, asked again (a reload, a tab closed mid-choice). */
  worldChoice(): Promise<WorldChoice>;
  /** Answer it, once: the party's world, or one of your own. The same sign-in carries on. */
  worldChoose(choice: 'party' | 'own'): Promise<Snapshot>;
  wildsRegion(regionId: string): Promise<WildsRegionResponse>;

  /** The homestead behind a Commons gate (null home: unclaimed land; read-only for visitors). */
  home(gate: number): Promise<HomeResponse>;
  /** The Commons lane: every gate shown, who holds it, and deed invitations. */
  commons(): Promise<CommonsResponse>;
  /** The shelf at a Commons gate (who holds it, slots, whether you've taken today). */
  shelf(gate: number): Promise<ShelfResponse>;
  /** A keyed gate shelf mutation (stock or take). */
  shelfAction(req: ShelfRequest): Promise<ShelfActionResponse>;
  /** A keyed homestead mutation (claim, buy, place, …, joint, leave). */
  homeAction(op: HomeOp, req: HomeActionRequest): Promise<HomeActionResponse>;
  /** The Hearthwick calendar (public, no session). */
  calendar(): Promise<CalendarResponse>;
  /** Workshop storage: carried and stored counts. */
  storage(): Promise<StorageResponse>;
  storageMove(req: Envelope & { direction: 'deposit' | 'withdraw'; asset: Asset; chest?: ChestId }): Promise<StorageMoveResponse>;
  craft(req: Envelope & { recipeId: string; qty: number }): Promise<CraftResponse>;
  /** Make food, remedies and oils at the cottage hearth (membership in a tier 1+ homestead). */
  hearthCraft(req: Envelope & { recipeId: string; qty: number }): Promise<HearthCraftResponse>;
  /** Copy a recipe page you hold at a placed writing desk (1 fiber a copy). */
  deskCopy(req: Envelope & { pageId: string; qty: number }): Promise<DeskCopyResponse>;
  /** The woodpile's green-timber stacks and how far each has seasoned. */
  woodpile(): Promise<WoodpileResponse>;
  woodpileAction(req: Envelope & { action: 'stack' | 'collect'; qty?: number; stackId?: string }): Promise<WoodpileActionResponse>;
  mail(page?: { cursor?: string; pendingCursor?: string }): Promise<MailResponse>;
  mailSend(req: Envelope & { toId: string; asset: Asset }): Promise<MailActionResponse>;
  mailClaim(id: string, req: Envelope): Promise<MailActionResponse>;
  /** Take back unclaimed mail (server fix round 5; 404/405 from older servers). */
  mailRecall(id: string, req: Envelope): Promise<MailActionResponse>;
  projects(): Promise<ProjectsResponse>;
  contribute(id: string, req: Envelope & { materials: Record<string, number> }): Promise<ContributeResponse>;
  /** What you carry in the item model: stacks, instances, pockets, the off hand. */
  items(): Promise<ItemsResponse>;
  /** A keyed item mutation (use, repair, fit, unfit, give, pocket, offhand, pickup, return). */
  itemAction(op: ItemsOp, req: Envelope & Record<string, unknown>): Promise<ItemsActionResponse>;
  /** Village repairs and chores list. */
  repairs(): Promise<RepairsResponse>;
  /** Mend a village repair. */
  repairMend(id: string, req: Envelope): Promise<MendResponse>;
  /** Donate a paper you hold (the server checks its `paper:` mark) to the world's library. */
  libraryDonate(req: Envelope & { paperId: string }): Promise<LibraryDonateResponse>;
}

export interface LibraryDonateResponse extends Snapshot {
  result: { entry: ShelfEntry };
}

/**
 * The common keyed-mutation fields (Link.mutate fills them): the operation
 * header and where the hero stands (design server-first 2.1). No `baseRev`,
 * no `progress`.
 */
export interface Envelope {
  op: { lease: string; key: string; report?: { client: string; generation: string; seq: number } };
  where: { area: string; x: number; y: number };
}

export interface ApiClient extends RawApi {
  readonly operations: OperationsApi;
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
    extra: { headers?: Record<string, string>; keepalive?: boolean; binary?: boolean } = {},
  ): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json', 'X-Glimway-Contract': String(contract.number), ...extra.headers };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (extra.binary) headers.Accept = 'application/x-protobuf';
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
    if (response.ok && extra.binary) {
      if (!response.headers.get('content-type')?.includes('application/x-protobuf')) throw new ApiError('bad-response', { status: response.status });
      return new Uint8Array(await response.arrayBuffer());
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
      if (req.party && req.party.length <= 128) body.party = req.party;
      const res = await request('POST', '/api/session', body);
      return parseWorldChoice(res) ?? parseSnapshot(res);
    },
    async logout() {
      await request('DELETE', '/api/session');
    },
    async state(lease) {
      return parseState(await request('GET', '/api/state', undefined, lease ? { headers: { 'X-Play-Lease': lease } } : {}));
    },
    // TODO(C1): remove this retired origin flow and its callers.
    async origin(req) {
      return parseSnapshot(await request('POST', '/api/origin', req));
    },
    async play(req) {
      return parsePlay(await request('POST', '/api/play', { clientId: req.clientId, takeOver: req.takeOver === true }));
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
    async world() {
      return parseWorld(await request('GET', '/api/world'));
    },
    async worldParty() {
      return parseWorld(await request('POST', '/api/world/party', {}));
    },
    async worldPrompt(worldId) {
      return parseWorld(await request('POST', '/api/world/prompt', { worldId }));
    },
    async worldMove(req) {
      return parseWorldMove(await request('POST', '/api/world/move', req));
    },
    async worldLeave(req) {
      return parseWorldMove(await request('POST', '/api/world/leave', req));
    },
    async worldNotice() {
      return parseWorld(await request('POST', '/api/world/notice', {}));
    },
    async worldChoice() {
      const c = parseWorldChoice(await request('GET', '/api/world/choice'));
      if (!c) throw new ApiError('bad-response', { status: 200 });
      return c;
    },
    async worldChoose(choice) {
      return parseSnapshot(await request('POST', '/api/world/choose', { choice }));
    },
    async wildsRegion(regionId) {
      return parseWildsRegion(await request('GET', `/api/wilds/region/${encodeURIComponent(regionId)}`));
    },
    async home(gate) {
      return parseHome(await request('GET', `/api/homestead/gate/${Math.floor(gate)}`));
    },
    async commons() {
      return parseCommons(await request('GET', '/api/commons'));
    },
    async shelf(gate) {
      return parseShelf(await request('GET', `/api/homestead/shelf?gate=${encodeURIComponent(gate)}`));
    },
    async shelfAction(req) {
      return parseShelfAction(await request('POST', '/api/homestead/shelf', req));
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
    async hearthCraft(req) {
      return parseHearthCraft(await request('POST', '/api/hearth/craft', req));
    },
    async deskCopy(req) {
      return parseDeskCopy(await request('POST', '/api/desk/copy', req));
    },
    async woodpile() {
      return parseWoodpileRead(await request('GET', '/api/homestead/woodpile'));
    },
    async woodpileAction(req) {
      return parseWoodpileAction(await request('POST', '/api/homestead/woodpile', req));
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
    async repairs() {
      return parseRepairs(await request('GET', '/api/repairs'));
    },
    async repairMend(id, req) {
      return parseMend(await request('POST', `/api/repairs/${encodeURIComponent(id)}/mend`, req));
    },
    async libraryDonate(req) {
      const res = await request('POST', '/api/library/donate', req);
      const entry = parseEntry((res as { result?: { entry?: unknown } } | null)?.result?.entry);
      if (!entry) throw new ApiError('bad-response', { status: 200 });
      return { ...parseSnapshot(res), result: { entry } };
    },
  };

  const run = <T>(task: (r: RawApi) => Promise<T>): Promise<T> => queue.run(() => task(raw));

  return {
    run,
    operations: createOperationsApi(request),
    queue,
    raw,
    login: (req) => run((r) => r.login(req)),
    logout: () => run((r) => r.logout()),
    state: (lease) => run((r) => r.state(lease)),
    origin: (req) => run((r) => r.origin(req)),
    play: (req) => run((r) => r.play(req)),
    createInvite: () => run((r) => r.createInvite()),
    listInvites: () => run((r) => r.listInvites()),
    revokeInvite: (id) => run((r) => r.revokeInvite(id)),
    world: () => run((r) => r.world()),
    worldParty: () => run((r) => r.worldParty()),
    worldPrompt: (worldId) => run((r) => r.worldPrompt(worldId)),
    worldMove: (req) => run((r) => r.worldMove(req)),
    worldLeave: (req) => run((r) => r.worldLeave(req)),
    worldNotice: () => run((r) => r.worldNotice()),
    worldChoice: () => run((r) => r.worldChoice()),
    worldChoose: (choice) => run((r) => r.worldChoose(choice)),
    wildsRegion: (regionId) => run((r) => r.wildsRegion(regionId)),
    home: (id) => run((r) => r.home(id)),
    commons: () => run((r) => r.commons()),
    shelf: (gate: number) => run((r) => r.shelf(gate)),
    shelfAction: (req: ShelfRequest) => run((r) => r.shelfAction(req)),
    homeAction: (op, req) => run((r) => r.homeAction(op, req)),
    calendar: () => run((r) => r.calendar()),
    storage: () => run((r) => r.storage()),
    storageMove: (req) => run((r) => r.storageMove(req)),
    craft: (req) => run((r) => r.craft(req)),
    hearthCraft: (req) => run((r) => r.hearthCraft(req)),
    deskCopy: (req) => run((r) => r.deskCopy(req)),
    woodpile: () => run((r) => r.woodpile()),
    woodpileAction: (req) => run((r) => r.woodpileAction(req)),
    mail: (page) => run((r) => r.mail(page)),
    mailSend: (req) => run((r) => r.mailSend(req)),
    mailClaim: (id, req) => run((r) => r.mailClaim(id, req)),
    mailRecall: (id, req) => run((r) => r.mailRecall(id, req)),
    projects: () => run((r) => r.projects()),
    contribute: (id, req) => run((r) => r.contribute(id, req)),
    items: () => run((r) => r.items()),
    itemAction: (op, req) => run((r) => r.itemAction(op, req)),
    repairs: () => run((r) => r.repairs()),
    repairMend: (id, req) => run((r) => r.repairMend(id, req)),
    libraryDonate: (req) => run((r) => r.libraryDonate(req)),
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

// The game's old name, kept so tabs open across the rename keep their ids and find each other.
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

  const stored = readStored(storage);
  let id = stored && /^[A-Za-z0-9_-]{1,128}$/.test(stored) ? stored : newKey();
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

/** C2 keys its durable outbox/Web Lock by (account, device), never the tab client. */
export function claimDeviceId(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): string {
  const key = 'glimway-device-id';
  const saved = storage.getItem(key);
  if (saved && /^[A-Za-z0-9_-]{1,128}$/.test(saved)) return saved;
  const id = newKey(); storage.setItem(key, id); return id;
}
