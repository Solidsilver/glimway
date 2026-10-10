/**
 * The report pump (design server-first 2.2, "Reports"), out of the link
 * (src/game/link.ts): what goes when a report is sent (the captured one, or
 * the next one frozen now), the page-hide keepalive, and the barrier a
 * vitals-dependent operation carries. The link keeps the queue, the timers
 * and what an answer means for the screen (`ReportHost`); the book of
 * sequences is src/lib/api/reports.ts.
 *
 * No Phaser: the link's node rig (tests/helpers/link-rig.ts) drives it.
 */
import { create } from '@bufbuild/protobuf';
import { ApiError, errorCode, isOutboxClientBug, isSettledRefusal } from './errors.ts';
import type { WhereJson } from './predict.ts';
import type { CapturedReport, ReportAck, ReportBook } from './reports.ts';
import { ReportRequestSchema, type ReportRequest } from '../gen/glimway/v1/operations_pb.js';
import type { Envelope, PlayerState } from '../gen/glimway/v1/state_pb.js';

/** A barrier asks for a fresh report at most this many times before backing off. */
const BARRIER_TRIES = 3;

/** The last acknowledged report a vitals-dependent operation names. */
export type ReportBarrier = { client: string; generation: string; seq: number };

/** What the pump needs from the link. */
export interface ReportHost {
  readonly reports: ReportBook;
  /** The lease the request carries ('' without one). */
  lease(): string;
  /** The world's vitals watermark, as the newest adopted state says. */
  vitalsSet(): number;
  /** The basis a report starts from after a server vitals write. */
  basis(): number;
  /** The screen's place and vitals into the next report. */
  noteLive(): void;
  saveRecord(): Promise<'saved' | 'fenced' | 'failed'>;
  /** One report: through the API's retries, or (`keepalive`) straight out as the page closes. */
  send(request: ReportRequest, keepalive?: boolean): Promise<Envelope>;
  answered(): void;
  /** No trustworthy answer: back off, the captured report goes again. */
  stalled(err: unknown): void;
  /** An answer that stops sending (a retired generation, a client bug, sign-out). */
  stopFor(err: unknown): void;
  /** Adopt a report's answer (its acknowledgment moves the vitals overlay). */
  adopt(state: PlayerState | null | undefined, ctx: { captured: CapturedReport; ack?: ReportAck }): void;
  /** A refusal's state, read: adopted unless it is older than the one held. */
  adoptRead(state: PlayerState | null | undefined): void;
  /** The world didn't take the place `refused` names (link.ts followServerPlace). */
  followServerPlace(refused: WhereJson, opts?: { otherArea?: boolean }): void;
  /** A report is wanted after whatever is in flight. */
  want(): void;
}

export class ReportPump {
  /** The answer to the last report this tab heard back on (a barrier may stand on it alone). */
  private lastAck: ReportAck | null = null;

  private readonly host: ReportHost;

  constructor(host: ReportHost) {
    this.host = host;
  }

  /** Send a report: the captured one, or the next one frozen now (`force`: even with nothing new). */
  async sendReport(force: boolean): Promise<{ ok: boolean; sent?: CapturedReport; ack?: ReportAck | null }> {
    const h = this.host;
    const c = h.reports.capture(force);
    if (!c) return { ok: true };
    if ((await h.saveRecord()) === 'fenced') return { ok: false };
    try {
      const env = await h.send(this.request(c));
      h.answered();
      const ack = env.result.case === 'report' ? (env.result.value as ReportAck) : null;
      const retired = ack ? h.reports.ack(ack) : null;
      if (!retired) {
        // Not the answer to this report: it stays captured and goes again.
        h.stalled(new ApiError('bad-response', { status: 200 }));
        return { ok: false };
      }
      this.lastAck = ack;
      h.adopt(env.state, { captured: retired, ack: ack ?? undefined });
      // The world kept its own place over this one (it moved the hero since):
      // if the hero still stands where the report said, they go where it says.
      if (ack?.accepted && !ack.staleBasis && ack.placeIgnored) h.followServerPlace(retired.place, { otherArea: true });
      await h.saveRecord();
      return { ok: true, sent: retired, ack };
    } catch (err) {
      const code = errorCode(err);
      if (isSettledRefusal(err) && code === 'invalid-position') {
        // The world doesn't take this place at all (a room it doesn't know, a
        // place the content lost): the report goes, and the hero goes where
        // the world says they are.
        h.answered();
        h.reports.drop();
        h.adoptRead(err.state);
        h.followServerPlace(c.place);
        await h.saveRecord();
        return { ok: true };
      }
      if (code === 'superseded' || code === 'playing-elsewhere') {
        // A retired generation: its captured report never moves to a new one.
        h.reports.drop();
      } else if (isOutboxClientBug(err)) {
        // Its values can't be read: drop it rather than send it forever.
        h.reports.drop();
      }
      h.stopFor(err);
      return { ok: false };
    }
  }

