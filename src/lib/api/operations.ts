import { create, toJson, type JsonValue } from '@bufbuild/protobuf';
import { ApiError } from './errors.ts';
import { decodeWire } from './wire.ts';
import { decodePlayerState, validatePlayerState } from './state-contract.ts';
import { EnvelopeSchema, LoginRequestSchema, PlayRequestSchema, SessionResponseSchema, StateResponseSchema, PlayResponseSchema, WorldChooseRequestSchema, type Envelope, type LoginRequest, type PlayRequest, type SessionResponse, type StateResponse, type PlayResponse } from '../gen/glimway/v1/state_pb.js';
import { WildsRegionResultSchema, HomesteadLandSchema, type WildsChunk, type WildsRegionResult, type HomesteadLand } from '../gen/glimway/v1/wilds_pb.js';
import { decodeChunk } from './chunks.ts';
import { CompanionsRequestSchema, MountHomeRequestSchema, MountOutRequestSchema, StableExtendRequestSchema, StallRequestSchema, type CompanionsRequest, type MountHomeRequest, type MountOutRequest, type StableExtendRequest, type StallRequest } from '../gen/glimway/v1/companions_pb.js';
import { WardrobeCheckRequestSchema, WardrobeReadSchema, WardrobeRequestSchema, type WardrobeCheckRequest, type WardrobeRead, type WardrobeRequest } from '../gen/glimway/v1/wardrobe_pb.js';
import { FishCastRequestSchema, FishSettleRequestSchema, FishCancelRequestSchema, FishingWatersSchema, type FishCastRequest, type FishSettleRequest, type FishCancelRequest, type FishingWaters } from '../gen/glimway/v1/fishing_pb.js';
import { PurseReadSchema, PurseTopUpRequestSchema, type PurseRead, type PurseTopUpRequest } from '../gen/glimway/v1/purse_pb.js';
import { ReportRequestSchema, type ReportRequest, QuestStepRequestSchema, type QuestStepRequest, MarkRequestSchema, type MarkRequest, TakePaperRequestSchema, type TakePaperRequest, SettleEchoRequestSchema, type SettleEchoRequest, FallRequestSchema, type FallRequest, ProfileReportSchema, type ProfileReport, SpendRequestSchema, type SpendRequest, WildsClaimRequestSchema, type WildsClaimRequest, WildsLanternRequestSchema, type WildsLanternRequest } from '../gen/glimway/v1/operations_pb.js';

