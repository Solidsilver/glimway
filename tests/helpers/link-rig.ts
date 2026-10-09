/**
 * The link against a scripted server (design server-first 2.4): Lane A's Go
 * fixtures for states, a fake fetch that answers in order and records every
 * call, a fake Session with Session's merge of live fields, and Web Locks as
 * a browser has them.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { TestContext } from 'node:test';
import { fromJson, toJson, type JsonValue } from '@bufbuild/protobuf';
import { Link, type LinkSession } from '../../src/game/link.ts';
import { EV } from '../../src/game/event-names.ts';
import { createApiClient } from '../../src/lib/api/client.ts';
import { memoryOutboxStore, type LockLike, type OutboxRecord, type OutboxStore } from '../../src/lib/api/outbox.ts';
import { PlayerStateSchema } from '../../src/lib/gen/glimway/v1/state_pb.js';
import type { GameState } from '../../src/lib/state.ts';
import type { HabiticaProfile, VitalsSource } from '../../src/lib/habitica/types.ts';

export const fixtures = JSON.parse(readFileSync(new URL('../../server/internal/api/testdata/server-first.json', import.meta.url), 'utf8')) as { name: string; case: string; json: JsonValue }[];
export const BASE = fixtures.find((f) => f.name === 'glimway.v1.PlayerState' && f.case === 'valid')!.json as Record<string, any>;

type Over = { version?: number; hp?: number; mana?: number; vitalsSetVersion?: number; reportSeq?: number; reportGeneration?: string; quest?: string; marks?: string[]; area?: string; x?: number; y?: number; balance?: number };

/** A valid PlayerState JSON (the Go fixture) with a few fields changed. */
export function S(over: Over = {}): Record<string, any> {
  const s = structuredClone(BASE);
  if (over.version !== undefined) s.version = over.version;
  s.vitals.hp = over.hp ?? 40;
  s.vitals.mana = over.mana ?? 20;
  if (over.vitalsSetVersion !== undefined) s.vitals.vitalsSetVersion = over.vitalsSetVersion;
  if (over.reportSeq !== undefined) s.vitals.reportSeq = over.reportSeq;
  if (over.reportGeneration !== undefined) s.vitals.reportGeneration = over.reportGeneration;
  if (over.quest) s.story.quests = { 'lantern-road': over.quest };
  if (over.marks) s.story.marks = over.marks;
  if (over.area) s.place.area = over.area;
  if (over.x !== undefined) s.place.x = over.x;
  if (over.y !== undefined) s.place.y = over.y;
  if (over.balance !== undefined) s.embers.balance = over.balance;
  // A value set version may not pass the state version.
  s.version = Math.max(s.version, s.vitals.vitalsSetVersion, s.place.placeSetVersion);
  return s;
}
export const player = (json: Record<string, any>) => fromJson(PlayerStateSchema, json as JsonValue);
/** A held state back on the wire (ProtoJSON leaves out null wrappers; the wire spells them). */
export function wire(p: ReturnType<typeof player>): Record<string, any> {
  const j = toJson(PlayerStateSchema, p, { alwaysEmitImplicit: true }) as Record<string, any>;
  j.account.partyId ??= null;
  for (const k of ['class', 'selectedPet', 'selectedMount', 'partyId']) j.profile[k] ??= null;
  for (const k of ['companions', 'magic', 'fishing']) j[k] ??= null;
  // The wire spells an unset *nested* message as null too (Go's
  // EmitUnpopulated); toJson leaves the field out and the strict decoder
  // refuses that. Lane D's fishing (and lane C's magic) carry one.
  if (j.fishing && typeof j.fishing === 'object') j.fishing.cast ??= null;
  if (j.magic && typeof j.magic === 'object') j.magic.classMark ??= null;
  return j;
}

export type Call = { method: string; path: string; body: any; headers: Headers; keepalive: boolean };
export type Answer = { status?: number; body: unknown } | 'network';
export type Script = Answer | ((c: Call) => Answer);

/** Scripted server: `on('POST /api/x', …)` answers in order (the last one repeats); everything is recorded. */
export function fakeServer() {
  const calls: Call[] = [];
  const answers = new Map<string, Script[]>();
  const holds = new Map<string, Array<Promise<void>>>();
  const beforeSend: Array<(c: Call) => void> = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const call: Call = { method, path: url, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: new Headers(init.headers), keepalive: init.keepalive === true };
    calls.push(call);
    for (const f of beforeSend) f(call);
    const gate = holds.get(`${method} ${url}`)?.shift();
    if (gate) await gate;
    const list = answers.get(`${method} ${url}`) ?? [];
    const next = list.length > 1 ? list.shift()! : list[0];
    if (!next) throw new Error(`unexpected ${method} ${url}`);
    const a = typeof next === 'function' ? next(call) : next;
    if (a === 'network') throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    api: createApiClient({ fetchImpl }),
    calls,
    beforeSend,
    on(key: string, ...a: Script[]) {
      answers.set(key, a);
    },
    sent(key: string) {
      const [method, path] = key.split(' ');
      return calls.filter((c) => c.method === method && c.path === path);
    },
    hold(key: string): () => void {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      holds.set(key, [...(holds.get(key) ?? []), gate]);
      return release;
    },
  };
}

