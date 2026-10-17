import { operationRoutes, operationTransport } from './operation-routes.ts';
import { create, toJson, type JsonValue } from '@bufbuild/protobuf';
import { ApiError } from './errors.ts';
import { decodeWire } from './wire.ts';
import { decodePlayerState, validatePlayerState } from './state-contract.ts';
import { EnvelopeSchema, LoginRequestSchema, PlayRequestSchema, SessionResponseSchema, StateResponseSchema, PlayResponseSchema, WorldChooseRequestSchema, type Envelope, type LoginRequest, type PlayRequest, type SessionResponse, type StateResponse, type PlayResponse } from '../gen/glimway/v1/state_pb.js';
import { WildsMapRequestSchema, WildsMapStatusSchema, type WildsMapStatus, WildsNearResultSchema, HomesteadLandSchema, type WorldChunk, type WildsNearResult, type HomesteadLand } from '../gen/glimway/v1/wilds_pb.js';
import { decodeChunk } from './chunks.ts';
import { validateNear, validateMapStatus } from './near.ts';
import { loadWilds } from '../wilds/data.ts';
import { type CompanionsRequest, type MountHomeRequest, type MountOutRequest, type StableExtendRequest, type StallRequest } from '../gen/glimway/v1/companions_pb.js';
import { WardrobeReadSchema, type WardrobeCheckRequest, type WardrobeRead, type WardrobeRequest } from '../gen/glimway/v1/wardrobe_pb.js';
import { FishingWatersSchema, type FishCastRequest, type FishSettleRequest, type FishCancelRequest, type FishingWaters } from '../gen/glimway/v1/fishing_pb.js';
import { PurseReadSchema, type PurseRead, type PurseTopUpRequest } from '../gen/glimway/v1/purse_pb.js';
import { CampsReadSchema, RecoveryReadSchema, type CampRequest, type CampsRead, type RecoveryCollectRequest, type RecoveryRead } from '../gen/glimway/v1/camps_pb.js';
import { type ReportRequest, type QuestStepRequest, type MarkRequest, type TakePaperRequest, type SettleEchoRequest, type FallRequest, type ProfileReport, type SpendRequest, type WildsClaimRequest, type WildsLanternRequest, type WildsClearRequest, type WildsLayRequest, type WildsLiftRequest, type WildsDiscoverRequest } from '../gen/glimway/v1/operations_pb.js';

