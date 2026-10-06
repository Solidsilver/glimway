/**
 * Area construction — collisions. Static bodies for an area's solid tiles
 * and prop footprints, from the same WorldData the visuals are drawn from.
 * The merged runs and per-tile prop bodies come back so a cleared tile can
 * open up (gathering: a broken boulder, a dug stump).
 */
import type Phaser from 'phaser'
import { TILE } from '../textures'
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

export function buildSolids(scene: Phaser.Scene, world: WorldData): Solids {
  const group = scene.physics.add.staticGroup()
  const runs: SolidRun[] = []
  const props = new Map<string, Phaser.Physics.Arcade.Image[]>()
  const addBlock = (cx: number, cy: number, w: number, h: number) => {
    const img = scene.physics.add.staticImage(cx, cy, 'px').setDisplaySize(w, h).refreshBody()
    img.setVisible(false)
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
        runs.push({ x0: x, x1: x2, y, body: addBlock((x + (x2 - x + 1) / 2) * TILE, y * TILE + TILE / 2, (x2 - x + 1) * TILE, TILE) })
        x = x2 + 1
      } else {
        x++
      }
    }
  }
  // Prop bodies (visible sprites are drawn separately for depth sorting)
  const addPropBody = (tx: number, ty: number, w: number, h: number) => {
    const body = addBlock(tx * TILE + TILE / 2, ty * TILE + TILE - h / 2, w, h)
    const key = `${tx},${ty}`
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
