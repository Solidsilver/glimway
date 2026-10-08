/**
 * The Wilds' keyed operations (server-first.md 2.2): claim, relight and
 * settle-echo. Each sends `where` (the region's area, `wilds:<region>`, and
 * the hero's region-wide pixels); the server checks reach, the epoch and the
 * stored chunk. They go through the link's outbox like every other
 * operation: one at a time, replayed with their key if an answer is lost,
 * and their answers' state adopted.
 */
import type { ApiErrorCode } from '../../lib/api/errors.ts';
import type { SettleEchoResult, WildsClaimResult, WildsLanternResult } from '../../lib/gen/glimway/v1/operations_pb.js';
import type { Session } from '../session.ts';

export type Outcome<T> = { ok: true; result: T } | { ok: false; code: ApiErrorCode | 'offline' | 'superseded' | 'busy' | 'pending' };

/** Where the hero stands, as the server reads it. */
export interface WildsWhere {
  region: string;
  /** Region-wide pixels. */
  x: number;
  y: number;
}

const whereOf = (w: WildsWhere) => ({ area: `wilds:${w.region}`, x: w.x, y: w.y });

export function claimEntity(session: Session, req: { epoch: string; entityId: string; cycle: number; where: WildsWhere }): Promise<Outcome<WildsClaimResult>> {
  const link = session.link;
  if (!link) return Promise.resolve({ ok: false, code: 'offline' });
  return link.wildsClaim({ epoch: req.epoch, entityId: req.entityId, cycle: req.cycle, where: whereOf(req.where) });
}

export function relightLantern(session: Session, req: { epoch: string; ownerId: string; lanternId: string; where: WildsWhere }): Promise<Outcome<WildsLanternResult>> {
  const link = session.link;
  if (!link) return Promise.resolve({ ok: false, code: 'offline' });
  return link.wildsRelight({ epoch: req.epoch, ownerId: req.ownerId, lanternId: req.lanternId, where: whereOf(req.where) });
}

export function settleEcho(session: Session, req: { epoch: string; site: string; member: string; where: WildsWhere }): Promise<Outcome<SettleEchoResult>> {
  const link = session.link;
  if (!link) return Promise.resolve({ ok: false, code: 'offline' });
  return link.settleEcho({ epoch: req.epoch, site: req.site, member: req.member, where: whereOf(req.where) });
}
