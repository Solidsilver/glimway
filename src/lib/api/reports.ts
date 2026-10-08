/**
 * Reports (design server-first 2.2 "Reports" and 2.4 "Tab and report
 * ownership"): what the screen shows of place and vitals, plus the
 * signature casts made since the last report, sent about every 10 seconds.
 *
 * Two reports at most exist at a time:
 * - the **captured** one: immutable once its sequence is allocated. A retry
 *   sends exactly it again; a lost sequence's casts never enter its
 *   successor.
 * - the **next** one, coalescing: casts summed, the latest place and vitals.
 *
 * Every report names its `basis`, the server's `vitalsSetVersion` its
 * vitals start from. A server vitals write (a rest, a fall, a refill) is a
 * causal boundary: combat captured before it is never sent against the new
 * state. A fall made offline is a boundary whose basis is not known yet, so
 * the next report waits for that fall's answer (`boundary`).
 *
 * No network here; the link sends what this book captures.
 */
import type { WhereJson } from './predict.ts';

/** One report as sent: ProtoJSON `ReportRequest` without the lease. */
export interface CapturedReport {
  client: string;
  generation: string;
  seq: number;
  basis: number;
  place: WhereJson;
  hp: number;
  mana: number;
  casts: number;
}

export interface NextReport {
  place: WhereJson | null;
  hp: number;
  mana: number;
  casts: number;
  basis: number;
  /** An unanswered fall (outbox id): the next report waits for its answer. */
  boundary: number | null;
  /** Anything to say since the last capture. */
  changed: boolean;
}

/** What a page keeps of its reports across a reload (the outbox record). */
export interface StoredReports {
  client: string;
  generation: string;
  /** The last sequence allocated in that generation. */
  seq: number;
  next: NextReport;
  captured: CapturedReport | null;
}

/** `ReportResult`, as the envelope carries it. */
export interface ReportAck {
  client: string;
  generation: string;
  seq: number;
  accepted: boolean;
  staleBasis: boolean;
  casts: number;
  basis: number;
  placeIgnored: boolean;
}

export const REPORT_INTERVAL_MS = 10_000;

const blank = (basis: number): NextReport => ({ place: null, hp: 0, mana: 0, casts: 0, basis, boundary: null, changed: false });

export class ReportBook {
  client = '';
  generation = '';
  /** The last sequence allocated in this generation. */
  seq = 0;
  next: NextReport = blank(0);
  captured: CapturedReport | null = null;
  /** The last acknowledged sequence in this generation (a barrier names it). */
  acked = 0;
  /** The place area the last captured report named ('' before any): an arrival elsewhere is reported. */
  reportedArea = '';

  constructor(stored?: StoredReports | null) {
    if (!stored) return;
    this.client = stored.client;
    this.generation = stored.generation;
    this.seq = stored.seq;
    this.next = { ...stored.next };
    this.captured = stored.captured ? { ...stored.captured } : null;
  }

  stored(): StoredReports {
    return { client: this.client, generation: this.generation, seq: this.seq, next: { ...this.next }, captured: this.captured ? { ...this.captured } : null };
  }

  /**
   * The lease's report identity. The same tab's lease keeps its generation,
   * ordering and captured report; a new generation starts over and never
   * takes a captured report along. `serverSeq` is the server's sequence for
   * that generation (a reload may have lost the last allocation).
   */
  bind(client: string, generation: string, serverSeq: number, serverGeneration: string): void {
    if (client !== this.client || generation !== this.generation) {
      this.captured = null;
      this.seq = 0;
      this.acked = 0;
    }
    this.client = client;
    this.generation = generation;
    if (serverGeneration === generation) {
      this.seq = Math.max(this.seq, serverSeq);
      this.acked = Math.max(this.acked, serverSeq);
    }
  }

  /** The screen's latest place and vitals. */
  note(place: WhereJson, hp: number, mana: number): void {
    const n = this.next;
    if (n.place && n.place.area === place.area && n.place.x === place.x && n.place.y === place.y && n.hp === hp && n.mana === mana) return;
    this.next = { ...n, place: { ...place }, hp, mana, changed: true };
  }

  /** A signature cast (a mend, a strike) happened on screen. */
  cast(n = 1): void {
    this.next = { ...this.next, casts: this.next.casts + n, changed: true };
  }

  get due(): boolean {
    return !!this.captured || (this.next.changed && this.next.boundary === null && !!this.next.place);
  }

  /**
   * A server vitals write the client didn't predict (a rest, a refill): what
   * was coalesced before it is history. The place and vitals noted next
   * start from `basis`.
   */
  reset(basis: number): void {
    this.next = { ...blank(basis), place: this.next.place, hp: this.next.hp, mana: this.next.mana };
  }

  /**
   * A fall was queued (outbox `id`): earlier combat is void, and the next
   * report waits for its answer. The hero wakes at `place` with `vitals`,
   * written here together so a reload sees the fall and its recovery at once.
   */
  fall(id: number, place: WhereJson, vitals: { hp: number; mana: number }): void {
    this.next = { ...blank(this.next.basis), place: { ...place }, hp: vitals.hp, mana: vitals.mana, boundary: id };
  }

  /** Back to a stored book (a fall that never reached the outbox). */
  restore(stored: StoredReports): void {
    this.next = { ...stored.next };
    this.captured = stored.captured ? { ...stored.captured } : null;
    this.seq = stored.seq;
  }

  /** That fall was answered (or dropped): what happened after it reports against `basis`. */
  release(id: number, basis: number): void {
    if (this.next.boundary !== id) return;
    this.next = { ...this.next, boundary: null, basis, changed: true };
  }

  /**
   * The report to send now: the captured one again, or the next one frozen
   * under a new sequence. `force` captures even with nothing new (a barrier
   * needs a fresh acknowledgment). Null while a fall's answer is awaited or
   * before the lease names a generation.
   */
  capture(force = false): CapturedReport | null {
    if (this.captured) return this.captured;
    const n = this.next;
    if (!this.generation || !n.place || n.boundary !== null || (!n.changed && !force)) return null;
    this.seq += 1;
    this.reportedArea = n.place.area;
    this.captured = { client: this.client, generation: this.generation, seq: this.seq, basis: n.basis, place: { ...n.place }, hp: n.hp, mana: n.mana, casts: n.casts };
    this.next = { ...n, casts: 0, changed: false };
    return this.captured;
  }

  /**
   * The answer to a captured report. Returns it when it matches (retired),
   * or null for an answer to some other report. Duplicates and stale-basis
   * answers retire it too: nothing ignored is ever sent again.
   */
  ack(ack: ReportAck): CapturedReport | null {
    const c = this.captured;
    if (!c || ack.client !== c.client || ack.generation !== c.generation || ack.seq !== c.seq) return null;
    this.captured = null;
    this.acked = Math.max(this.acked, c.seq);
    return c;
  }

  /** The barrier a vitals-dependent operation carries: the last acknowledged report. */
  barrier(): { client: string; generation: string; seq: number } | null {
    return this.acked > 0 ? { client: this.client, generation: this.generation, seq: this.acked } : null;
  }

  /** The generation retired (`superseded` on a report): its captured report goes. */
  drop(): void {
    this.captured = null;
  }
}
