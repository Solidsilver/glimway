/**
 * Things lying in the world to pick up (docs/hands-on-design.md section 2,
 * "Picking things up"): a coil of rope by the well, a glove on the lane, a
 * dropped bucket in the bracken. The woods give things back. Placed like
 * papers (content/items.json `pickups`), drawn with the item's own icon and
 * a slow glint, and granted by the server once per player who stands by it.
 *
 * It registers `pickup:*` points (./interactables). Worlds only:
 * a guest has nowhere to keep a tool, so nothing lies here for them.
 */
import type Phaser from 'phaser'
import { pickupsIn, type ItemPickup } from '../../lib/items'
import { bus, EV } from '../events'
import { ITEM_ART_FALLBACK, itemIcon } from '../items-pass'
import { itemsFor } from '../items'
import { tileBottom, tileMid } from '../../lib/tile'
import type { Session } from '../session'
import type { WorldData } from '../worlds'
import type { Effects } from './fx'
import type { Interactable, Interactables } from './interactables'

export interface ItemPickupDeps {
  world: WorldData
  session: Session
  fx: Effects
  reducedMotion: boolean
  interactables: Interactables
}

const PREFIX = 'pickup:'

interface Lying {
  pickup: ItemPickup
  image: Phaser.GameObjects.Image
  twinkle: Phaser.GameObjects.Image
  timer: Phaser.Time.TimerEvent | null
}

export class ItemPickups {
  private lying = new Map<string, Lying>()
  private busy = false

  constructor(private scene: Phaser.Scene, private deps: ItemPickupDeps) {
    const items = itemsFor(deps.session)
    const sync = () => {
      if (scene.sys?.isActive()) this.sync()
    }
    bus.on(EV.itemsChanged, sync)
    scene.events.once('shutdown', () => {
      bus.off(EV.itemsChanged, sync)
      for (const l of this.lying.values()) l.timer?.remove()
      this.lying.clear()
    })
    // What's been taken comes from the server; until then nothing lies here.
    if (deps.session.link && !items.view) void items.load()
    else this.sync()
  }

  /** Take what lies here (the server keeps who took what). */
  private take(key: string): void {
    const l = this.lying.get(key)
    if (!l || this.busy) return
    this.busy = true
    void itemsFor(this.deps.session)
      .pickup(key)
      .then((r) => {
        this.busy = false
        if (r.ok) {
          this.deps.fx.sparkBurst(l.image.x, l.image.y - 4, 8)
          this.remove(key)
          this.publish()
        } else if (r.code === 'already-picked-up') {
          this.remove(key)
          this.publish()
        } else {
          bus.emit(EV.toast, { text: r.text, kind: 'error' })
        }
      })
  }

  /** Pickups still lying here (playtest hook). */
  ids(): string[] {
    return [...this.lying.keys()]
  }

  private sync(): void {
    const { session, world } = this.deps
    const items = itemsFor(session)
    const want = session.link && items.view ? pickupsIn(world.areaId, items.pickedUp()) : []
    const ids = new Set(want.map((p) => p.id))
    for (const id of [...this.lying.keys()]) if (!ids.has(id)) this.remove(id)
    for (const p of want) if (!this.lying.has(p.id)) this.place(p)
    this.publish()
  }

  private publish(): void {
    // Pickups sparkle instead of carrying a marker.
    const points: Interactable[] = [...this.lying.values()].map((l) => ({
      id: `${PREFIX}${l.pickup.id}`,
      x: tileMid(l.pickup.tx),
      y: tileBottom(l.pickup.ty) - 2,
      label: l.pickup.label,
      verb: 'Take',
      activate: () => this.take(l.pickup.id)
    }))
    this.deps.interactables.register(this, points)
  }

  private place(p: ItemPickup): void {
    const x = tileMid(p.tx)
    const y = tileBottom(p.ty) - 3
    let key = itemIcon(p.item)
    if (!this.scene.textures.exists(key)) key = this.scene.textures.exists(ITEM_ART_FALLBACK) ? ITEM_ART_FALLBACK : 'spark'
    const image = this.scene.add.image(x, y, key).setOrigin(0.5, 1).setDepth(y - 6)
    if (image.height > 16) image.setScale(16 / image.height)
    const twinkle = this.scene.add.image(x + 3, y - 8, 'spark').setDepth(y + 1).setBlendMode(1 /* ADD */)
    let timer: Phaser.Time.TimerEvent | null = null
    if (this.deps.reducedMotion) {
      twinkle.setAlpha(0.7)
    } else {
      twinkle.setAlpha(0).setScale(0.4)
      const glint = () => {
        if (!twinkle.active) return
        twinkle.setPosition(x + Math.round((Math.random() - 0.5) * 8), y - 6 - Math.round(Math.random() * 5))
        this.scene.tweens.add({ targets: twinkle, alpha: { from: 0, to: 1 }, scale: { from: 0.4, to: 1.1 }, duration: 260, yoyo: true, ease: 'Sine.easeOut' })
      }
      timer = this.scene.time.addEvent({ delay: 2600 + Math.floor(Math.random() * 900), loop: true, startAt: Math.floor(Math.random() * 1800), callback: glint })
    }
    this.lying.set(p.id, { pickup: p, image, twinkle, timer })
  }

  private remove(id: string): void {
    const l = this.lying.get(id)
    if (!l) return
    l.timer?.remove()
    if (this.deps.reducedMotion) {
      l.image.destroy()
      l.twinkle.destroy()
    } else {
      this.scene.tweens.add({ targets: [l.image, l.twinkle], y: '-=6', alpha: 0, duration: 260, ease: 'Quad.easeOut', onComplete: () => { l.image.destroy(); l.twinkle.destroy() } })
    }
    this.lying.delete(id)
  }
}
