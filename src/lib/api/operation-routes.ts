/** Typed oneof operations: the transport and durable sender share this route definition.
 * Mixed domain routes retain their own validation and are migrated separately.
 */
import { fromJson, toJson, type DescMessage, type JsonValue, type MessageShape } from '@bufbuild/protobuf';
import type { Envelope } from '../gen/glimway/v1/state_pb.js';
import type { OperationsApi, Transport } from './operations.ts';
import type { OutboxKind } from './outbox.ts';
import { ApiError } from './errors.ts';
import { CompanionsRequestSchema, MountHomeRequestSchema, MountOutRequestSchema, StableExtendRequestSchema, StallRequestSchema } from '../gen/glimway/v1/companions_pb.js';
import { WardrobeCheckRequestSchema, WardrobeRequestSchema } from '../gen/glimway/v1/wardrobe_pb.js';
import { FishCastRequestSchema, FishSettleRequestSchema, FishCancelRequestSchema } from '../gen/glimway/v1/fishing_pb.js';
import { PurseTopUpRequestSchema } from '../gen/glimway/v1/purse_pb.js';
import { CampRequestSchema, RecoveryCollectRequestSchema } from '../gen/glimway/v1/camps_pb.js';
import { ReportRequestSchema, QuestStepRequestSchema, MarkRequestSchema, TakePaperRequestSchema, SettleEchoRequestSchema, FallRequestSchema, ProfileReportSchema, SpendRequestSchema, WildsClaimRequestSchema, WildsLanternRequestSchema, WildsClearRequestSchema, WildsLayRequestSchema, WildsLiftRequestSchema, WildsDiscoverRequestSchema } from '../gen/glimway/v1/operations_pb.js';

type ResultCase<D extends DescMessage> = MessageShape<D>['$typeName'] extends 'glimway.v1.ProfileReport'
  ? 'profile'
  : MessageShape<D>['$typeName'] extends `glimway.v1.${infer Name}Request`
    ? Extract<Uncapitalize<Name>, NonNullable<Envelope['result']['case']>>
    : never;

function route<D extends DescMessage>(schema: D, path: string, result: ResultCase<D>, dispatch: (api: OperationsApi, request: MessageShape<D>) => Promise<Envelope>) {
  return {
    schema, path, result, method: 'POST' as const, envelope: 'oneof' as const,
    async sendFrozen(api: OperationsApi, body: JsonValue): Promise<Envelope> {
      let request: MessageShape<D>;
      try { request = fromJson(schema, body, { ignoreUnknownFields: false }); }
      catch { throw new ApiError('invalid-json', { status: 400 }); }
      return dispatch(api, request);
    }
  };
}

