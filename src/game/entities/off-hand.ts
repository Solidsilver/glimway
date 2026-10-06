/**
 * The off hand, drawn: whatever the player carries there (a lantern, the
 * turncap jar, a whistle) rides at the hero's side, and is tucked away while
 * they sit or fight (src/lib/items.ts offHandTuck), then comes back. Pure
 * visual; what's held comes from the item model (./items).
 */
import type Phaser from 'phaser'
import { offHandTuck } from '../../lib/items'
import { ITEM_ART_FALLBACK, itemIcon } from '../items-pass'
import { ITEMS_EV, itemsFor } from '../items'
import { bus } from '../events'
import type { Session } from '../session'
import type { Hero } from './hero'

export class OffHandVisual {
  private image: Phaser.GameObjects.Image | null = null
  private held: string | null = null
  private until = 0

  constructor(private scene: Phaser.Scene, private session: Session, private hero: () => Hero) {
    const refresh = () => this.refresh()
    bus.on(ITEMS_EV.changed, refresh)
    scene.events.once('shutdown', () => {
      bus.off(ITEMS_EV.changed, refresh)
      this.image?.destroy()
      this.image = null
    })
    this.refresh()
  }

  /** The definition shown in the off hand right now (null: empty, closed or tucked). */
  get showing(): string | null {
    return this.image?.visible ? this.held : null
  }

  private refresh(): void {
    const def = this.session.link ? itemsFor(this.session).offHandItem() : null
    if (def === this.held) return
    this.held = def
    this.image?.destroy()
    this.image = null
    if (!def) return
    let key = itemIcon(def)
    if (!this.scene.textures.exists(key)) key = ITEM_ART_FALLBACK
    if (!this.scene.textures.exists(key)) return
    this.image = this.scene.add.image(0, 0, key).setOrigin(0.5, 1)
    if (this.image.height > 14) this.image.setScale(14 / this.image.height)
  }

  update(time: number): void {
    const img = this.image
    if (!img) return
    const h = this.hero()
    const fighting = h.attackCooldown > 0 || h.castCooldown > 0 || h.dashTime > 0 || h.iframes > 0
    const t = offHandTuck({ seated: h.isSeated, fighting, working: h.isGathering }, time, this.until)
    this.until = t.until
    img.setVisible(!t.tucked)
    if (t.tucked) return
    // At the hand away from the facing side, a little below the shoulder.
    const side = h.facing.x < -0.1 ? 1 : -1
    img.setPosition(h.sprite.x + side * 7, h.sprite.y - 2)
    img.setFlipX(side > 0)
    img.setDepth(h.sprite.depth + (h.facing.y < -0.1 ? -1 : 1))
  }
}
