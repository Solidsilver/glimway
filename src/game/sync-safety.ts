/**
 * Whether the world is in a state where a Habitica sync may run. The UI's
 * sync gate (ConnectGuide) asks; the live WorldScene answers. This is real
 * gameplay, not a playtest hook: it ships in every build.
 */
import type { AreaId } from '../lib/state'

export interface SyncSafety {
  areaId: AreaId
  transitioning: boolean
  dialogueOpen: boolean
  enemiesNear: boolean
}

let current: (() => SyncSafety) | null = null

/** WorldScene registers its answer on every build of an area. */
export function setSyncSafety(fn: () => SyncSafety): void {
  current = fn
}

/** The world's state for the sync gate (null until a world has been built). */
export function syncSafety(): SyncSafety | null {
  return current ? current() : null
}