export const operationRoutes = {
  'quest-step': route(QuestStepRequestSchema, '/api/quest/step', 'questStep', (api, req) => api.questStep(req)),
  'mark': route(MarkRequestSchema, '/api/story/mark', 'mark', (api, req) => api.mark(req)),
  'take-paper': route(TakePaperRequestSchema, '/api/papers/take', 'takePaper', (api, req) => api.takePaper(req)),
  'settle-echo': route(SettleEchoRequestSchema, '/api/wilds/echo', 'settleEcho', (api, req) => api.settleEcho(req)),
  'fall': route(FallRequestSchema, '/api/fall', 'fall', (api, req) => api.fall(req)),
  'spend': route(SpendRequestSchema, '/api/spend', 'spend', (api, req) => api.spend(req)),
  'wilds-claim': route(WildsClaimRequestSchema, '/api/wilds/claim', 'wildsClaim', (api, req) => api.wildsClaim(req)),
  'wilds-lantern': route(WildsLanternRequestSchema, '/api/wilds/lantern', 'wildsLantern', (api, req) => api.wildsLantern(req)),
  'wilds-clear': route(WildsClearRequestSchema, '/api/wilds/clear', 'wildsClear', (api, req) => api.wildsClear(req)),
  'wilds-lay': route(WildsLayRequestSchema, '/api/wilds/lay', 'wildsLay', (api, req) => api.wildsLay(req)),
  'wilds-lift': route(WildsLiftRequestSchema, '/api/wilds/lift', 'wildsLift', (api, req) => api.wildsLift(req)),
  'wilds-discover': route(WildsDiscoverRequestSchema, '/api/wilds/discover', 'wildsDiscover', (api, req) => api.wildsDiscover(req)),
  'camp': route(CampRequestSchema, '/api/camps', 'camp', (api, req) => api.camp(req)),
  'recovery-collect': route(RecoveryCollectRequestSchema, '/api/recovery/collect', 'recoveryCollect', (api, req) => api.recoveryCollect(req)),
  'companions': route(CompanionsRequestSchema, '/api/companions', 'companions', (api, req) => api.companions(req)),
  'stall': route(StallRequestSchema, '/api/stable/stall', 'stall', (api, req) => api.stall(req)),
  'mount-out': route(MountOutRequestSchema, '/api/stable/out', 'mountOut', (api, req) => api.mountOut(req)),
  'mount-home': route(MountHomeRequestSchema, '/api/stable/home', 'mountHome', (api, req) => api.mountHome(req)),
  'stable-extend': route(StableExtendRequestSchema, '/api/stable/extend', 'stableExtend', (api, req) => api.stableExtend(req)),
  'fish-cast': route(FishCastRequestSchema, '/api/fishing/cast', 'fishCast', (api, req) => api.fishCast(req)),
  'fish-settle': route(FishSettleRequestSchema, '/api/fishing/settle', 'fishSettle', (api, req) => api.fishSettle(req)),
  'fish-cancel': route(FishCancelRequestSchema, '/api/fishing/cancel', 'fishCancel', (api, req) => api.fishCancel(req)),
  'wardrobe': route(WardrobeRequestSchema, '/api/wardrobe', 'wardrobe', (api, req) => api.wardrobe(req)),
  'report': route(ReportRequestSchema, '/api/report', 'report', (api, req) => api.report(req)),
  'profile': route(ProfileReportSchema, '/api/profile', 'profile', (api, req) => api.profile(req)),
  'purse-top-up': route(PurseTopUpRequestSchema, '/api/purse/top-up', 'purseTopUp', (api, req) => api.purseTopUp(req)),
  'wardrobe-check': route(WardrobeCheckRequestSchema, '/api/wardrobe/check', 'wardrobeCheck', (api, req) => api.wardrobeCheck(req)),
};

/** The durable queue deliberately excludes credential-bearing immediate calls. */
export const queuedOperationRoutes: Partial<Record<OutboxKind, {
  schema: DescMessage; path: string; result: string
  sendFrozen: (api: OperationsApi, body: JsonValue) => Promise<Envelope>
}>> = {
  'quest-step': operationRoutes['quest-step'],
  'mark': operationRoutes['mark'],
  'take-paper': operationRoutes['take-paper'],
  'settle-echo': operationRoutes['settle-echo'],
  'fall': operationRoutes['fall'],
  'spend': operationRoutes['spend'],
  'wilds-claim': operationRoutes['wilds-claim'],
  'wilds-lantern': operationRoutes['wilds-lantern'],
  'wilds-clear': operationRoutes['wilds-clear'],
  'wilds-lay': operationRoutes['wilds-lay'],
  'wilds-lift': operationRoutes['wilds-lift'],
  'wilds-discover': operationRoutes['wilds-discover'],
  'camp': operationRoutes['camp'],
  'recovery-collect': operationRoutes['recovery-collect'],
  'companions': operationRoutes['companions'],
  'stall': operationRoutes['stall'],
  'mount-out': operationRoutes['mount-out'],
  'mount-home': operationRoutes['mount-home'],
  'stable-extend': operationRoutes['stable-extend'],
  'fish-cast': operationRoutes['fish-cast'],
  'fish-settle': operationRoutes['fish-settle'],
  'fish-cancel': operationRoutes['fish-cancel'],
  'wardrobe': operationRoutes['wardrobe'],
};

/** Preserve the facade's existing ProtoJSON defaults; never change stored bodies. */
export function operationBody<D extends DescMessage>(definition: { schema: D }, request: MessageShape<D>): JsonValue {
  return toJson(definition.schema, request, { alwaysEmitImplicit: true });
}
export function operationTransport<D extends DescMessage>(send: Transport, definition: { schema: D; path: string; method: 'POST' }, request: MessageShape<D>, extra?: Parameters<Transport>[3]): Promise<unknown> {
  return send(definition.method, definition.path, operationBody(definition, request), extra);
}
