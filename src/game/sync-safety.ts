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

let current: { answer: () => SyncSafety } | null = null

/**
 * The live world registers its answer when an area is built, and calls the
 * returned disposer when its scene ends. A disposer only clears its own
 * registration, never a newer world's.
 */
export function setSyncSafety(fn: () => SyncSafety): () => void {
  const owner = { answer: fn }
  current = owner
  return () => {
    if (current === owner) current = null
  }
}

/** The live world's state for the sync gate (null: no world is live). */
export function syncSafety(): SyncSafety | null {
  return current ? current.answer() : null
}
