/**
 * A scene ends by shutting down (a restart, a change of scene) or by being
 * destroyed (`game.destroy`, a session swap, which never emits `shutdown`).
 * Phaser keeps a scene's event emitter across restarts, so a listener left on
 * the other event would pile up with every area built.
 *
 * On destroy, Phaser's own systems (cameras, input, the display list, the
 * clock, tweens) have already torn down when `fn` runs: their game objects
 * are gone and calls into them can throw. `fn` is told which end it is, so
 * it can let go of what lives outside the scene (the bus, module state, the
 * HUD) and skip tidying what Phaser already dropped.
 */

/** The part of a scene's event emitter this needs (Phaser's fits). */
export interface SceneEvents {
  once(event: string, fn: () => void): unknown
  off(event: string, fn: () => void): unknown
}

/** Run `fn` once, when the scene shuts down or is destroyed, whichever comes first. */
export function onSceneEnd(scene: { events: SceneEvents }, fn: (destroyed: boolean) => void): void {
  const end = (destroyed: boolean) => {
    scene.events.off('shutdown', shut)
    scene.events.off('destroy', gone)
    if (!destroyed) return fn(false)
    // A throw here would stop Phaser's teardown halfway (the rest of the
    // scene's destroy listeners, the canvas, the loop): the old game would
    // run on beside the next one. Finish the teardown; still report it.
    try {
      fn(true)
    } catch (err) {
      queueMicrotask(() => {
        throw err
      })
    }
  }
  const shut = () => end(false)
  const gone = () => end(true)
  scene.events.once('shutdown', shut)
  scene.events.once('destroy', gone)
}
