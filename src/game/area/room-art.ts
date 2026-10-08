/**
 * Area construction — a village room's look (docs/design/indoors.md 2.7):
 * the indoors pass's floors, back wall and windows, doorway and stairs, the
 * furniture on its footprints (./room-kind.ts), the loft's roof beams over
 * everything; the side and near walls and the dark wood beyond them drawn
 * in code. Lighting, cheaply: a warm pool per `lights` row (a code-made
 * radial texture, additive, a hearth flickering) and a dark vignette at the
 * room's edges. No lighting engine, no day and night.
 *
 * Any frame that didn't load draws as the kit's placeholder: a plain box of
 * the footprint's size.
 */
import Phaser from 'phaser'
import { TILE, tileBottom, tileMid } from '../../lib/tile'
import { layoutHash01 } from '../../lib/hash'
import { hasInArt, inArt } from '../indoors-art'
import type { Footprint, RoomScene } from '../room-kind'
import type { RoomLight } from '../../lib/rooms'
import type { WorldData } from '../worlds'

/** The dark wood beyond a room's walls (the camera's backdrop indoors). */
export const ROOM_SURROUND = 0x22160f

/**
 * A prop's art: its frame, the loop it plays, and the frames of its states
 * (the sponge risen, the hoist mended, the shelves' fill, the lamp lit).
 */
interface PropArt {
  frame: string
  anim?: string
  states?: Record<string, string>
  /** Variants picked per footprint (the sacks). */
  variants?: string[]
}

const PROP_ART: Readonly<Record<string, PropArt>> = {
  'kitchen-hearth': { frame: 'oven-hearth-fire-0', anim: 'oven-hearth-fire' },
  'kitchen-crocks': { frame: 'crock-shelves' },
  'kitchen-tallow-pot': { frame: 'tallow-pot-steam-0', anim: 'tallow-steam' },
  'kitchen-worktable': { frame: 'worktable' },
  'kitchen-sponge-bowl': { frame: 'sponge-bowl-flat', states: { risen: 'sponge-bowl-risen' } },
  'kitchen-bread-rack': { frame: 'bread-rack' },
  'mill-gears': { frame: 'gear-train-0', anim: 'gear-train' },
  millstones: { frame: 'millstones-0', anim: 'millstones' },
  'mill-chute': { frame: 'chute-meal-bin-0' },
  'flour-sacks': { frame: 'flour-sacks-0', variants: ['flour-sacks-0', 'flour-sacks-1'] },
  'counting-stool': { frame: 'counting-stool-window' },
  'mill-hoist': { frame: 'sack-hoist-seized', states: { working: 'sack-hoist-working' } },
  'library-shelves': { frame: 'library-shelf-1', states: { sparse: 'library-shelf-0', half: 'library-shelf-1', full: 'library-shelf-2' } },
  'reading-table': { frame: 'reading-table-unlit', states: { lit: 'reading-table-lit' } },
  'donation-shelf': { frame: 'donation-shelf-0', states: { sparse: 'donation-shelf-0', half: 'donation-shelf-1', full: 'donation-shelf-2' } },
  'window-seat': { frame: 'window-seat' }
}

/** Light pools by kind: colour, strength, and how much they breathe. */
const LIGHTS: Readonly<Record<RoomLight['kind'], { tint: number; alpha: number; flicker: number }>> = {
  hearth: { tint: 0xff9a40, alpha: 0.5, flicker: 0.12 },
  lamp: { tint: 0xffc070, alpha: 0.4, flicker: 0.05 },
  window: { tint: 0xc8dcff, alpha: 0.18, flicker: 0 }
}

/**
 * A floor tile's variant: mostly the plain boards, the stained one (1) now
 * and then, so the floor never reads as a checkerboard.
 */
function floorVariant(r: number): number {
  return r < 0.45 ? 0 : r < 0.7 ? 2 : r < 0.94 ? 3 : 1
}

/** What the room layer asks the game while drawing (which state a prop is in, which lights burn). */
export interface RoomArtDeps {
  /** A prop's state by its art name (null: its first frame). */
  propState: (art: string) => string | null
  /** Whether a light row burns now (a banked hearth: dimmed; an unlit lamp: out). */
  lit: (kind: RoomLight['kind']) => boolean
  reducedMotion: boolean
}

