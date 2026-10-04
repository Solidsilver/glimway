/**
 * Gentle in-world nudges: pure decision logic (see game/nudges.ts for the glue).
 */
import type { GameState } from './state.ts'
import type { VitalsSource } from './habitica/types.ts'

/** Story flag: Pip has already pointed this save at the Habitica connection. */
export const PIP_GATE_FLAG = 'nudge:pip-gate'

/** Tiles from the village gate within which the nudge fires. */
const GATE_REACH_TILES = 3

export interface ExitRect {
  tx: number
  ty: number
  tw: number
  th: number
}

/** True once, for a guest standing near the Hearthwick gate. */
export function pipGateNudgeDue(
  state: Pick<GameState, 'flags'>,
  opts: { vitalsSource: VitalsSource; connected: boolean; areaId: string; tx: number; ty: number; exits: ExitRect[] }
): boolean {
  if (opts.areaId !== 'village' || opts.connected || opts.vitalsSource === 'imported') return false
  if (state.flags.includes(PIP_GATE_FLAG)) return false
  return opts.exits.some(
    (e) =>
      opts.tx >= e.tx - GATE_REACH_TILES &&
      opts.tx < e.tx + e.tw + GATE_REACH_TILES &&
      opts.ty >= e.ty - GATE_REACH_TILES &&
      opts.ty < e.ty + e.th + GATE_REACH_TILES
  )
}

