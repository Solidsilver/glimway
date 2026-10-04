/**
 * Area construction — props. Visible trees/bushes/rocks/well/mural and the
 * supplied atlas props, with explicit collision boxes at their bases.
 * Light-capable props are collected for the lantern visuals.
 */
import type Phaser from 'phaser'
import { TILE } from '../textures'
import type { WorldData } from '../worlds'
import type { LightProp } from './lanterns'

export function buildProps(
  scene: Phaser.Scene,
  world: WorldData,
  solidGroup: Phaser.Physics.Arcade.StaticGroup
): LightProp[] {
  const lightProps: LightProp[] = []
  for (const t of world.trees) {
    scene.add.image(t.tx * TILE + 8, t.ty * TILE + TILE, 'tree').setOrigin(0.5, 1)
  }
  for (const b of world.bushes) {
    scene.add.image(b.tx * TILE + 8, b.ty * TILE + TILE, 'bush').setOrigin(0.5, 1).setDepth(b.ty * TILE + TILE)
  }
  for (const r of world.rocks) {
    scene.add.image(r.tx * TILE + 8, r.ty * TILE + TILE, 'rock').setOrigin(0.5, 1).setDepth(r.ty * TILE + TILE)
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
    const body = scene.physics.add.staticImage(x, y - p.body[1] / 2, 'px')
      .setDisplaySize(p.body[0], p.body[1])
      .refreshBody()
    body.setVisible(false)
    solidGroup.add(body)
    // Light-capable props get a glow anchor near their lamp
    if (p.light) {
      lightProps.push({ id: p.light, sprite: img, gx: x, gy: y - p.h * 0.72, glow: null })
    }
  }
  return lightProps
}