  /** Page hide: the report goes now with keepalive, unqueued (`leaving`), or soon. */
  sendNow(leaving: boolean): void {
    const h = this.host;
    // Leaving: the newest report, even past one still in flight (it may be
    // older than what the screen shows now, and the page won't be here for its answer).
    const c = leaving ? h.reports.leaving() : h.reports.capture(false);
    if (!c || !leaving) {
      h.want();
      return;
    }
    void h.send(this.request(c), true).then(
      (env) => {
        const ack = env.result.case === 'report' ? (env.result.value as ReportAck) : null;
        const retired = ack ? h.reports.ack(ack) : null;
        if (retired) h.adopt(env.state, { captured: retired, ack: ack ?? undefined });
      },
      () => undefined
    );
  }

  /**
   * The report barrier (2.2): a rest, a consumable or a profile reads the
   * stored vitals, so the server must hold what the screen shows. First the
   * captured report (immutable) is settled, then the next one, covering the
   * live state now, is frozen and flushed. Only its accepted acknowledgment
   * on the current vitals basis is a barrier. When nothing has happened on
   * screen since the last acknowledged report and that acknowledgment is
   * such a barrier, it is the barrier: no twin report goes (review F5). Null
   * when it can't be had now: every waiting caller has heard why.
   */
  async barrier(): Promise<ReportBarrier | null> {
    const h = this.host;
    if (h.reports.captured && !(await this.sendReport(false)).ok) return null;
    h.noteLive();
    if (this.standing()) return h.reports.barrier();
    for (let i = 0; i < BARRIER_TRIES; i++) {
      h.noteLive();
      const r = await this.sendReport(true);
      if (!r.ok) return null;
      const ack = r.ack;
      if (!r.sent || !ack) break;
      if (ack.accepted && !ack.staleBasis && ack.basis >= h.vitalsSet()) return { client: ack.client, generation: ack.generation, seq: ack.seq };
      // Its basis was older than the server's vitals: report again from the vitals it holds.
      h.reports.reset(h.basis());
    }
    // No fresh acknowledgment to be had: try again later.
    h.stalled(new ApiError('report-required'));
    return null;
  }

  /**
   * The last acknowledgment still covers the screen: it answered the last
   * report this generation sent, accepted on the vitals the world holds now
   * (the server's own barrier rule), and nothing has been noted since.
   */
  private standing(): boolean {
    const a = this.lastAck;
    const r = this.host.reports;
    if (!a || r.captured || r.next.changed || r.next.boundary !== null) return false;
    if (a.client !== r.client || a.generation !== r.generation || a.seq !== r.acked) return false;
    return a.accepted && !a.staleBasis && a.basis >= this.host.vitalsSet();
  }

  private request(c: CapturedReport): ReportRequest {
    return create(ReportRequestSchema, { lease: this.host.lease(), client: c.client, generation: c.generation, seq: c.seq, basis: c.basis, place: c.place, hp: c.hp, mana: c.mana, casts: c.casts, abilityCasts: c.abilityCasts });
  }
}
