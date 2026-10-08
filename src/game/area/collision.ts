/**
 * Area construction — collisions. Static bodies for an area's solid tiles
 * and prop footprints, from the same WorldData the visuals are drawn from.
 * The merged runs and per-tile prop bodies come back so a cleared tile can
 * open up (gathering: a broken boulder, a dug stump).
 */
import Phaser from 'phaser'
import { TILE, tileBottom, tileKey, tileMid } from '../../lib/tile'
import type { WorldData } from '../worlds'

/** One merged horizontal run of solid tiles, and its body. */
export interface SolidRun {
  x0: number
  x1: number
  y: number
  body: Phaser.Physics.Arcade.Image
}

export interface Solids {
  group: Phaser.Physics.Arcade.StaticGroup
  runs: SolidRun[]
  /** Prop-footprint bodies by tile (`tx,ty`) — trees, bushes, rocks, the well. */
  props: Map<string, Phaser.Physics.Arcade.Image[]>
}

/**
 * An invisible static collision box. It's never put on the display list:
 * the Commons makes about 1,400 of them, and the display list de-duplicates
 * every add with a linear scan, so adding them made each scene build
 * quadratic (around half a second of blocked main thread entering the
 * Commons). Physics doesn't need the display list.
 */
export function solidBox(scene: Phaser.Scene, cx: number, cy: number, w: number, h: number): Phaser.Physics.Arcade.Image {
  const img = new Phaser.Physics.Arcade.Image(scene, cx, cy, 'px').setDisplaySize(w, h).setVisible(false)
  scene.physics.add.existing(img, true)
  return img
}

export function buildSolids(scene: Phaser.Scene, world: WorldData): Solids {
  const group = scene.physics.add.staticGroup()
  const runs: SolidRun[] = []
  const props = new Map<string, Phaser.Physics.Arcade.Image[]>()
  const addBlock = (cx: number, cy: number, w: number, h: number) => {
    const img = solidBox(scene, cx, cy, w, h)
    group.add(img)
    return img
  }
  // Terrain solid tiles, merged into horizontal runs
  for (let y = 0; y < world.height; y++) {
    let x = 0
    while (x < world.width) {
      if (world.solid[y][x]) {
        let x2 = x
        while (x2 + 1 < world.width && world.solid[y][x2 + 1]) x2++
        runs.push({ x0: x, x1: x2, y, body: addBlock((x + (x2 - x + 1) / 2) * TILE, tileMid(y), (x2 - x + 1) * TILE, TILE) })
        x = x2 + 1
      } else {
        x++
      }
    }
  }
  // Prop bodies (visible sprites are drawn separately for depth sorting)
  const addPropBody = (tx: number, ty: number, w: number, h: number) => {
    // On a solid tile the run's body already covers this box (every tree
    // stands on one): a second body would only slow the build down. Clearing
    // the tile (WorldScene.clearSolidTile) opens the run either way.
    if (world.solid[ty]?.[tx]) return
    const body = addBlock(tileMid(tx), tileBottom(ty) - h / 2, w, h)
    const key = tileKey(tx, ty)
    const list = props.get(key) ?? []
    list.push(body)
    props.set(key, list)
  }
  for (const t of world.trees) addPropBody(t.tx, t.ty, 12, 6)
  for (const b of world.bushes) addPropBody(b.tx, b.ty, 12, 8)
  for (const r of world.rocks) addPropBody(r.tx, r.ty, 12, 8)
  if (world.well) addPropBody(world.well.tx, world.well.ty, 14, 10)
  if (world.mural) addPropBody(world.mural.tx, world.mural.ty, 16, 8)
  for (const n of world.npcs) addPropBody(n.tx, n.ty, 12, 8)
  return { group, runs, props }
}

/**
 * A worked piece leaves open ground (a broken boulder, a dug stump): the
 * tile opens in the solid grid, its run body is split or dropped, and any
 * prop body there goes with it. Scenery-only: regrows on the next visit.
 */
export function clearSolidTile(scene: Phaser.Scene, world: WorldData, solids: Solids, tx: number, ty: number): void {
  // A prop's own body first (the woods' rocks are props on open ground).
  for (const body of solids.props.get(tileKey(tx, ty)) ?? []) {
    solids.group.remove(body)
    body.destroy()
  }
  solids.props.delete(tileKey(tx, ty))
  if (!world.solid[ty]?.[tx]) return
  world.solid[ty][tx] = false
  const i = solids.runs.findIndex((r) => r.y === ty && tx >= r.x0 && tx <= r.x1)
  if (i < 0) return
  const run = solids.runs.splice(i, 1)[0]
  solids.group.remove(run.body)
  run.body.destroy()
  for (const [x0, x1] of [
    [run.x0, tx - 1],
    [tx + 1, run.x1]
  ] as const) {
    if (x1 < x0) continue
    const body = solidBox(scene, (x0 + (x1 - x0 + 1) / 2) * TILE, tileMid(ty), (x1 - x0 + 1) * TILE, TILE)
    solids.group.add(body)
    solids.runs.push({ x0, x1, y: ty, body })
  }
}
