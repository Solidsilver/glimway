/**
 * Adding and removing many images at once. Phaser's display list refuses
 * duplicates by scanning itself on every add, and finds what it removes by
 * scanning again, so adding or removing n images one by one costs n times
 * the list: the Commons' thousand-odd trees and their canopies were a tenth
 * of a second of blocked main thread on every entry, and every chunk the
 * open map attached or dropped cost about as much again.
 *
 * Images are made off the list and appended in one go, each still
 * announced to the scene as an ordinary add would be (`addChildCallback`);
 * and taken off in one pass over the list, each announced as an ordinary
 * removal (`removeChildCallback`), then destroyed. This is the one place
 * that knows the display list's insides (Phaser 3.90: `list`, its two
 * callbacks, and `GameObject.destroy` asking `displayList.exists` before
 * taking itself off), and the Blitter's (`decalBlitter`).
 */
import type Phaser from 'phaser'
import { perfWithout } from '../perf.ts'

type GameObject = Phaser.GameObjects.GameObject
type Listed = {
  list: GameObject[]
  addChildCallback?: (o: GameObject) => void
  removeChildCallback?: (o: GameObject) => void
}

/** An image made off the display list (add it with `addAll`). */
export function looseImage(scene: Phaser.Scene, x: number, y: number, key: string, frame?: string): Phaser.GameObjects.Image {
  return scene.make.image({ x, y, key, frame }, false)
}

/** Put freshly made objects on the scene's display list, in order. */
export function addAll(scene: Phaser.Scene, objects: readonly GameObject[]): void {
  const dl = scene.children as unknown as Listed
  if (typeof dl.addChildCallback !== 'function' || perfWithout('bulk')) {
    for (const o of objects) scene.add.existing(o)
    return
  }
  for (const o of objects) {
    dl.list.push(o)
    dl.addChildCallback(o)
  }
}

/**
 * Stands in for an object's display list while `destroyAll` destroys it,
 * already taken off: `destroy` asks it whether the object is still listed
 * (the real list would scan itself to say no).
 */
const OFF_LIST = { exists: () => false }

/**
 * Take objects off the scene's display list in one pass, and destroy them.
 * Anything not on the list (never added, or already gone) is destroyed all
 * the same.
 */
export function destroyAll(scene: Phaser.Scene, objects: readonly GameObject[]): void {
  if (!objects.length) return
  const dl = scene.children as unknown as Listed
  if (typeof dl.removeChildCallback !== 'function' || perfWithout('bulk')) {
    for (const o of objects) o.destroy()
    return
  }
  const going = new Set(objects)
  const list = dl.list
  let kept = 0
  for (let i = 0; i < list.length; i++) {
    const o = list[i]!
    if (going.has(o)) dl.removeChildCallback(o)
    else list[kept++] = o
  }
  list.length = kept
  for (const o of objects) {
    ;(o as unknown as { displayList: unknown }).displayList = OFF_LIST
    o.destroy()
  }
}

// ------------------------------------------------------------ decals

/**
 * A blitter for flat decals of one texture: one display-list entry however
 * many it draws, at `depth`. Its pieces (`decalBob`) land on the canvas
 * pixels an image of the same piece would: Phaser draws an image from its
 * floored position and rounds its corners only at a whole zoom
 * (`renderRoundPixels`), while a blitter rounds whenever `roundPixels` is
 * set, so it draws with the camera's whole-zoom rounding instead.
 */
export function decalBlitter(scene: Phaser.Scene, key: string, depth: number): Phaser.GameObjects.Blitter {
  const b = scene.make.blitter({ key }, false).setDepth(depth)
  type Draw = (renderer: unknown, src: unknown, camera: Phaser.Cameras.Scene2D.Camera, parent?: unknown) => void
  const r = b as unknown as { renderWebGL?: Draw; renderCanvas?: Draw }
  for (const k of ['renderWebGL', 'renderCanvas'] as const) {
    const draw = r[k]
    if (!draw) continue
    r[k] = (renderer, src, camera, parent) => {
      const round = camera.roundPixels
      camera.roundPixels = camera.renderRoundPixels
      try {
        draw.call(b, renderer, src, camera, parent)
      } finally {
        camera.roundPixels = round
      }
    }
  }
  return b
}

