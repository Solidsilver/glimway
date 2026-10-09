/**
 * Pet a pet (crafts.md 2.1): stand by any pet, yours or a friend's or a yard
 * pet, and the action button says Pet. A small heart rises and the pet
 * hops (with reduced motion: no hop, and the heart fades in place).
 * Nothing is earned, nothing is sent: only you see it.
 *
 * The pets move, so their points read live positions; the list is rebuilt
 * only when the set of pets here changes.
 */
import type Phaser from 'phaser'
import { crArt } from '../crafts-art'
import type { Interactable, Interactables } from './interactables'

export interface PetPoint {
  id: string
  x: number
  y: number
  hop: () => void
}

/** Pet reach: a little closer than a person's (pets are small). */
const PET_REACH = 22
/** Below Talk and everything else at the same spot. */
const PET_RANK = -1

export class Petting {
  private ids = ''
  private points = new Map<string, PetPoint>()
  private next = 0

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly interactables: Interactables,
    private readonly reducedMotion: boolean,
    private readonly sources: () => PetPoint[]
  ) {
    scene.events.once('shutdown', () => interactables.register(this, []))
  }

  update(): void {
    const now = this.scene.time.now
    const all = this.sources()
    this.points = new Map(all.map((p) => [p.id, p]))
    if (now < this.next) return
    this.next = now + 250
    const ids = all.map((p) => p.id).join('|')
    if (ids === this.ids) return
    this.ids = ids
    const self = this
    this.interactables.register(
      this,
      all.map(
        (p): Interactable => ({
          id: `touch:pet:${p.id}`,
          get x() {
            return self.points.get(p.id)?.x ?? p.x
          },
          get y() {
            return (self.points.get(p.id)?.y ?? p.y) + 2
          },
          label: 'Pet',
          verb: 'Pet',
          reach: PET_REACH,
          rank: PET_RANK,
          available: () => self.points.has(p.id),
          activate: () => {
            const live = self.points.get(p.id)
            if (!live) return
            live.hop()
            heart(self.scene, live, self.reducedMotion)
          }
        })
      )
    )
  }
}

/** A small warm heart rising over the pet (the crafts pass's, or one drawn in code). */
function heart(scene: Phaser.Scene, at: { x: number; y: number }, reducedMotion: boolean): void {
  const y = at.y - 12
  let obj: Phaser.GameObjects.Sprite | Phaser.GameObjects.Graphics
  if (scene.textures.exists(crArt('pet-heart-0'))) {
    const s = scene.add.sprite(at.x, y, crArt('pet-heart-0')).setOrigin(0.5, 1)
    if (!reducedMotion && scene.anims.exists(crArt('pet-heart'))) s.play(crArt('pet-heart'))
    obj = s
  } else {
    const g = scene.add.graphics({ x: at.x, y })
    g.fillStyle(0xc94b59, 1)
    g.fillRect(-3, -6, 2, 2).fillRect(1, -6, 2, 2).fillRect(-4, -5, 8, 2).fillRect(-3, -3, 6, 1).fillRect(-2, -2, 4, 1).fillRect(-1, -1, 2, 1)
    obj = g
  }
  obj.setDepth(9000)
  // Reduced motion: it fades where it is, never rises.
  scene.tweens.add({ targets: obj, ...(reducedMotion ? {} : { y: y - 8 }), alpha: { from: 1, to: 0 }, delay: 300, duration: 700, ease: 'Sine.easeOut', onComplete: () => obj.destroy() })
}
