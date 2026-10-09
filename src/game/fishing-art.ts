/**
 * Fishing's art on the crafts pack (docs/design/crafts.md 9.3; the pack and
 * its `cr-art:<frame>` textures are src/game/crafts-art.ts): the float, the
 * rings, the landing splash and the held rod. Its loops are registered as
 * CRAFTS_LOOPS are. The fishing icons (rod, roach, fry, recipe card) stay
 * item icons in the items pass, where the inventory looks them up.
 */
import type Phaser from 'phaser'
import { registerAnims, type PassAnimation } from './art-pass.ts'
import { crArt } from './crafts-art.ts'

/** Faster than the art's 2 fps, which feels sleepy at game scale. */
export const FISHING_LOOPS: PassAnimation[] = [
  { key: 'fish-bob', frames: ['float-0', 'float-1', 'float-2', 'float-3'], frameRate: 2.4, repeat: -1 },
  // The bite: the float dips and comes up.
  { key: 'fish-bite', frames: ['float-4', 'float-5'], frameRate: 2.4, repeat: -1 },
  { key: 'fish-rings', frames: ['water-rings-0', 'water-rings-1', 'water-rings-2'], frameRate: 2.6, repeat: -1 },
  { key: 'fish-splash', frames: ['landing-splash-0', 'landing-splash-1', 'landing-splash-2', 'landing-splash-3'], frameRate: 11, repeat: 0 }
]

/** Every crafts frame fishing draws: the loops' frames and the held rod's two. */
export const FISHING_FRAMES: readonly string[] = [...new Set([...FISHING_LOOPS.flatMap((l) => l.frames), 'rod-held-out', 'rod-held-raised'])]

/** Register the fishing loops (once per game; a loop needs all its frames loaded). */
export function registerFishingLoops(scene: Phaser.Scene): void {
  registerAnims(scene, FISHING_LOOPS.map((l) => ({ ...l, key: crArt(l.key), frames: l.frames.map(crArt) })), (f) => scene.textures.exists(f))
}
