/**
 * The Wilds' keyed operations (server-first.md 2.2): claim, relight and
 * settle-echo. Each sends `where` (the region's area, `wilds:<region>`, and
 * the hero's region-wide pixels) under the link's lease and a fresh key; the
 * server checks reach, the epoch and the stored chunk, and answers with its
 * result and the player's current state.
 *
 * C2's outbox will carry these like every other operation; until then they go
 * straight through the session's typed API.
 */
import { create } from '@bufbuild/protobuf';
import { newKey } from '../../lib/api/client.ts';
import { errorCode, type ApiErrorCode } from '../../lib/api/errors.ts';
import type { Envelope } from '../../lib/gen/glimway/v1/state_pb.js';
import {
  SettleEchoRequestSchema,
  WildsClaimRequestSchema,
  WildsLanternRequestSchema,
  type SettleEchoResult,
  type WildsClaimResult,
  type WildsLanternResult,
} from '../../lib/gen/glimway/v1/operations_pb.js';
import type { OperationsApi } from '../../lib/api/operations.ts';
import type { Session } from '../session.ts';

export type Outcome<T> = { ok: true; result: T } | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' | 'busy' };

/** Where the hero stands, as the server reads it. */
export interface WildsWhere {
  region: string;
  /** Region-wide pixels. */
  x: number;
  y: number;
}

async function send<T>(session: Session, call: (ops: OperationsApi, op: { lease: string; key: string }) => Promise<Envelope>, pick: (e: Envelope) => T | undefined): Promise<Outcome<T>> {
  const link = session.link;
  if (!link) return { ok: false, code: 'offline' };
  if (link.busy) return { ok: false, code: 'busy' };
  if (link.status !== 'online' || !link.lease) return { ok: false, code: link.status === 'superseded' ? 'superseded' : 'offline' };
  try {
    const result = pick(await call(link.api.operations, { lease: link.lease, key: newKey() }));
    return result === undefined ? { ok: false, code: 'bad-response' } : { ok: true, result };
  } catch (err) {
    return { ok: false, code: errorCode(err) };
  }
}

const whereOf = (w: WildsWhere) => ({ area: `wilds:${w.region}`, x: w.x, y: w.y });

export function claimEntity(session: Session, req: { epoch: string; entityId: string; cycle: number; where: WildsWhere }): Promise<Outcome<WildsClaimResult>> {
  return send(
    session,
    (ops, op) => ops.wildsClaim(create(WildsClaimRequestSchema, { op, epoch: req.epoch, entityId: req.entityId, cycle: req.cycle, where: whereOf(req.where) })),
    (e) => (e.result.case === 'wildsClaim' ? e.result.value : undefined)
  );
}

export function relightLantern(session: Session, req: { epoch: string; ownerId: string; lanternId: string; where: WildsWhere }): Promise<Outcome<WildsLanternResult>> {
  return send(
    session,
    (ops, op) => ops.wildsLantern(create(WildsLanternRequestSchema, { op, epoch: req.epoch, ownerId: req.ownerId, lanternId: req.lanternId, where: whereOf(req.where) })),
    (e) => (e.result.case === 'wildsLantern' ? e.result.value : undefined)
  );
}

export function settleEcho(session: Session, req: { epoch: string; site: string; member: string; where: WildsWhere }): Promise<Outcome<SettleEchoResult>> {
  return send(
    session,
    (ops, op) => ops.settleEcho(create(SettleEchoRequestSchema, { op, epoch: req.epoch, site: req.site, member: req.member, where: whereOf(req.where) })),
    (e) => (e.result.case === 'settleEcho' ? e.result.value : undefined)
  );
}