export type Transport = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, extra?: { headers?: Record<string, string>; binary?: boolean; keepalive?: boolean }) => Promise<unknown>;
/** Immediate typed calls; C2 owns sequencing, prediction and durable replay. */
export interface OperationsApi {
  login(request: LoginRequest): Promise<SessionResponse>;
  play(request: PlayRequest): Promise<PlayResponse>;
  state(lease?: string): Promise<StateResponse>;
  worldChoice(): Promise<SessionResponse>;
  worldChoose(choice: 'own' | 'party'): Promise<SessionResponse>;
  logout(): Promise<void>;
  chunk(epoch: string, layer: number, cx: number, cy: number): Promise<WorldChunk>;
  /** The open map's near read around a chunk (open-map.md 2.4). */
  near(cx: number, cy: number): Promise<WildsNearResult>;
  /** Read-only status for explored keys; never credits a visit. */
  mapStatus(explored: readonly { cx: number; cy: number }[]): Promise<WildsMapStatus>;
  homeLand(gate: number): Promise<HomesteadLand>;
  report(request: ReportRequest, options?: { keepalive?: boolean }): Promise<Envelope>;
  questStep(request: QuestStepRequest): Promise<Envelope>;
  mark(request: MarkRequest): Promise<Envelope>;
  takePaper(request: TakePaperRequest): Promise<Envelope>;
  settleEcho(request: SettleEchoRequest): Promise<Envelope>;
  fall(request: FallRequest): Promise<Envelope>;
  profile(request: ProfileReport): Promise<Envelope>;
  spend(request: SpendRequest): Promise<Envelope>;
  wildsClaim(request: WildsClaimRequest): Promise<Envelope>;
  wildsLantern(request: WildsLanternRequest): Promise<Envelope>;
  /** Paths players make and first to find (open-map.md section 3, 2.10). */
  wildsClear(request: WildsClearRequest): Promise<Envelope>;
  wildsLay(request: WildsLayRequest): Promise<Envelope>;
  wildsLift(request: WildsLiftRequest): Promise<Envelope>;
  wildsDiscover(request: WildsDiscoverRequest): Promise<Envelope>;
  /** Camps (lamps.md 2.5): set, fill, place, remove, plant; and the world's camps. */
  camp(request: CampRequest): Promise<Envelope>;
  camps(): Promise<CampsRead>;
  /** Pell's recovery crate (lamps.md 2.7): what waits, and collecting it. */
  recovery(): Promise<RecoveryRead>;
  recoveryCollect(request: RecoveryCollectRequest): Promise<Envelope>;
  /** Companions and the stable (crafts.md 6.2). */
  companions(request: CompanionsRequest): Promise<Envelope>;
  stall(request: StallRequest): Promise<Envelope>;
  mountOut(request: MountOutRequest): Promise<Envelope>;
  mountHome(request: MountHomeRequest): Promise<Envelope>;
  stableExtend(request: StableExtendRequest): Promise<Envelope>;
  fishCast(request: FishCastRequest): Promise<Envelope>;
  fishSettle(request: FishSettleRequest): Promise<Envelope>;
  fishCancel(request: FishCancelRequest): Promise<Envelope>;
  /** Each water's band in an area (design crafts 5.4: the band and nothing else). */
  fishingWaters(area: string): Promise<FishingWaters>;
  /**
   * The gold purse (purse-and-wardrobe.md 2.2): a top-up carries the Habitica
   * token in this one request and nowhere else. It never goes through the
   * outbox (which stores bodies) or a replay.
   */
  purseTopUp(request: PurseTopUpRequest): Promise<Envelope>;
  /** Today's top-ups, the last 50 top-ups and glim lines (GET /api/purse). */
  purse(): Promise<PurseRead>;
  /** The wardrobe (purse-and-wardrobe.md 4, 6.2): the choice (keyed), the picker's read, and Check for new gear. */
  wardrobe(request: WardrobeRequest): Promise<Envelope>;
  wardrobeRead(): Promise<WardrobeRead>;
  /** Carries the Habitica token for this one read: never keyed, never queued, never kept (4.3). */
  wardrobeCheck(request: WardrobeCheckRequest): Promise<Envelope>;
}
function validated<T>(read: () => T): T {
  try { return read(); } catch { throw new ApiError('bad-response', { status: 200 }); }
}
export function decodeEnvelope(raw: unknown): Envelope {
  return validated(() => {
    const out = decodeWire(EnvelopeSchema, raw);
    if (!out.state || !out.result.case) throw new Error('missing envelope');
    validatePlayerState(out.state);
    if (out.result.case === 'report') {
      const ack = out.result.value;
      if (!ack.client || !ack.generation || !Number.isSafeInteger(ack.seq) || ack.seq < 1 || !Number.isSafeInteger(ack.basis) || ack.basis < 0 || !Number.isSafeInteger(ack.casts) || ack.casts < 0 || (!ack.accepted && ack.casts !== 0) || (ack.accepted && ack.staleBasis)) throw new Error('invalid report acknowledgment');
    }
    return out;
  });
}
export function createOperationsApi(send: Transport): OperationsApi {
  return {
    async login(req) { return validatedSession(await send('POST', '/api/session', toJson(LoginRequestSchema, req))); },
    async play(req) { const raw = await send('POST', '/api/play', toJson(PlayRequestSchema, req)); return validated(() => { const out = decodeWire(PlayResponseSchema, raw); if (!out.state || !out.lease || !out.reportGeneration || !out.reportClient) throw new Error('missing play fields'); validatePlayerState(out.state); return out; }); },
    async state(lease) { const raw = await send('GET', '/api/state', undefined, lease ? { headers: { 'X-Play-Lease': lease } } : {}); return validated(() => { const out = decodeWire(StateResponseSchema, raw); if (!out.state) throw new Error('missing state'); validatePlayerState(out.state); return out; }); },
    async worldChoice() { return validatedSession(await send('GET', '/api/world/choice')); },
    async worldChoose(choice) { return validatedSession(await send('POST', '/api/world/choose', toJson(WorldChooseRequestSchema, create(WorldChooseRequestSchema, { choice })))); },
    async logout() { await send('DELETE', '/api/session'); },
    async chunk(epoch, layer, cx, cy) { const raw = await send('GET', `/api/wilds/chunk/${encodeURIComponent(epoch)}/${layer}/${cx}/${cy}`, undefined, { binary: true }); return validated(() => { if (!(raw instanceof Uint8Array)) throw new Error('missing binary chunk'); const chunk = decodeChunk(raw); if (chunk.epochId !== epoch || chunk.layer !== layer || chunk.cx !== cx || chunk.cy !== cy) throw new Error("chunk identity mismatch"); return chunk; }); },
    async mapStatus(explored) {
      const req = create(WildsMapRequestSchema, { explored: explored.map((k) => ({ ...k, realm: loadWilds().realm, layer: 0 })) });
      const raw = await send('POST', '/api/wilds/map', toJson(WildsMapRequestSchema, req));
      return validated(() => validateMapStatus(decodeWire(WildsMapStatusSchema, raw), explored));
    },
    async near(cx, cy) { const raw = await send('GET', `/api/wilds/near/${cx}/${cy}`); return validated(() => validateNear(decodeWire(WildsNearResultSchema, raw), cx, cy)); },
    async homeLand(gate) { const raw = await send('GET', `/api/homestead/land/${gate}`); return validated(() => {
      const out = decodeWire(HomesteadLandSchema, raw);
      if (!out.width || !out.height || out.width > 128 || out.height > 128 || out.cells.length !== out.width * out.height || out.generatorVersion !== 2 || out.cells.some(c => !['grass', 'tree', 'stump', 'boulder', 'water', 'ford', 'slope', 'edge', 'path'].includes(c))) throw new Error('invalid home land');
      return out;
    }); },
    async report(req, options = {}) { return decodeEnvelope(await operationTransport(send, operationRoutes['report'], req, { keepalive: options.keepalive })); },
    async questStep(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['quest-step'], req)); },
    async mark(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['mark'], req)); },
    async takePaper(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['take-paper'], req)); },
    async settleEcho(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['settle-echo'], req)); },
    async fall(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['fall'], req)); },
    async profile(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['profile'], req)); },
    async spend(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['spend'], req)); },
    async wildsClaim(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['wilds-claim'], req)); },
    async wildsLantern(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['wilds-lantern'], req)); },
    async wildsClear(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['wilds-clear'], req)); },
    async wildsLay(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['wilds-lay'], req)); },
    async wildsLift(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['wilds-lift'], req)); },
    async wildsDiscover(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['wilds-discover'], req)); },
    async camp(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['camp'], req)); },
    async camps() { return decodeMixed(await send('GET', '/api/camps'), (r) => decodeWire(CampsReadSchema, r)).result; },
    async recovery() { return decodeMixed(await send('GET', '/api/recovery'), (r) => decodeWire(RecoveryReadSchema, r)).result; },
    async recoveryCollect(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['recovery-collect'], req)); },
    async companions(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['companions'], req)); },
    async stall(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['stall'], req)); },
    async mountOut(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['mount-out'], req)); },
    async mountHome(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['mount-home'], req)); },
    async stableExtend(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['stable-extend'], req)); },
    async fishCast(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['fish-cast'], req)); },
    async fishSettle(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['fish-settle'], req)); },
    async fishCancel(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['fish-cancel'], req)); },
    async purseTopUp(req) {
      const out = decodeEnvelope(await operationTransport(send, operationRoutes['purse-top-up'], req));
      if (out.result.case !== 'purseTopUp' || !out.result.value.topUp) throw new ApiError('bad-response', { status: 200 });
      return out;
    },
    // Domain reads answer the mixed { state, result } envelope; the read's own message is the result.
    async purse() { return decodeMixed(await send('GET', '/api/purse'), (r) => {
      const out = decodeWire(PurseReadSchema, r);
      if (!out.purse || out.purse.topUpsLeft < 0 || out.purse.glimsLeft < 0) throw new Error('invalid purse');
      return out;
    }).result; },
    async fishingWaters(area) { const raw = await send('GET', `/api/fishing/waters?area=${encodeURIComponent(area)}`); return validated(() => {
      const out = decodeWire(FishingWatersSchema, raw);
      for (const w of out.waters) if (!w.id) throw new Error('invalid water');
      return out;
    }); },
    async wardrobe(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['wardrobe'], req)); },
    async wardrobeRead() { return decodeMixed(await send('GET', '/api/wardrobe'), (r) => decodeWire(WardrobeReadSchema, r)).result; },
    async wardrobeCheck(req) { return decodeEnvelope(await operationTransport(send, operationRoutes['wardrobe-check'], req)); },
  };
}
export function validatedSession(raw: unknown): SessionResponse {
  return validated(() => {
    const out = decodeWire(SessionResponseSchema, raw);
    if (out.answer.case === 'state') validatePlayerState(out.answer.value);
    else if (out.answer.case !== 'worldChoice' || !out.answer.value.habiticaId) throw new Error('missing session answer');
    return out;
  });
}
/** Exercise the real codecs without an HTTP server. Responses are consumed once. */
export class FakeOperations {
  readonly calls: { method: string; path: string; body?: unknown }[] = [];
  readonly responses = new Map<string, (JsonValue | Uint8Array | Error)[]>();
  readonly api = createOperationsApi(async (method, path, body) => {
    this.calls.push({ method, path, body: structuredClone(body) });
    const response = this.responses.get(path)?.shift();
    if (response === undefined) throw new ApiError('not-implemented', { status: 501 });
    if (response instanceof Error) throw response;
    return structuredClone(response);
  });
}

/** Existing domains retain only their result object inside the mixed envelope. */
export function decodeMixed<T>(raw: unknown, parseResult: (raw: unknown) => T): { state: import('../gen/glimway/v1/state_pb.js').PlayerState; result: T } {
  return validated(() => {
    if (!raw || typeof raw !== 'object' || !('state' in raw) || !('result' in raw)) throw new Error('missing mixed envelope');
    return { state: decodePlayerState(raw.state), result: parseResult(raw.result) };
  });
}