/** Answers. */
export const play = (state: Record<string, any>, lease = 'L1', generation = 'gen-1'): Answer => ({ body: { state, lease, reportGeneration: generation, reportClient: 'rc' } });
export const env = (state: Record<string, any>, result: Record<string, unknown>): Answer => ({ body: { state, ...result } });
export const stepOk = (state: Record<string, any>) => env(state, { questStep: { quest: 'lantern-road', step: state.story.quests['lantern-road'] ?? '', items: [], marks: [], papers: [], embers: 0, embersSpent: 0, taken: [], given: [] } });
export const markOk = (state: Record<string, any>, mark: string) => env(state, { mark: { mark, added: true } });
export const refuse = (code: string, state?: Record<string, any>, status = 409): Answer => ({ status, body: state ? { error: { code }, state } : { error: { code } } });
/** A report answered as accepted, with the vitals the server kept. */
export const ackReport =
  (state: (c: Call) => Record<string, any>, over: Partial<{ accepted: boolean; staleBasis: boolean }> = {}) =>
  (c: Call): Answer =>
    env(state(c), { report: { seq: c.body.seq, accepted: over.accepted ?? true, staleBasis: over.staleBasis ?? false, casts: over.accepted === false ? 0 : c.body.casts, client: c.body.client, generation: c.body.generation, basis: c.body.basis, placeIgnored: false, abilityCasts: {}, allyHeal: 0 } });

/** The part of a Session the link drives, with Session's merge of live fields. */
export class FakeSession implements LinkSession {
  state: GameState;
  vitalsSource: VitalsSource = 'imported';
  importedProfile: HabiticaProfile | null = null;
  remoteBusy = false;
  views = 0;
  constructor(state: GameState) {
    this.state = state;
  }
  applyServer(view: GameState, provenance: { vitalsSource: VitalsSource; importedProfile: HabiticaProfile | null }, opts: { relocate?: boolean; vitals?: { hp: number; mana: number } }): void {
    const prev = this.state;
    this.views += 1;
    this.vitalsSource = provenance.vitalsSource;
    this.importedProfile = provenance.importedProfile;
    this.state = {
      ...view,
      area: opts.relocate ? view.area : prev.area,
      position: opts.relocate ? view.position : prev.position,
      hp: Math.min(opts.vitals?.hp ?? prev.hp, view.maxHp),
      mana: Math.min(opts.vitals?.mana ?? prev.mana, view.maxMana),
    };
    const region = opts.relocate ? view.wildsRegion : prev.wildsRegion;
    if (region) this.state.wildsRegion = region;
    else delete this.state.wildsRegion;
  }
}

/** Web Locks as one browser has them: ifAvailable, steal, and the stolen holder's AbortError. */
export class FakeLocks implements LockLike {
  private held = new Map<string, (err: Error) => void>();
  request(name: string, options: { ifAvailable?: boolean; steal?: boolean }, callback: (lock: unknown) => Promise<unknown>): Promise<unknown> {
    const current = this.held.get(name);
    if (current && !options.steal) return Promise.resolve(callback(null));
    if (current) current(new Error('AbortError'));
    return new Promise((resolve, reject) => {
      this.held.set(name, reject);
      void Promise.resolve(callback({ name })).then((v) => {
        if (this.held.get(name) === reject) this.held.delete(name);
        resolve(v);
      });
    });
  }
}

export interface Rig {
  server: ReturnType<typeof fakeServer>;
  link: Link;
  session: FakeSession;
  events: Array<[string, unknown]>;
  store: ReturnType<typeof memoryOutboxStore>;
  clock: { now: number };
}

export async function rig(t: TestContext, opts: { state?: Record<string, any>; record?: OutboxRecord | null; store?: ReturnType<typeof memoryOutboxStore>; locks?: LockLike | null; server?: ReturnType<typeof fakeServer>; clientId?: string; clock?: { now: number } } = {}): Promise<Rig> {
  const server = opts.server ?? fakeServer();
  const store = opts.store ?? memoryOutboxStore();
  const events: Array<[string, unknown]> = [];
  const clock = opts.clock ?? { now: 1_000_000 };
  const link = new Link({
    api: server.api,
    clientId: opts.clientId ?? 'tab',
    accountId: 'fixture-account',
    device: 'dev',
    name: 'Hero',
    state: player(opts.state ?? S()),
    record: opts.record,
    status: 'offline',
    emit: ((e: string, p: unknown) => events.push([e, p])) as never,
    store,
    locks: opts.locks ?? null,
    channel: null,
    now: () => clock.now,
  });
  const session = new FakeSession(link.initialState());
  // Reports go out from the first lease on: by default the server keeps what they say.
  server.on('POST /api/report', (c) => {
    const kept = wire(link.server);
    kept.version += 1;
    kept.vitals.hp = Math.min(c.body.hp, kept.vitals.maxHp);
    kept.vitals.mana = Math.min(c.body.mana, kept.vitals.maxMana);
    return ackReport(() => kept)(c);
  });
  link.attach(session);
  t.after(() => link.stop());
  await link.ready();
  return { server, link, session, events, store, clock };
}

export async function online(r: Rig, state = S()): Promise<void> {
  r.server.on('POST /api/play', play(state));
  await r.link.reconnect(false);
  assert.equal(r.link.status, 'online');
}

export const toasts = (r: Rig) => r.events.filter(([e]) => e === EV.toast).map(([, p]) => (p as { text: string }).text);

/** Put a record in a store as its last owner left it. */
export function seed(store: ReturnType<typeof memoryOutboxStore>, record: OutboxRecord): void {
  store.records.set(JSON.stringify([record.account, record.device]), structuredClone(record));
}

/** Let queued microtasks and zero-delay timers run. */
export const tick = () => new Promise((r) => setTimeout(r, 0));

export type { OutboxStore };
