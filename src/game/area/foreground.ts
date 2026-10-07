/**
 * Area construction — foreground. Delivered occluders (canopies over tree
 * bases, arches over gates, ferns) placed per the area-kind registry in
 * worlds.ts, code-drawn scenery marked `fade`, plus the fade update when
 * something walks beneath them.
 */
import { placeFingersnapOccluder } from '../expansion'
import { TILE } from '../textures'
import { areaKind, type WorldData } from '../worlds'
import { ensureSceneryArt } from './props'
import { addAll } from './bulk'

/** Foreground occluder: canopy/arch image, its bounds, and its ground foot. */
export interface Occluder {
  image: Phaser.GameObjects.Image
  bounds: Phaser.Geom.Rectangle
  footY: number
}

/**
 * Delivered foreground occluders: canopies over existing tree bases (their
 * collisions stay the trees'), arches over area gates, ferns as pure decor.
 * No new collision — occluders are visual only.
 */
export function buildForeground(scene: Phaser.Scene, world: WorldData): Occluder[] {
  const spots = areaKind(world.areaId).foreground(world)
  const occluders: Occluder[] = []
  // Canopies over the Commons' thousand-odd trees: added in one go (./bulk.ts).
  const images: Phaser.GameObjects.Image[] = []
  for (const s of spots) {
    const footY = s.ty * TILE + TILE
    const image = placeFingersnapOccluder(scene, s.frame, s.tx * TILE + 8, footY, s.w, false)
    images.push(image)
    occluders.push({ image, bounds: image.getBounds(), footY })
  }
  addAll(scene, images)
  // Code-drawn canopies over a walkable tile (the Tangle's path-side trees).
  for (const s of world.scenery ?? []) {
    if (!s.fade || !ensureSceneryArt(scene, s.key)) continue
    const image = scene.add.image(s.x, s.y, s.key, s.frame).setOrigin(s.originX ?? 0.5, 1).setFlipX(s.flipX ?? false).setDepth(s.y)
    if (s.tint !== undefined) image.setTint(s.tint)
    occluders.push({ image, bounds: image.getBounds(), footY: s.y })
  }
  return occluders
}

/** Canopies and arches fade so nothing (hero or enemy) hides beneath them. */
export function updateOccluders(occluders: Occluder[], dt: number, things: readonly { x: number; y: number }[]): void {
  if (occluders.length === 0) return
  for (const o of occluders) {
    const covered = things.some((t) => t.y <= o.footY + 2 && o.bounds.contains(t.x, t.y - 6))
    const target = covered ? 0.38 : 1
    o.image.alpha += (target - o.image.alpha) * Math.min(1, dt * 10)
  }
}
