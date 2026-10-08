/**
 * The big moment: the HUD steps aside, the camera eases to the lantern,
 * and the flame catches with a bloom of light and a chime. The quest event
 * is applied at the peak so the UI's quest banner lands right after.
 */
import Phaser from 'phaser'
import type { QuestEvent } from '../../lib/state'
import { refreshLanternVisuals, type LightProp } from '../area/lanterns'
import { bus, EV } from '../events'
import { sfx } from '../sfx'
import type { Session } from '../session'
import { zoomFor } from '../scenes/world-camera'
import type { Effects } from './fx'

export interface LanternBeat {
  /** Lighting the shrine lantern, or the village's on the way home. */
  event: QuestEvent
  session: Session
  lightProps: LightProp[]
  fx: Effects
  hero: Phaser.GameObjects.Components.Transform
  reducedMotion: boolean
  /** The scene holds still while the beat plays. */
  setCinematic: (on: boolean) => void
}

export function playLanternBeat(scene: Phaser.Scene, b: LanternBeat): void {
  const target = b.lightProps.find((lp) => lp.id === (b.event === 'light-lantern' ? 'shrine' : 'village'))
  const finish = () => {
    b.session.applyQuestEvent(b.event)
    refreshLanternVisuals(scene, b.lightProps, b.session.questStage, b.session.state)
  }
  if (!target) {
    finish()
    return
  }
  b.setCinematic(true)
  bus.emit(EV.cinematic, { active: true })
  const cam = scene.cameras.main
  const baseZoom = cam.zoom
  cam.stopFollow()
  const panMs = b.reducedMotion ? 0 : 900
  cam.pan(target.gx, target.gy + 10, panMs, 'Sine.easeInOut')
  if (!b.reducedMotion) cam.zoomTo(baseZoom * 1.3, panMs, 'Sine.easeInOut')
  scene.time.delayedCall(panMs + 150, () => {
    sfx('lantern')
    if (!b.reducedMotion) cam.flash(500, 255, 220, 150)
    const bloom = scene.add.image(target.gx, target.gy, 'glow').setBlendMode(Phaser.BlendModes.ADD).setDepth(4002).setScale(0.2)
    scene.tweens.add({ targets: bloom, scale: 4, alpha: 0, duration: 1400, ease: 'Quad.easeOut', onComplete: () => bloom.destroy() })
    b.fx.sparkBurst(target.gx, target.gy, 16)
    finish()
  })
  scene.time.delayedCall(panMs + 2300, () => {
    cam.pan(b.hero.x, b.hero.y, panMs, 'Sine.easeInOut')
    // Return to the zoom for the CURRENT viewport (it may have resized).
    if (!b.reducedMotion) cam.zoomTo(zoomFor(scene.scale.width, scene.scale.height), panMs, 'Sine.easeInOut')
    scene.time.delayedCall(panMs + 50, () => {
      cam.startFollow(b.hero, true, 0.12, 0.12)
      b.setCinematic(false)
      bus.emit(EV.cinematic, { active: false })
    })
  })
}
