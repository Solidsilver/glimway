/**
 * The off hand, drawn: whatever the player carries there (a lantern, the
 * turncap jar, a whistle) rides at the hero's side, and is tucked away while
 * they sit or fight (src/lib/items.ts offHandTuck), then comes back. On the
 * Habitica figure it's gripped in the off hand (./avatar.ts offHand), in its
 * held art facing with the hero when it has some (../people.ts: the
 * carter's lantern), leaning out from the hand; otherwise its item icon at
 * the hero's side. Pure visual; what's held comes from the item model
 * (./items).
 */
import type Phaser from 'phaser'
import { offHandTuck } from '../../lib/items'
import { ITEM_ART_FALLBACK, itemIcon } from '../items-pass'
import { itemsFor } from '../items'
import { bus, EV } from '../events'
import type { Session } from '../session'
import type { Hero } from './hero'
import type { AvatarVisual } from './avatar'
import { PEOPLE_KEY, heldFrame, heldOrigin, peopleDensity } from '../people'

export class OffHandVisual {
  private image: Phaser.GameObjects.Image | null = null
  private held: string | null = null
  private until = 0

  constructor(private scene: Phaser.Scene, private session: Session, private hero: () => Hero, private avatar: () => AvatarVisual | null = () => null) {
    const refresh = () => this.refresh()
    bus.on(EV.itemsChanged, refresh)
    scene.events.once('shutdown', () => {
      bus.off(EV.itemsChanged, refresh)
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
    this.iconKey = key
    this.iconLook()
  }

  /** The icon's key (for going back to it from the held art). */
  private iconKey = ''

  private iconLook(): void {
    const img = this.image!
    if (img.texture.key !== this.iconKey) img.setTexture(this.iconKey)
    img.setOrigin(0.5, 1)
    img.setScale(img.frame.realHeight > 14 ? 14 / img.frame.realHeight : 1)
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
    const hand = this.avatar()?.offHand()
    const frame = hand && this.held ? heldFrame(this.scene, this.held, hand.facing) : null
    const k = peopleDensity(this.scene)
    if (hand && frame && k) {
      // Gripped in the off hand; the held art leans art-left, so it's turned
      // to lean out when the hand is on the right.
      if (img.texture.key !== PEOPLE_KEY || img.frame.name !== frame) {
        img.setTexture(PEOPLE_KEY, frame).setScale(1 / k)
        const [ox, oy] = heldOrigin(this.scene, frame)
        img.setOrigin(ox, oy)
      }
      img.setPosition(hand.x, hand.y)
      img.setFlipX(hand.right)
      img.setDepth(hand.depth + (hand.facing === 'up' ? -1 : 1))
      return
    }
    if (img.texture.key === PEOPLE_KEY) this.iconLook()
    // At the hand away from the facing side, a little below the shoulder.
    const side = h.facing.x < -0.1 ? 1 : -1
    img.setPosition(h.sprite.x + side * 7, h.sprite.y - 2)
    img.setFlipX(side > 0)
    img.setDepth(h.sprite.depth + (h.facing.y < -0.1 ? -1 : 1))
  }
}
