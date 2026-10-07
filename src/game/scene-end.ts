/**
 * A scene ends by shutting down (a restart, a change of scene) or by being
 * destroyed (`game.destroy`, a session swap, which never emits `shutdown`).
 * Phaser keeps a scene's event emitter across restarts, so a listener left on
 * the other event would pile up with every area built.
 */

/** The part of a scene's event emitter this needs (Phaser's fits). */
export interface SceneEvents {
  once(event: string, fn: () => void): unknown
  off(event: string, fn: () => void): unknown
}

/** Run `fn` once, when the scene shuts down or is destroyed, whichever comes first. */
export function onSceneEnd(scene: { events: SceneEvents }, fn: () => void): void {
  const end = () => {
    scene.events.off('shutdown', end)
    scene.events.off('destroy', end)
    fn()
  }
  scene.events.once('shutdown', end)
  scene.events.once('destroy', end)
}
