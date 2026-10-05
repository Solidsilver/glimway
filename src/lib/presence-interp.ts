/**
 * Smooth movement for other players from ~8 Hz position samples.
 *
 * Each peer is drawn a little in the past (`RENDER_DELAY_MS`), between the
 * two samples around that moment, so motion looks continuous although
 * samples arrive in bursts. No extrapolation: past the newest sample the peer
 * holds still. A jump longer than `SNAP_PX` (an area entry, a respawn) snaps
 * instead of sliding across the map. Positions are presentation only.
 *
 * Pure: time comes from the caller.
 */
import type { PresencePosition } from './presence.ts';

export const RENDER_DELAY_MS = 160;
export const SNAP_PX = 96;
/** A gap this long between samples means the peer stood still meanwhile. */
const STILL_GAP_MS = 300;
const MAX_SAMPLES = 16;

interface Sample extends PresencePosition {
  t: number;
}

export interface DrawnPosition {
  x: number;
  y: number;
  facing: { x: number; y: number };
  /** Walking: the peer said it is moving, or it is still gliding between samples. */
  moving: boolean;
}

export class PeerTrack {
  private samples: Sample[] = [];

  /** Record a sample received at `now` (ms). */
  push(pos: PresencePosition, now: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last && now - last.t > STILL_GAP_MS) {
      // It stood at `last` until just before this sample: start the glide from
      // there, not from a moment long ago (which would look like a jump).
      this.samples.push({ ...last, moving: false, t: now - Math.min(125, now - last.t) });
    }
    this.samples.push({ ...pos, t: now });
    if (this.samples.length > MAX_SAMPLES) this.samples.splice(0, this.samples.length - MAX_SAMPLES);
  }

  get empty(): boolean {
    return this.samples.length === 0;
  }

  /** Where to draw the peer at `now` (ms); null before any sample. */
  at(now: number): DrawnPosition | null {
    const s = this.samples;
    if (s.length === 0) return null;
    const target = now - RENDER_DELAY_MS;
    if (s.length === 1 || target <= s[0].t) return draw(s[0], false);
    const last = s[s.length - 1];
    if (target >= last.t) {
      // Drop history we no longer need, keeping the newest.
      if (s.length > 2) s.splice(0, s.length - 2);
      return draw(last, false);
    }
    let i = 1;
    while (i < s.length && s[i].t <= target) i++;
    const a = s[i - 1];
    const b = s[i];
    if (i > 2) s.splice(0, i - 2);
    if (Math.hypot(b.x - a.x, b.y - a.y) > SNAP_PX) return draw(a, false);
    const k = (target - a.t) / (b.t - a.t);
    const gliding = a.x !== b.x || a.y !== b.y;
    return {
      x: a.x + (b.x - a.x) * k,
      y: a.y + (b.y - a.y) * k,
      facing: k < 0.5 ? a.facing : b.facing,
      moving: a.moving || b.moving || gliding,
    };
  }
}

function draw(s: Sample, moving: boolean): DrawnPosition {
  return { x: s.x, y: s.y, facing: s.facing, moving: moving || false };
}
