/**
 * The playtest-1 people: the residents' walking, breathing and sitting
 * frames and the held tools, packed by scripts/build-atlases.ts into one
 * dense atlas (src/game/atlas-plan.ts PackedPeople). At boot it becomes the
 * `people` texture at the art's density (./density.ts artDensity: phones
 * get it box-filtered 2:1, the Canvas renderer 4:1; every rect is a
 * multiple of 4 texels, so the copies stay exact) with the resident
 * animations as `people:<key>`.
 *
 * A frame is its whole canvas (residents 64×128 texels at 4×, 16×32 world
 * px, feet at the bottom centre; held tools HELD_WORLD px a side, gripped at
 * `hand`), trimmed: Phaser keeps the canvas size, so origins work on the
 * whole canvas. Sprites draw it at `1 / density` scale.
 */
import type Phaser from 'phaser'
import { PACKED_MANIFEST_KEY, PEOPLE, type PackedManifest, type PersonId } from './atlas-plan.ts'
import { artDensity, resampleFor } from './density.ts'

/** The packed atlas as loaded (staging: released once `people` is built). */
export const PEOPLE_PACKED_KEY = 'packed-people'
/** The people atlas the game draws from. */
export const PEOPLE_KEY = 'people'

export type Facing = 'down' | 'up' | 'left' | 'right'

/** Texels per world px of the `people` texture (0 when it isn't built). */
export function peopleDensity(scene: Phaser.Scene): number {
  if (!scene.textures.exists(PEOPLE_KEY)) return 0
  return (scene.textures.get(PEOPLE_KEY).customData as { density?: number }).density ?? 0
}

/** Hand grips (canvas texels at the built density), by held frame. */
const hands = new Map<string, [number, number]>()

/** Build the `people` atlas and its animations, once. False when the pack didn't load. */
export function createPeople(scene: Phaser.Scene): boolean {
  if (scene.textures.exists(PEOPLE_KEY)) return true
  const packed = (scene.cache.json.get(PACKED_MANIFEST_KEY) as PackedManifest | undefined)?.people
  if (!packed || !scene.textures.exists(PEOPLE_PACKED_KEY)) return false
  const image = scene.textures.get(PEOPLE_PACKED_KEY).getSourceImage() as HTMLImageElement | HTMLCanvasElement
  const k = Math.min(artDensity(scene), packed.density)
  const s = k / packed.density
  let source: HTMLImageElement | HTMLCanvasElement = image
  if (s !== 1) {
    const c = document.createElement('canvas')
    c.width = Math.round(packed.size[0] * s)
    c.height = Math.round(packed.size[1] * s)
    const ctx = c.getContext('2d')!
    resampleFor(ctx, packed.density, k)
    ctx.drawImage(image, 0, 0, c.width, c.height)
    source = c
  }
  const frames: Record<string, unknown> = {}
  for (const [name, f] of Object.entries(packed.frames)) {
    const [x, y, w, h] = f.frame.map((v) => v * s)
    frames[name] = {
      frame: { x, y, w, h },
      rotated: false,
      trimmed: true,
      spriteSourceSize: { x: f.at[0] * s, y: f.at[1] * s, w, h },
      sourceSize: { w: f.source[0] * s, h: f.source[1] * s },
    }
    if (f.hand) hands.set(name, [f.hand[0] * s, f.hand[1] * s])
  }
  const t = scene.textures.addAtlasJSONHash(PEOPLE_KEY, source as HTMLImageElement, { frames })
  if (!t) return false
  ;(t.customData as { density?: number }).density = k
  scene.textures.remove(PEOPLE_PACKED_KEY)
  for (const a of packed.animations) {
    const key = `people:${a.key}`
    if (scene.anims.exists(key)) continue
    scene.anims.create({ key, frames: a.frames.map((frame) => ({ key: PEOPLE_KEY, frame })), frameRate: a.frameRate, repeat: a.repeat })
  }
  return true
}

export function hasPerson(scene: Phaser.Scene, id: string): id is PersonId {
  return (PEOPLE as readonly string[]).includes(id) && scene.textures.exists(PEOPLE_KEY) && scene.textures.get(PEOPLE_KEY).has(`resident-${id}-down-idle-0`)
}

/** A resident's breathing (standing) or walking animation, facing `dir`. */
export function personAnim(id: PersonId, dir: Facing, walking: boolean): string {
  return `people:resident-${id}-${dir}-${walking ? 'walking' : 'breathing'}`
}

/** A resident's seated frame (they only sit facing down). */
export function sitFrame(id: PersonId): string {
  return `resident-${id}-sit-down`
}

/** The held-tool art for each item that has one. */
export const HELD_ART: Readonly<Record<string, string>> = {
  'bench-axe': 'bench-axe',
  'brack-felling-axe': 'felling-axe',
  'bench-pick': 'pick',
  'orrins-mason-pick': 'pick',
  'bench-spade': 'spade',
  'ada-garden-spade': 'spade',
  'stave-bucket': 'stave-bucket',
  'watering-can': 'watering-can',
  'carters-lantern': 'carter-lantern',
}

/** The held frame for an item facing `dir`, when it has art and the atlas has it. */
export function heldFrame(scene: Phaser.Scene, itemDef: string, dir: Facing): string | null {
  const art = HELD_ART[itemDef]
  if (!art || !scene.textures.exists(PEOPLE_KEY)) return null
  const name = `held-${art}-${dir}`
  return scene.textures.get(PEOPLE_KEY).has(name) ? name : null
}

/** A held frame's grip as an origin (0..1 of its canvas). */
export function heldOrigin(scene: Phaser.Scene, frame: string): [number, number] {
  const f = scene.textures.getFrame(PEOPLE_KEY, frame)
  const h = hands.get(frame)
  if (!f || !h) return [0.5, 0.85]
  return [h[0] / f.realWidth, h[1] / f.realHeight]
}

/** Which way a movement (or a look) faces: the larger axis wins. */
export function facingOf(dx: number, dy: number, fallback: Facing = 'down'): Facing {
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return fallback
  if (Math.abs(dx) > Math.abs(dy)) return dx < 0 ? 'left' : 'right'
  return dy < 0 ? 'up' : 'down'
}
