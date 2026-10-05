/**
 * Area NPCs (Mara, Orrin, Pip, and the residents Elara, Finn, Hazel and
 * Ada): the delivered breathing art where available, the restrained
 * placeholder bob otherwise. Positions come from WorldData.
 */
import type Phaser from 'phaser'
import { TILE } from '../textures'
import { commonsAnim, commonsArt } from '../commons-pass'
import { isResident, residentName, RESIDENT_IDS } from '../../content/residents'
import type { InteractId, WorldData } from '../worlds'

export const NPC_NAMES: Record<string, string> = {
  mara: 'Mara',
  orrin: 'Orrin',
  pip: 'Pip',
  ...Object.fromEntries(RESIDENT_IDS.map((id) => [id, residentName(id)]))
}

/**
 * The residents' art comes with the Commons pass (`commons-art:<id>-…`);
 * if it didn't load, they borrow a quest NPC's placeholder, tinted.
 */
const RESIDENT_FALLBACK: Record<string, { key: string; tint: number }> = {
  elara: { key: 'mara', tint: 0xb8d0a8 },
  finn: { key: 'orrin', tint: 0xe8d8b0 },
  hazel: { key: 'mara', tint: 0xf0c0a0 },
  ada: { key: 'orrin', tint: 0xd0b8c8 }
}

/** The breathing animation and first idle frame for an NPC, when delivered. */
function idleArt(scene: Phaser.Scene, id: string): { anim: string; texture: string } | null {
  if (isResident(id)) {
    const anim = commonsAnim(scene, `${id}-breathing`)
    const texture = commonsArt(scene, `${id}-idle-0`)
    return anim && texture ? { anim, texture } : null
  }
  const anim = `${id}-breathing`
  return scene.anims.exists(anim) && scene.textures.exists(`${id}-idle-0`) ? { anim, texture: `${id}-idle-0` } : null
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
      const art = idleArt(scene, n.id)
      if (art) {
        const sprite = scene.add.sprite(x, y, art.texture)
          .setOrigin(0.5, 1)
          .setDepth(y)
        sprite.play(art.anim)
        this.npcs.push({ id: n.id, sprite })
      } else {
        // Fallback placeholder: static image with the old restrained bob.
        const fallback = RESIDENT_FALLBACK[n.id]
        const sprite = scene.add.image(x, y, fallback?.key ?? n.id)
          .setOrigin(0.5, 1)
          .setDepth(y)
        if (fallback) sprite.setTint(fallback.tint)
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
