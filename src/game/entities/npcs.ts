/**
 * Area NPCs (Mara, Orrin, Pip): the delivered breathing art where available,
 * the restrained placeholder bob otherwise. Positions come from WorldData.
 */
import type Phaser from 'phaser'
import { TILE } from '../textures'
import type { InteractId, WorldData } from '../worlds'

export const NPC_NAMES: Record<string, string> = {
  mara: 'Mara',
  orrin: 'Orrin',
  pip: 'Pip'
}

export interface NpcEntity {
  id: Exclude<InteractId, 'clue' | 'lantern'>
  sprite: Phaser.GameObjects.Image | Phaser.GameObjects.Sprite
}

export class Npcs {
  readonly npcs: NpcEntity[] = []

  constructor(scene: Phaser.Scene, world: WorldData) {
    for (const n of world.npcs) {
      const x = n.tx * TILE + 8
      const y = n.ty * TILE + TILE
      // Delivered breathing art: two poses at 1.5 fps on a foot-anchored
      // sprite. The old bob tween is intentionally gone — the runtime-pass
      // README warns never to stack a bob on top of breathing (stable feet).
      const anim = `${n.id}-breathing`
      if (scene.anims.exists(anim) && scene.textures.exists(`${n.id}-idle-0`)) {
        const sprite = scene.add.sprite(x, y, `${n.id}-idle-0`)
          .setOrigin(0.5, 1)
          .setDepth(y)
        sprite.play(anim)
        this.npcs.push({ id: n.id, sprite })
      } else {
        // Fallback placeholder: static image with the old restrained bob.
        const sprite = scene.add.image(x, y, n.id)
          .setOrigin(0.5, 1)
          .setDepth(y)
        this.npcs.push({ id: n.id, sprite })
        scene.tweens.add({
          targets: sprite,
          y: '-=1.5',
          duration: 900 + Math.random() * 400,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut'
        })
      }
    }
  }

  /** Depth-by-y so NPCs sort against the hero, enemies and props. */
  updateDepth(): void {
    for (const npc of this.npcs) npc.sprite.setDepth(npc.sprite.y + 1)
  }
}
