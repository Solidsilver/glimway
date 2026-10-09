/**
 * Yard pets on a homestead's land (crafts.md 2.1, 2.3): up to three per
 * member, wandering slowly inside the lamplight and napping beside a tree or
 * the cottage. Where each one is comes from the homestead's seed and the
 * server's clock (src/lib/yard-pets.ts), so a visitor sees the same pets in
 * the same places.
 *
 * Coming over is this screen's own: when the hero walks within three tiles,
 * the pet trots to them and sits facing them; when they leave it walks back
 * to where its wander has got to. Calm by default: a nap is a squash, a slow
 * breath and a small "z" made in code; none of it moves with reduced motion.
 */
import type Phaser from 'phaser'
import { loadCompanion } from '../avatar-render'
import { serverNow } from '../clock'
import { servedLand } from '../../lib/homestead-land'
import { yardPetAt, yardTiles, type YardTiles } from '../../lib/yard-pets'
import { TILE } from '../../lib/tile'
import type { HomeView } from '../../lib/api/types'
import { COMPANION_SCALE } from './pet-follower'

/** A hero this near (px) brings a yard pet over. */
export const COME_OVER_PX = 3 * TILE
/** Trotting over, and back, px/s. */
const TROT_PX_S = 55
/** Sitting this far from the hero, px. */
const SIT_BESIDE = 12

interface YardPetView {
  key: string
  owner: string
  slot: number
  image: Phaser.GameObjects.Image | null
  z: Phaser.GameObjects.Text | null
  /** Drawn here (may lag the wander while coming over or going back). */
  x: number
  y: number
  /** Coming over to the hero, or sat with them. */
  over: boolean
  faceRight: boolean
  hopUntil: number
}

export class HomesteadYard {
  private pets: YardPetView[] = []
  private tiles: YardTiles | null = null
  private shown = ''
  private gone = false

  constructor(
    private readonly scene: Phaser.Scene,
    private readonly reducedMotion: boolean,
    private readonly hero: () => { x: number; y: number }
  ) {}

  /** The homestead changed (or was read): rebuild when its yard or its ground changed. */
  sync(home: HomeView | null): void {
    const land = home ? servedLand(home.gate) : null
    const sig = home && land ? JSON.stringify([home.landSeed, home.yardPets, home.cleared, home.items.filter((i) => i.scene === 'outdoor').map((i) => [i.id, i.x, i.y, i.rotation, i.stalls])]) : ''
    if (sig === this.shown) return
    this.shown = sig
    this.clear()
    if (!home || !land) return
    this.tiles = yardTiles(home, land)
    const now = serverNow()
    for (const y of home.yardPets) {
      const at = yardPetAt(this.tiles, y.pet, y.slot, now)
      if (!at) continue
      const v: YardPetView = { key: y.pet, owner: y.ownerId, slot: y.slot, image: null, z: null, x: at.x, y: at.y, over: false, faceRight: at.facing === 'right', hopUntil: 0 }
      this.pets.push(v)
      void this.load(v)
    }
  }

  private async load(v: YardPetView): Promise<void> {
    const keys = await loadCompanion(this.scene, v.key, 'pet')
    if (this.gone || !keys || !this.pets.includes(v)) return
    v.image = this.scene.add.image(v.x, v.y, keys[0]).setOrigin(0.5, 1).setScale(COMPANION_SCALE)
  }

  /** Per frame; `dt` in seconds (the scene's). */
  update(dt: number): void {
    if (!this.tiles) return
    const now = serverNow()
    const hero = this.hero()
    const time = this.scene.time.now
    for (const v of this.pets) {
      const at = yardPetAt(this.tiles, v.key, v.slot, now)
      if (!at) continue
      const near = Math.hypot(hero.x - v.x, hero.y - v.y) <= COME_OVER_PX
      if (near) v.over = true
      else if (v.over && Math.hypot(hero.x - v.x, hero.y - v.y) > COME_OVER_PX + TILE) v.over = false
      let pose = at.pose
      let tx = at.x
      let ty = at.y
      if (v.over) {
        tx = hero.x + (hero.x >= v.x ? -SIT_BESIDE : SIT_BESIDE)
        ty = hero.y + 1
        pose = 'stand'
      }
      const dx = tx - v.x
      const dy = ty - v.y
      const d = Math.hypot(dx, dy)
      // Off its wander (coming over or going back): it trots; on it, it follows the wander exactly.
      if (v.over || d > 1.5) {
        const step = Math.min(d, TROT_PX_S * dt)
        if (d > 0.01) {
          v.x += (dx / d) * step
          v.y += (dy / d) * step
        }
        if (Math.abs(dx) > 0.5) v.faceRight = dx > 0
        if (d > 1) pose = 'walk'
        else if (v.over) v.faceRight = hero.x > v.x
      } else {
        v.x = tx
        v.y = ty
        v.faceRight = at.facing === 'right'
      }
      this.draw(v, pose, time)
    }
  }

  private draw(v: YardPetView, pose: 'walk' | 'stand' | 'nap', time: number): void {
    const img = v.image
    if (!img?.active) return
    const sat = v.over && pose !== 'walk'
    const nap = pose === 'nap'
    // A nap breathes slowly (a 1.5 % swell over 4 s); nothing else moves when still.
    const breath = nap && !this.reducedMotion ? 1 + 0.015 * Math.sin((time / 4000) * Math.PI * 2) : 1
    const squashY = nap ? 0.78 * breath : sat ? 0.88 : 1
    const widenX = nap ? 1.12 : sat ? 1.06 : 1
    let lift = 0
    if (time < v.hopUntil && !this.reducedMotion) lift = -Math.round(3 * Math.sin(((v.hopUntil - time) / 320) * Math.PI))
    img.setPosition(Math.round(v.x), Math.round(v.y + lift)).setDepth(v.y)
    img.setScale(COMPANION_SCALE * widenX * (v.faceRight ? -1 : 1), COMPANION_SCALE * squashY)
    if (nap && !v.z) {
      v.z = this.scene.add
        .text(0, 0, 'z', { fontFamily: '"Pixelify Sans", monospace', fontSize: '6px', color: '#e8e2ff', stroke: '#2b1d1a', strokeThickness: 2, resolution: 10 })
        .setOrigin(0.5, 1)
        .setAlpha(0.85)
    } else if (!nap && v.z) {
      v.z.destroy()
      v.z = null
    }
    v.z?.setPosition(Math.round(v.x + (v.faceRight ? -5 : 5)), Math.round(v.y - 9)).setDepth(v.y + 0.5)
  }

  /** The yard pets drawn here, for Pet (crafts.md 2.1). */
  petPoints(): { id: string; x: number; y: number; hop: () => void }[] {
    return this.pets
      .filter((v) => v.image)
      .map((v) => ({ id: `yard:${v.owner}:${v.slot}`, x: v.x, y: v.y, hop: () => (v.hopUntil = this.scene.time.now + 320) }))
  }

  /** Read-only, for playtests. */
  debug(): { key: string; owner: string; x: number; y: number; over: boolean; drawn: boolean }[] {
    return this.pets.map((v) => ({ key: v.key, owner: v.owner, x: Math.round(v.x), y: Math.round(v.y), over: v.over, drawn: !!v.image }))
  }

  private clear(): void {
    for (const v of this.pets) {
      v.image?.destroy()
      v.z?.destroy()
    }
    this.pets = []
    this.tiles = null
  }

  destroy(): void {
    this.gone = true
    this.clear()
  }
}