/**
 * One decal, placed as an image would be: standing on (x, y) with its
 * origin at (originX, 1), mirrored about that origin when flipped (a trimmed
 * frame's offsets mirror with it), tinted.
 */
export function decalBob(b: Phaser.GameObjects.Blitter, frame: string | undefined, x: number, y: number, originX: number, flipX: boolean, tint: number | undefined): void {
  const f = frame === undefined ? b.frame : b.texture.get(frame)
  const gx = Math.floor(x)
  const ox = originX * f.realWidth
  const left = flipX ? gx + f.realWidth - ox - 2 * f.x - f.width : gx - ox
  const bob = b.create(left, Math.floor(y) - f.realHeight, f)
  if (flipX) bob.setFlipX(true)
  if (tint !== undefined) bob.setTint(tint)
}

// ------------------------------------------------------------ static bodies

/**
 * Arcade keeps a static group's members, and the world its static bodies,
 * in Phaser's own Set (an array it scans on every add and every delete), so
 * a chunk's few hundred solid runs going in or out one by one cost a scan
 * of every solid in the window each.
 */
type Entries<T> = { entries: T[] }
type StaticBodyLike = { enable: boolean; world?: unknown; gameObject?: unknown }
/** A solid: a hidden object carrying a static body. */
interface Solid {
  body: StaticBodyLike | null | undefined
  on(event: string, fn: (...args: never[]) => unknown, context: unknown): unknown
  off(event: string, fn: (...args: never[]) => unknown, context: unknown): unknown
  destroy(): void
}
interface StaticWorld {
  staticBodies: Entries<StaticBodyLike>
  staticTree: { insert(b: StaticBodyLike): void; remove(b: StaticBodyLike): void }
  /** Arcade's own one-by-one add (`World.add`): listed, in the tree, enabled. */
  add(b: StaticBodyLike): unknown
}
interface StaticGroupLike {
  children: Entries<unknown>
  add(o: never): unknown
  remove: (...args: never[]) => unknown
}

const bulkable = (world: StaticWorld, group: StaticGroupLike) => !perfWithout('bulk') && Array.isArray(group.children?.entries) && Array.isArray(world.staticBodies?.entries)

/**
 * Put solids whose static bodies are made (not yet in the world) into the
 * world and the group in one go, each as `physics.add.existing(o, true)`
 * then `group.add(o)` would: the body listed and in the static tree,
 * enabled, the object in the group, which drops it when it is destroyed.
 */
export function enableStatics(world: StaticWorld, group: StaticGroupLike, solids: readonly Solid[]): void {
  const one = !bulkable(world, group)
  for (const o of solids) {
    const body = o.body!
    if (one) {
      world.add(body)
      group.add(o as never)
      continue
    }
    world.staticBodies.entries.push(body)
    world.staticTree.insert(body)
    body.enable = true
    group.children.entries.push(o)
    o.on('destroy', group.remove, group)
  }
}

/**
 * Take solids out of the group and the world in one pass each, and destroy
 * them (their bodies leave the static tree now, not in the world's next
 * step).
 */
export function destroyStatics(world: StaticWorld, group: StaticGroupLike, solids: readonly Solid[]): void {
  if (!solids.length) return
  if (!bulkable(world, group)) {
    for (const o of solids) {
      ;(group.remove as (o: Solid) => unknown).call(group, o)
      o.destroy()
    }
    return
  }
  const going = new Set<unknown>(solids)
  const bodies = new Set(solids.map((o) => o.body))
  compact(group.children.entries, (o) => !going.has(o))
  compact(world.staticBodies.entries, (b) => !bodies.has(b))
  for (const o of solids) {
    o.off('destroy', group.remove, group)
    const body = o.body
    if (body) {
      world.staticTree.remove(body)
      body.enable = false
      body.world = undefined
      body.gameObject = undefined
    }
    o.body = undefined
    ;(o as unknown as { displayList: unknown }).displayList = OFF_LIST
    o.destroy()
  }
}

/** Keep the items that pass, in order, in place. */
function compact<T>(list: T[], keep: (t: T) => boolean): void {
  let kept = 0
  for (let i = 0; i < list.length; i++) if (keep(list[i]!)) list[kept++] = list[i]!
  list.length = kept
}
