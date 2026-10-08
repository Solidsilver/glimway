/**
 * Glue between WorldScene and the pure nudge rules in lib/nudges.ts.
 *
 * The guest nudge is gone: every player signs in, so there is nobody to
 * nudge. WorldScene still calls this once a frame (TODO(C2): remove the
 * call there, with the guest branches in the scene layer).
 */
import type { Session } from './session'

/** An area's way out (as WorldScene's world reports it). */
export interface ExitRect {
  tx: number
  ty: number
  tw: number
  th: number
}

export function maybeNudgePip(
  _session: Session,
  _world: { areaId: string; exits: ExitRect[] },
  _player: { x: number; y: number }
): void {
  /* no nudges any more */
}
