/**
 * Area construction — props. Visible trees/bushes/rocks/well/mural and the
 * supplied atlas props, with explicit collision boxes at their bases.
 * Light-capable props are collected for the lantern visuals. Tile-anchored
 * sprites (the woods' pieces) come back by tile so gathering can fell them.
 */
import type Phaser from 'phaser'
import { TILE, tileBottom, tileKey, tileMid } from '../../lib/tile'
import type { WorldData } from '../worlds'
import type { LightProp } from './lanterns'
import { ensureSceneryTexture } from '../commons-art'
import { solidBox } from './collision'
import { addAll, looseImage } from './bulk'
import { ensureTangleAtlas } from '../wilds/tangle-art'
import { TILE_DATA, type TileArt } from './tile-art'

/**
 * Code-drawn scenery textures: the Commons' runs, the Tangle's woods; or a
 * texture already loaded (the Tolley mill's, from the items pass; an item's
 * own art, for a planted sapling).
 */
export function ensureSceneryArt(scene: Phaser.Scene, key: string): boolean {
  return ensureSceneryTexture(scene, key) || ensureTangleAtlas(scene, key) || scene.textures.exists(key)
}

export interface PropsBuilt {
  lights: LightProp[]
}

export function buildProps(
  scene: Phaser.Scene,
  world: WorldData,
  solidGroup: Phaser.Physics.Arcade.StaticGroup,
  /** Standing sprites by anchor tile: a felled piece removes its own. */
  art: TileArt<Phaser.GameObjects.Image>
): PropsBuilt {
  const lightProps: LightProp[] = []
  const keep = (tx: number, ty: number, img: Phaser.GameObjects.Image) => {
    img.setData(TILE_DATA, tileKey(tx, ty))
    art.keep(tx, ty, img)
  }
  // Trees by the thousand in the Commons: added in one go (./bulk.ts).
  const trees = world.trees.map((t) => {
    const img = looseImage(scene, tileMid(t.tx), tileBottom(t.ty), 'tree').setOrigin(0.5, 1)
    keep(t.tx, t.ty, img)
    return img
  })
  addAll(scene, trees)
  for (const b of world.bushes) {
    scene.add.image(tileMid(b.tx), tileBottom(b.ty), 'bush').setOrigin(0.5, 1).setDepth(tileBottom(b.ty))
  }
  for (const r of world.rocks) {
    keep(r.tx, r.ty, scene.add.image(tileMid(r.tx), tileBottom(r.ty), 'rock').setOrigin(0.5, 1).setDepth(tileBottom(r.ty)))
  }
  if (world.well) {
    const w = world.well
    scene.add.image(w.tx * TILE + 6, tileBottom(w.ty), 'well').setOrigin(0.5, 1).setDepth(tileBottom(w.ty))
  }
  // The ruin's route marker is the quest's clue: it needs a visible stone
  // (it used to be an invisible interactable on a bare wall).
  if (world.mural) {
    const m = world.mural
    const x = tileMid(m.tx)
    const y = tileBottom(m.ty)
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
    const x = tileMid(p.tx)
    const y = tileBottom(p.ty)
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
  return { lights: lightProps }
}
