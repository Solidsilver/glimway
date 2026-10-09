/**
 * The 0.5 crafts pass (assets/generated/crafts-pass/, docs/design/crafts.md
 * 9): ability icons and effects, the stable, fishing and the HUD icons. The
 * build packs every frame's whole canvas at 64 texels per 16-px tile
 * (scripts/build-atlases.ts → crafts.webp, loaded as `packed-crafts`); at
 * boot each becomes a dense texture `cr-art:<frame>` at its world size
 * (./density.ts), and the effect loops below are registered.
 *
 * Missing art is never fatal: the moves draw calm code shapes instead
 * (./entities/moves.ts).
 */
import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, type PackedManifest } from './atlas-plan.ts'
import { explodeFrames, registerAnims, type PassAnimation } from './art-pass.ts'
import { TILE } from '../lib/tile.ts'
import { artDataUrl, artSource } from './density.ts'
import { ABILITIES, type Ability } from '../lib/abilities.ts'

/** Texture key of the packed crafts atlas (./packed.ts loads it). */
export const CRAFTS_PACKED_KEY = 'packed-crafts'

export const crArt = (frame: string): string => `cr-art:${frame}`

/** The pass names an ability's icon by class and id (`ability-mage-kindle`); the table's `icon` is `ability-kindle`. */
export const abilityIconFrame = (a: Pick<Ability, 'class' | 'id'>): string => `ability-${a.class}-${a.id}`

/** The moves' effect loops (frame rates kept slow: calm, not flashy). */
export const CRAFTS_LOOPS: PassAnimation[] = [
  // Planting, then held: plays once and stays on the last frame.
  { key: 'stand-ring', frames: ['stand-ground-ring-0', 'stand-ground-ring-1', 'stand-ground-ring-2', 'stand-ground-ring-3'], frameRate: 10, repeat: 0 },
  { key: 'kindle-patch', frames: ['kindle-hollow-light-0', 'kindle-hollow-light-1', 'kindle-hollow-light-2', 'kindle-hollow-light-3'], frameRate: 5, repeat: -1 },
  // Frame 0 is the still circle; 1–3 a brighter ring moving outwards.
  { key: 'ward-pulse', frames: ['ward-light-circle-1', 'ward-light-circle-2', 'ward-light-circle-3'], frameRate: 8, repeat: 0 }
]

/** Make the crafts textures and loops, once. False when the pack didn't load. */
export function createCraftsArt(scene: Phaser.Scene): boolean {
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.crafts
  if (!packed) return false
  const perPx = packed.density / TILE
  const frames = Object.entries(packed.frames).map(([key, r]) => ({ key, width: r[2] / perPx, height: r[3] / perPx }))
  const made = explodeFrames(scene, CRAFTS_PACKED_KEY, { ...packed, density: perPx }, frames, crArt)
  if (!made) return false
  registerAnims(scene, CRAFTS_LOOPS.map((l) => ({ ...l, key: crArt(l.key), frames: l.frames.map(crArt) })), (f) => scene.textures.exists(f))
  return true
}

/** Whether a crafts frame loaded. */
export function hasCrArt(scene: Phaser.Scene, frame: string): boolean {
  return scene.textures.exists(crArt(frame))
}

/** HUD icons, by the key the interface asks for (EV.artIcons). */
const HUD_ICONS: Record<string, string> = {
  'hud-saddle': 'saddle',
  'hud-go-home': 'go-home',
  'hud-companions': 'companions-tab'
}

/**
 * The pass's interface icons (EV.artIcons): every ability under its
 * table `icon` key (`ability-kindle`), and the HUD's saddle, Go home and
 * Companions icons (`hud-saddle`, …). Drawn at the art's full density.
 */
export function craftsIconUrls(scene: Phaser.Scene): Record<string, string> {
  const wanted: Record<string, string> = { ...HUD_ICONS }
  for (const a of ABILITIES.abilities) wanted[a.icon] = abilityIconFrame(a)
  const out: Record<string, string> = {}
  for (const [key, frame] of Object.entries(wanted)) {
    const src = artSource(scene, crArt(frame))
    if (!src) continue
    try {
      out[key] = artDataUrl(src, src.density)
    } catch {
      /* an icon is optional: the interface draws its own */
    }
  }
  return out
}