export interface RoomArt {
  /** The props drawn, by art name (a state change swaps their frame). */
  props: Map<string, Phaser.GameObjects.Sprite[]>
  /** The same sprites in the order of the room's footprints. */
  sprites: Phaser.GameObjects.Sprite[]
  /** The light pools (dimmed when their light goes out). */
  lights: { kind: RoomLight['kind']; image: Phaser.GameObjects.Image; alpha: number }[]
  /** Redraw what follows the game's state (a prop's state, a light). */
  refresh(): void
}

/** The soft round light, once per game (white: each pool tints it). */
function lightTexture(scene: Phaser.Scene): string {
  const key = 'room-light'
  if (scene.textures.exists(key)) return key
  const t = scene.textures.createCanvas(key, 64, 64)!
  const ctx = t.getContext()
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.45, 'rgba(255,255,255,0.45)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  t.refresh()
  return key
}

/** The dark edge: clear in the middle, the surround's brown at the walls. */
function vignetteTexture(scene: Phaser.Scene): string {
  const key = 'room-vignette'
  if (scene.textures.exists(key)) return key
  const t = scene.textures.createCanvas(key, 128, 128)!
  const ctx = t.getContext()
  const g = ctx.createRadialGradient(64, 64, 26, 64, 64, 92)
  g.addColorStop(0, 'rgba(24,14,8,0)')
  g.addColorStop(0.6, 'rgba(24,14,8,0.22)')
  g.addColorStop(1, 'rgba(24,14,8,0.62)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 128, 128)
  t.refresh()
  return key
}

/** Side and near walls (the pass's crops of these didn't line up): timber over plaster, in code. */
function drawWalls(scene: Phaser.Scene, world: WorldData, room: RoomScene): void {
  const map = room.def.map
  const W = world.width
  const H = world.height
  const back = scene.add.graphics().setDepth(-7)
  const timber = 0x4a2c18
  const top = 0x6b4426
  const shade = 0x2c1a0e
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      if (map[y][x] !== '#') continue
      const px = x * TILE
      const py = y * TILE
      const side = (x === 0 || x === W - 1) && y < H - 1
      if (y === 0 && !side) continue // the back wall's art covers its top row
      if (side) {
        back.fillStyle(timber).fillRect(px, py, TILE, TILE)
        back.fillStyle(top).fillRect(x === 0 ? px + TILE - 4 : px, py, 4, TILE)
        back.fillStyle(shade).fillRect(x === 0 ? px + TILE - 1 : px, py, 1, TILE)
        continue
      }
      // The near wall: a beam's top edge seen from above, in front of anyone beside it.
      const near = scene.add.graphics().setDepth(tileBottom(y))
      near.fillStyle(timber).fillRect(px, py + 4, TILE, TILE - 4)
      near.fillStyle(top).fillRect(px, py + 2, TILE, 4)
      near.fillStyle(shade).fillRect(px, py + 2, TILE, 1)
      if ((x + y) % 3 === 0) near.fillStyle(shade).fillRect(px + 7, py + 7, 1, TILE - 9)
    }
}

/** A frame, or the kit's placeholder box when it didn't load. */
function placeProp(scene: Phaser.Scene, f: Footprint, frame: string, depth: number): Phaser.GameObjects.Sprite {
  const x = (f.tx + f.tw / 2) * TILE
  const y = tileBottom(f.ty + f.th - 1)
  if (hasInArt(scene, frame)) return scene.add.sprite(x, y, inArt(frame)).setOrigin(0.5, 1).setDepth(depth)
  const key = `room-box-${f.tw}x${f.th}`
  if (!scene.textures.exists(key)) {
    const t = scene.textures.createCanvas(key, f.tw * TILE, f.th * TILE + 6)!
    const ctx = t.getContext()
    ctx.fillStyle = '#5a3a22'
    ctx.fillRect(0, 0, f.tw * TILE, f.th * TILE + 6)
    ctx.fillStyle = '#8a6040'
    ctx.fillRect(1, 1, f.tw * TILE - 2, 6)
    ctx.strokeStyle = '#2c1a0e'
    ctx.strokeRect(0.5, 0.5, f.tw * TILE - 1, f.th * TILE + 5)
    t.refresh()
  }
  return scene.add.sprite(x, y, key).setOrigin(0.5, 1).setDepth(depth)
}

