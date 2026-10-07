/**
 * Area construction — props. Visible trees/bushes/rocks/well/mural and the
 * supplied atlas props, with explicit collision boxes at their bases.
 * Light-capable props are collected for the lantern visuals. Tile-anchored
 * sprites (the woods' pieces) come back by tile so gathering can fell them.
 */
import type Phaser from 'phaser'
import { TILE } from '../textures'
import type { WorldData } from '../worlds'
import type { LightProp } from './lanterns'
import { ensureSceneryTexture } from '../commons-art'
import { solidBox } from './collision'
import { addAll, looseImage } from './bulk'
import { ensureTangleAtlas } from '../wilds/tangle-art'
import { ensureMillTexture } from '../mill-art'

/**
 * Code-drawn scenery textures: the Commons' runs, the Tangle's woods, the
 * Tolley mill; or a texture already loaded (an item's own art, for a
 * planted sapling).
 */
export function ensureSceneryArt(scene: Phaser.Scene, key: string): boolean {
  return ensureSceneryTexture(scene, key) || ensureTangleAtlas(scene, key) || ensureMillTexture(scene, key) || scene.textures.exists(key)
}

export interface PropsBuilt {
  lights: LightProp[]
  /** Standing sprites by anchor tile (`tx,ty`): a felled piece removes its own. */
  sprites: Map<string, Phaser.GameObjects.Image[]>
}

export function buildProps(
  scene: Phaser.Scene,
  world: WorldData,
  solidGroup: Phaser.Physics.Arcade.StaticGroup
): PropsBuilt {
  const lightProps: LightProp[] = []
  const sprites = new Map<string, Phaser.GameObjects.Image[]>()
  const keep = (tx: number, ty: number, img: Phaser.GameObjects.Image) => {
    const key = `${tx},${ty}`
    const list = sprites.get(key) ?? []
    list.push(img)
    sprites.set(key, list)
  }
  // Trees by the thousand in the Commons: added in one go (./bulk.ts).
  const trees = world.trees.map((t) => {
    const img = looseImage(scene, t.tx * TILE + 8, t.ty * TILE + TILE, 'tree').setOrigin(0.5, 1)
    keep(t.tx, t.ty, img)
    return img
  })
  addAll(scene, trees)
  for (const b of world.bushes) {
    scene.add.image(b.tx * TILE + 8, b.ty * TILE + TILE, 'bush').setOrigin(0.5, 1).setDepth(b.ty * TILE + TILE)
  }
  for (const r of world.rocks) {
    keep(r.tx, r.ty, scene.add.image(r.tx * TILE + 8, r.ty * TILE + TILE, 'rock').setOrigin(0.5, 1).setDepth(r.ty * TILE + TILE))
  }
  if (world.well) {
    const w = world.well
    scene.add.image(w.tx * TILE + 6, w.ty * TILE + TILE, 'well').setOrigin(0.5, 1).setDepth(w.ty * TILE + TILE)
  }
  // The ruin's route marker is the quest's clue: it needs a visible stone
  // (it used to be an invisible interactable on a bare wall).
  if (world.mural) {
    const m = world.mural
    const x = m.tx * TILE + 8
    const y = m.ty * TILE + TILE
    const props = scene.textures.get('fingersnap-props')
    if (props.has('stone-milestone')) {
      const f = props.get('stone-milestone')!
      scene.add.image(x, y, 'fingersnap-props', 'stone-milestone').setOrigin(0.5, 1).setScale(22 / f.height).setDepth(y)
    } else {
      scene.add.image(x, y, 'mural').setOrigin(0.5, 1).setDepth(y)
    }
  }
  // Supplied atlas props at deliberate small-world display heights, with
  // explicit collision boxes at their bases.
  for (const p of world.props) {
    if (!scene.textures.get('fingersnap-props').has(p.frame)) continue
    const frame = scene.textures.get('fingersnap-props').get(p.frame)!
    const scale = p.h / frame.height
    const x = p.tx * TILE + TILE / 2
    const y = p.ty * TILE + TILE
    const img = scene.add.image(x, y, 'fingersnap-props', p.frame)
      .setOrigin(0.5, 1)
      .setScale(scale)
      .setDepth(y)
    solidGroup.add(solidBox(scene, x, y - p.body[1] / 2, p.body[0], p.body[1]))
    // Light-capable props get a glow anchor near their lamp
    if (p.light) {
      lightProps.push({ id: p.light, sprite: img, gx: x, gy: y - p.h * 0.72, glow: null })
    }
  }
  // Code-drawn scenery (the Commons, the Tangle): visual only, the solid
  // grid collides. Fading canopies are the foreground pass's (foreground.ts).
  for (const s of world.scenery ?? []) {
    if (s.fade || !ensureSceneryArt(scene, s.key)) continue
    const img = scene.add.image(s.x, s.y, s.key, s.frame).setOrigin(s.originX ?? 0.5, 1).setFlipX(s.flipX ?? false)
    img.setDepth(typeof s.depth === 'number' ? s.depth : s.y)
    if (s.tint !== undefined) img.setTint(s.tint)
    if (s.tx !== undefined && s.ty !== undefined) keep(s.tx, s.ty, img)
  }
  return { lights: lightProps, sprites }
}
