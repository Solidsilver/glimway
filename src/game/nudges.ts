/** Glue between WorldScene and the pure nudge rules in lib/nudges.ts. */
import { pipGateNudge } from '../content/connect-guide'
import { PIP_GATE_FLAG, pipGateNudgeDue, type ExitRect } from '../lib/nudges'
import { isConnected } from '../ui/habitica-local'
import { bus, EV } from './events'
import type { Session } from './session'
import { TILE } from './textures'

/** The one call WorldScene makes each frame: fires Pip's line at most once per save. */
export function maybeNudgePip(
  session: Session,
  world: { areaId: string; exits: ExitRect[] },
  player: { x: number; y: number }
): void {
  const tx = Math.floor(player.x / TILE)
  const ty = Math.floor(player.y / TILE)
  if (!pipGateNudgeDue(session.state, { vitalsSource: session.vitalsSource, connected: isConnected(), areaId: world.areaId, tx, ty, exits: world.exits })) return
  session.addFlag(PIP_GATE_FLAG)
  bus.emit(EV.toast, { text: pipGateNudge, icon: 'person' })
}
