import Phaser from 'phaser'
import { BootScene } from './scenes/BootScene'
import { WorldScene } from './scenes/WorldScene'
import type { Session } from './session'
import { DEMO_CHARACTER } from '../content/world'
import { canvasRatio, screenCanvasRatio, setCanvasRatio } from './viewport'

/**
 * The game draws at the screen's device pixel ratio (./viewport.ts
 * canvasRatio): the canvas holds the parent's CSS size times the ratio in
 * pixels and is shown at the parent's CSS size, so the browser never
 * upscales it (App.svelte sizes the canvas element to the stage). Phaser's
 * NONE scale mode keeps the canvas at the size given and reads pointers
 * through the canvas's on-page box, so input lands in canvas px;
 * `fitCanvas` follows the parent and the ratio.
 */
export function startGame(parent: HTMLElement, session: Session): Phaser.Game {
  setCanvasRatio(screenCanvasRatio())
  const [width, height] = canvasSize(parent)
  const game = new Phaser.Game({
    type: Phaser.AUTO,
    parent,
    backgroundColor: '#241f31',
    pixelArt: true,
    roundPixels: true,
    scale: { mode: Phaser.Scale.NONE, width, height },
    physics: { default: 'arcade', arcade: { debug: false } },
    scene: [BootScene, WorldScene]
  })
  game.registry.set('session', session)
  game.registry.set('demoStats', DEMO_CHARACTER.stats)
  game.events.once(Phaser.Core.Events.READY, () => fitCanvas(game, parent))
  return game
}

export function stopGame(game: Phaser.Game | null): void {
  game?.destroy(true)
}

/**
 * The canvas size in px for the parent's CSS size at the current ratio. A
 * parent with no layout size yet (hidden, not laid out) gets 1×1, the
 * smallest canvas WebGL takes, until the resize observer sees a real size.
 */
function canvasSize(parent: HTMLElement, r = screenCanvasRatio()): [number, number] {
  return [Math.max(1, Math.round(parent.clientWidth * r)), Math.max(1, Math.round(parent.clientHeight * r))]
}

/**
 * Keep the canvas at the parent's size times the ratio, shown at the
 * parent's size: on every resize of the parent (a phone turned, a stage
 * that first gets its size) and every change of the device pixel ratio (a
 * window dragged to another screen, browser zoom). The scale manager's
 * resize event re-zooms and re-frames the camera; the textures keep the
 * density they were built at (./density.ts artDensity). The Canvas renderer
 * stays at a ratio of 1 (it draws on the CPU).
 */
function fitCanvas(game: Phaser.Game, parent: HTMLElement): void {
  const fit = () => {
    if (!game.canvas) return
    const r = game.renderer.type === Phaser.WEBGL ? screenCanvasRatio() : 1
    const changed = r !== canvasRatio()
    setCanvasRatio(r)
    const [w, h] = canvasSize(parent, r)
    // Either one re-frames the camera (the scale manager's resize event).
    if (game.scale.width !== w || game.scale.height !== h) game.scale.resize(w, h)
    else if (changed) game.scale.refresh()
  }
  // The ratio, once a frame (one compare): a resolution media query's
  // change event doesn't come everywhere a ratio can change.
  let dpr = window.devicePixelRatio
  const watchRatio = () => {
    if (window.devicePixelRatio === dpr) return
    dpr = window.devicePixelRatio
    fit()
  }
  const observer = new ResizeObserver(fit)
  observer.observe(parent)
  game.events.on(Phaser.Core.Events.PRE_STEP, watchRatio)
  fit()
  game.events.once(Phaser.Core.Events.DESTROY, () => {
    observer.disconnect()
    game.events.off(Phaser.Core.Events.PRE_STEP, watchRatio)
  })
}
