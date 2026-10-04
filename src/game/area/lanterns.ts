/**
 * Area construction — lights. Atlas-prop lanterns that can glow when lit
 * (the shrine, the village lantern, and the road lanterns), plus the
 * quest-driven lit/dim visuals.
 */
import Phaser from 'phaser'
import { isLit, ROAD_LANTERNS, type RoadLanternId } from '../../lib/embers'
import type { GameState, QuestStage } from '../../lib/state'

/** Atlas-prop lanterns that can glow when lit: shrine and village lantern. */
export interface LightProp {
  id: string
  sprite: Phaser.GameObjects.Image
  gx: number
  gy: number
  glow: Phaser.GameObjects.Image | null
}

/**
 * Lit-lantern visuals depend on quest progress. The atlas props stay in
 * place; lighting adds an additive glow anchored at the lamp.
 */
export function refreshLanternVisuals(
  scene: Phaser.Scene,
  lightProps: LightProp[],
  stage: QuestStage,
  state: GameState
): void {
  if (lightProps.length === 0) return
  const shrineLit = stage === 'lantern-lit' || stage === 'complete'
  const villageLit = stage === 'complete'
  for (const lp of lightProps) {
    const isShrine = lp.id === 'shrine'
    const shouldGlow = isShrine
      ? shrineLit
      : lp.id === 'village'
        ? villageLit
        : (ROAD_LANTERNS as readonly string[]).includes(lp.id) && isLit(state, lp.id as RoadLanternId)
    // The delivered art is drawn lit; dim it until the flame is relit so
    // lighting it is a visible change, not just an added halo.
    if (shouldGlow) lp.sprite.clearTint()
    else lp.sprite.setTint(0x8a849c)
    if (shouldGlow && !lp.glow) {
      lp.glow = scene.add.image(lp.gx, lp.gy, 'glow')
        .setBlendMode(Phaser.BlendModes.ADD)
        .setScale(isShrine ? 1.4 : 1.1)
        .setDepth(4001)
      scene.tweens.add({
        targets: lp.glow,
        alpha: 0.72,
        duration: isShrine ? 900 : 1100,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut'
      })
    }
  }
}
