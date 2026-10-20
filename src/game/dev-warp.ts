/**
 * Dev builds: the world lab's "go here" (src/ui/dev/world-lab). The world
 * scene offers its warp while it runs (world-dev-hooks.ts); the lab asks
 * for it. The warp is the scene's own move to a Wilds tile: it changes
 * where the hero stands and saves that like any step, nothing else (no
 * home, no item).
 */

type Warp = (tx: number, ty: number) => void

let current: Warp | null = null

/** The world scene's warp, until that scene shuts down. */
export function offerDevWarp(fn: Warp, scene: { events: { once(event: string, fn: () => void): unknown } }): void {
  current = fn
  const drop = () => {
    if (current === fn) current = null
  }
  scene.events.once('shutdown', drop)
  scene.events.once('destroy', drop)
}

/** A world to warp in is running. */
export function canDevWarp(): boolean {
  return current !== null
}

/** Move the hero to a Wilds tile; false when no world is running. */
export function devWarpTo(tx: number, ty: number): boolean {
  if (!current) return false
  current(tx, ty)
  return true
}