export function buildRoomArt(scene: Phaser.Scene, world: WorldData, deps: RoomArtDeps): RoomArt | null {
  const room = world.room
  if (!room) return null
  const map = room.def.map
  scene.cameras.main.setBackgroundColor(ROOM_SURROUND)
  // Floors: worn planks, the hearth's flagstones, under everything that stands.
  for (let y = 1; y < world.height; y++)
    for (let x = 0; x < world.width; x++) {
      const c = map[y][x]
      if (c === '#' || c === '=' || c === 'w') continue
      if (y === 1) continue // a back-wall prop: the wall is behind it
      const frame = `${c === ':' ? 'flagstone' : 'plank'}-floor-${floorVariant(layoutHash01(x, y, 21))}`
      if (hasInArt(scene, frame)) scene.add.image(x * TILE, y * TILE, inArt(frame)).setOrigin(0, 0).setDepth(-9)
    }
  // The back wall: two tiles tall from its foot on row 1, windows letting in daylight.
  for (let x = 1; x < world.width - 1; x++) {
    const frame = map[1][x] === 'w' ? 'back-wall-window' : `back-wall-${Math.floor(layoutHash01(x, 1, 22) * 3)}`
    if (hasInArt(scene, frame)) scene.add.image(tileMid(x), tileBottom(1), inArt(frame)).setOrigin(0.5, 1).setDepth(-8)
  }
  drawWalls(scene, world, room)
  if (room.doorway) placeProp(scene, room.doorway, 'doorway', tileBottom(room.doorway.ty))
  for (const s of room.stairs) placeProp(scene, s, s.art, -6)
  const props = new Map<string, Phaser.GameObjects.Sprite[]>()
  const sprites: Phaser.GameObjects.Sprite[] = []
  for (const f of room.props) {
    const art = PROP_ART[f.art]
    const frame = art?.variants ? art.variants[Math.floor(layoutHash01(f.tx, f.ty, 23) * art.variants.length)] : art?.frame ?? f.art
    const sprite = placeProp(scene, f, frame, tileBottom(f.ty + f.th - 1))
    if (art?.anim && !deps.reducedMotion && scene.anims.exists(inArt(art.anim))) sprite.play({ key: inArt(art.anim), startFrame: Math.floor(layoutHash01(f.tx, f.ty, 24) * 3) })
    sprites.push(sprite)
    const list = props.get(f.art) ?? []
    list.push(sprite)
    props.set(f.art, list)
  }
  // The loft's roof beams cross its top, over everyone.
  if (/:\d+$/.test(room.def.id) && hasInArt(scene, 'loft-roof-beams')) {
    scene.add.image(world.widthPx / 2, tileBottom(0) + 6, inArt('loft-roof-beams')).setOrigin(0.5, 1).setDepth(5200)
  }
  // Light pools, then the dark at the edges.
  const lights: RoomArt['lights'] = []
  const glow = lightTexture(scene)
  for (const l of room.def.lights) {
    const look = LIGHTS[l.kind]
    const size = l.r * TILE * 2
    const image = scene.add.image(tileMid(l.tx), tileMid(l.ty), glow).setDisplaySize(size, size).setTint(look.tint).setBlendMode(Phaser.BlendModes.ADD).setDepth(5100).setAlpha(look.alpha)
    lights.push({ kind: l.kind, image, alpha: look.alpha })
    if (look.flicker > 0 && !deps.reducedMotion) {
      const flick = () => {
        if (!image.active) return
        const on = deps.lit(l.kind) ? look.alpha : look.alpha * 0.3
        scene.tweens.add({ targets: image, alpha: on * (1 - look.flicker + Math.random() * look.flicker * 2), duration: 140 + Math.random() * 220, onComplete: flick })
      }
      flick()
    }
  }
  const pad = TILE * 2
  scene.add.image(world.widthPx / 2, world.heightPx / 2, vignetteTexture(scene)).setDisplaySize(world.widthPx + pad * 2, world.heightPx + pad * 2).setDepth(5300)
  const art: RoomArt = {
    props,
    sprites,
    lights,
    refresh() {
      for (const [name, sprites] of props) {
        const states = PROP_ART[name]?.states
        if (!states) continue
        const state = deps.propState(name)
        const frame = (state && states[state]) || PROP_ART[name].frame
        for (const s of sprites) if (hasInArt(scene, frame) && s.texture.key !== inArt(frame)) s.setTexture(inArt(frame))
      }
      for (const l of lights) if (!scene.tweens.isTweening(l.image)) l.image.setAlpha(deps.lit(l.kind) ? l.alpha : l.alpha * 0.3)
      // A lamp with no oil is out; a banked hearth only glows low.
      for (const l of lights) l.image.setVisible(l.kind !== 'lamp' || deps.lit(l.kind))
    }
  }
  art.refresh()
  return art
}