export type Transport = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown, extra?: { headers?: Record<string, string>; binary?: boolean; keepalive?: boolean }) => Promise<unknown>;
/** Immediate typed calls; C2 owns sequencing, prediction and durable replay. */
export interface OperationsApi {
  login(request: LoginRequest): Promise<SessionResponse>;
  play(request: PlayRequest): Promise<PlayResponse>;
  state(lease?: string): Promise<StateResponse>;
  worldChoice(): Promise<SessionResponse>;
  worldChoose(choice: 'own' | 'party'): Promise<SessionResponse>;
  logout(): Promise<void>;
  chunk(epoch: string, layer: number, cx: number, cy: number): Promise<WildsChunk>;
  region(region: string): Promise<WildsRegionResult>;
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
  /** The purse, the last 50 top-ups and gold lines (GET /api/purse). */
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
    async region(region) { const raw = await send('GET', `/api/wilds/region/${encodeURIComponent(region)}`); return validated(() => {
      const out = decodeWire(WildsRegionResultSchema, raw);
      if (!out.epoch?.id || !out.epoch.worldSeed || !['inner-1', 'outer-1'].includes(out.epoch.regionId) || out.epoch.generatorVersion !== 2 || out.epoch.regionId !== region) throw new Error('invalid epoch authority');
      for (const entity of out.entities) if (!entity.id || entity.epoch !== out.epoch.id || !Number.isSafeInteger(entity.cycle) || entity.cycle < 0 || !['available', 'cleared', 'harvested', 'charted'].includes(entity.state)) throw new Error('invalid mutable entity');
      for (const qty of Object.values(out.materials)) if (!Number.isSafeInteger(qty) || qty < 0) throw new Error('invalid material balance');
      return out;
    }); },
    async homeLand(gate) { const raw = await send('GET', `/api/homestead/land/${gate}`); return validated(() => {
      const out = decodeWire(HomesteadLandSchema, raw);
      if (!out.width || !out.height || out.width > 128 || out.height > 128 || out.cells.length !== out.width * out.height || out.generatorVersion !== 2 || out.cells.some(c => !['grass', 'tree', 'stump', 'boulder', 'water', 'ford', 'slope', 'edge', 'path'].includes(c))) throw new Error('invalid home land');
      return out;
    }); },
    async report(req, options = {}) { return decodeEnvelope(await send('POST', '/api/report', toJson(ReportRequestSchema, req, { alwaysEmitImplicit: true }), { keepalive: options.keepalive })); },
    async questStep(req) { return decodeEnvelope(await send('POST', '/api/quest/step', toJson(QuestStepRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async mark(req) { return decodeEnvelope(await send('POST', '/api/story/mark', toJson(MarkRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async takePaper(req) { return decodeEnvelope(await send('POST', '/api/papers/take', toJson(TakePaperRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async settleEcho(req) { return decodeEnvelope(await send('POST', '/api/wilds/echo', toJson(SettleEchoRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async fall(req) { return decodeEnvelope(await send('POST', '/api/fall', toJson(FallRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async profile(req) { return decodeEnvelope(await send('POST', '/api/profile', toJson(ProfileReportSchema, req, { alwaysEmitImplicit: true }))); },
    async spend(req) { return decodeEnvelope(await send('POST', '/api/spend', toJson(SpendRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async wildsClaim(req) { return decodeEnvelope(await send('POST', '/api/wilds/claim', toJson(WildsClaimRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async wildsLantern(req) { return decodeEnvelope(await send('POST', '/api/wilds/lantern', toJson(WildsLanternRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async companions(req) { return decodeEnvelope(await send('POST', '/api/companions', toJson(CompanionsRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async stall(req) { return decodeEnvelope(await send('POST', '/api/stable/stall', toJson(StallRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async mountOut(req) { return decodeEnvelope(await send('POST', '/api/stable/out', toJson(MountOutRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async mountHome(req) { return decodeEnvelope(await send('POST', '/api/stable/home', toJson(MountHomeRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async stableExtend(req) { return decodeEnvelope(await send('POST', '/api/stable/extend', toJson(StableExtendRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async fishCast(req) { return decodeEnvelope(await send('POST', '/api/fishing/cast', toJson(FishCastRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async fishSettle(req) { return decodeEnvelope(await send('POST', '/api/fishing/settle', toJson(FishSettleRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async fishCancel(req) { return decodeEnvelope(await send('POST', '/api/fishing/cancel', toJson(FishCancelRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async purseTopUp(req) {
      const out = decodeEnvelope(await send('POST', '/api/purse/top-up', toJson(PurseTopUpRequestSchema, req, { alwaysEmitImplicit: true })));
      if (out.result.case !== 'purseTopUp' || !out.result.value.topUp) throw new ApiError('bad-response', { status: 200 });
      return out;
    },
    async purse() { const raw = await send('GET', '/api/purse'); return validated(() => {
      // The read's own message; a mixed { state, result } answer is read the same way.
      const body = raw && typeof raw === 'object' && 'result' in raw && 'state' in raw ? (raw as { result: unknown }).result : raw;
      const out = decodeWire(PurseReadSchema, body);
      if (!out.purse || out.purse.gold < 0 || out.purse.topUpsLeft < 0) throw new Error('invalid purse');
      return out;
    }); },
    async fishingWaters(area) { const raw = await send('GET', `/api/fishing/waters?area=${encodeURIComponent(area)}`); return validated(() => {
      const out = decodeWire(FishingWatersSchema, raw);
      for (const w of out.waters) if (!w.id) throw new Error('invalid water');
      return out;
    }); },
    async wardrobe(req) { return decodeEnvelope(await send('POST', '/api/wardrobe', toJson(WardrobeRequestSchema, req, { alwaysEmitImplicit: true }))); },
    async wardrobeRead() { const raw = await send('GET', '/api/wardrobe'); return validated(() => decodeWire(WardrobeReadSchema, raw)); },
    async wardrobeCheck(req) { return decodeEnvelope(await send('POST', '/api/wardrobe/check', toJson(WardrobeCheckRequestSchema, req, { alwaysEmitImplicit: true }))); },
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
