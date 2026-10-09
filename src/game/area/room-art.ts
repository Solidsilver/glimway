/**
 * Area construction — a village room's look (docs/design/indoors.md 2.7,
 * 7.0): the indoors pass's floors, back wall and windows, doorway and
 * stairs; the room's furnishings (./furnishings-art.ts): its signature
 * pieces on their footprints (./room-kind.ts) and its dressing from the
 * shared kit; the loft's roof beams over everything; the side and near
 * walls and the dark wood beyond them drawn in code. Lighting, cheaply: a
 * warm pool per `lights` row (a code-made radial texture, additive) and a
 * dark vignette at the room's edges. No lighting engine, no day and night.
 * Everything is still unless a state says otherwise (a working machine) or
 * the current quest points at it (its light flickers).
 */
import Phaser from 'phaser'
import { TILE, tileBottom, tileMid } from '../../lib/tile'
import { layoutHash01 } from '../../lib/hash'
import { FLOOR_VARIANTS, hasInArt, inArt } from '../indoors-art'
import { wallFacing, type Footprint, type RoomScene } from '../room-kind'
import { furnishingFor } from '../../lib/furnishings'
import { drawPiece, setPieceState, type DrawnPiece, type PieceAt } from './furnishings-art'
import type { RoomLight } from '../../lib/rooms'
import type { WorldData } from '../worlds'

/** The dark wood beyond a room's walls (the camera's backdrop indoors). */
export const ROOM_SURROUND = 0x22160f

/** Light pools by kind: colour, strength, and how much they breathe. */
const LIGHTS: Readonly<Record<RoomLight['kind'], { tint: number; alpha: number; flicker: number }>> = {
  hearth: { tint: 0xff9a40, alpha: 0.5, flicker: 0.12 },
  lamp: { tint: 0xffc070, alpha: 0.4, flicker: 0.05 },
  window: { tint: 0xc8dcff, alpha: 0.18, flicker: 0 }
}

/** What the room layer asks the game while drawing (which state a prop is in, which lights burn). */
export interface RoomArtDeps {
  /**
   * A signature piece's state, from what has happened (Hazel home: the oven
   * lit; the hoist greased: working; null: its default).
   */
  propState: (f: Footprint) => string | null
  /**
   * Whether the current quest points at a piece (a spot on it or just in
   * front of it): only then does its light flicker.
   */
  pointed: (f: Footprint) => boolean
  /** Whether a light row burns now (a banked hearth: dimmed; an unlit lamp: out). */
  lit: (light: RoomLight) => boolean
  reducedMotion: boolean
}

export interface RoomArt {
  /** The signature pieces drawn, in the order of the room's footprints. */
  pieces: (DrawnPiece | null)[]
  /** The same pieces' sprites (null where the catalogue doesn't know the art: a placeholder box). */
  sprites: Phaser.GameObjects.Sprite[]
  /** The dressing, in the order of the room's dressing list. */
  dressing: DrawnPiece[]
  /** The light pools (dimmed when their light goes out). */
  lights: { kind: RoomLight['kind']; light: RoomLight; image: Phaser.GameObjects.Image; alpha: number }[]
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
      const family = c === ':' ? 'flagstone' : 'plank'
      const variants = FLOOR_VARIANTS[family]
      const frame = `${family}-floor-${variants[Math.floor(layoutHash01(x, y, 21) * variants.length)]}`
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
  // The signature pieces, each by its catalogue entry (a piece the catalogue doesn't know: a box).
  const pieces: (DrawnPiece | null)[] = []
  const sprites: Phaser.GameObjects.Sprite[] = []
  for (const f of room.props) {
    const piece = furnishingFor(f.art)
    const drawn = piece ? drawPiece(scene, piece, { tx: f.tx, ty: f.ty, facing: f.facing ?? wallFacing(world, f) }) : null
    pieces.push(drawn)
    sprites.push(drawn?.sprite ?? placeProp(scene, f, f.art, tileBottom(f.ty + f.th - 1)))
  }
  // The dressing (7.0 rule 3): the room's furnishings from the shared kit, by id (rooms.json); never blocks.
  const dressing: DrawnPiece[] = []
  for (const p of room.def.furnishings ?? []) {
    const piece = furnishingFor(p.piece)
    if (!piece) continue // the loader has refused this already
    const parent = p.parent !== undefined ? dressing[p.parent] : undefined
    // The loader's schema has checked the vocabularies.
    dressing.push(drawPiece(scene, piece, { tx: p.tx ?? 0, ty: p.ty ?? 0, facing: p.facing as PieceAt['facing'], parent, offer: p.offer as PieceAt['offer'], slot: p.slot }))
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
    // The piece a light belongs to (the oven's fire, the reading lamp's table): it flickers only while pointed at.
    const owner = room.props.find((f) => l.tx >= f.tx && l.tx < f.tx + f.tw && l.ty >= f.ty && l.ty < f.ty + f.th)
    const size = l.r * TILE * 2
    const image = scene.add.image(tileMid(l.tx), tileMid(l.ty), glow).setDisplaySize(size, size).setTint(look.tint).setBlendMode(Phaser.BlendModes.ADD).setDepth(5100).setAlpha(look.alpha)
    lights.push({ kind: l.kind, light: l, image, alpha: look.alpha })
    if (look.flicker > 0 && !deps.reducedMotion) {
      const flick = () => {
        if (!image.active) return
        const on = deps.lit(l) ? look.alpha : look.alpha * 0.3
        // Still unless the quest points at its piece: look again in a second.
        if (!owner || !deps.pointed(owner)) {
          image.setAlpha(on)
          scene.time.delayedCall(1000, flick)
          return
        }
        scene.tweens.add({ targets: image, alpha: on * (1 - look.flicker + Math.random() * look.flicker * 2), duration: 140 + Math.random() * 220, onComplete: flick })
      }
      flick()
    }
  }
  const pad = TILE * 2
  scene.add.image(world.widthPx / 2, world.heightPx / 2, vignetteTexture(scene)).setDisplaySize(world.widthPx + pad * 2, world.heightPx + pad * 2).setDepth(5300)
  const art: RoomArt = {
    pieces,
    sprites,
    dressing,
    lights,
    refresh() {
      // States follow what has happened; only a state's own slow loop moves.
      room.props.forEach((f, i) => {
        const d = pieces[i]
        if (d) setPieceState(scene, d, deps.propState(f), deps.reducedMotion)
      })
      for (const l of lights) if (!scene.tweens.isTweening(l.image)) l.image.setAlpha(deps.lit(l.light) ? l.alpha : l.alpha * 0.3)
      // A lamp with no oil is out; a banked hearth only glows low.
      for (const l of lights) l.image.setVisible(l.kind !== 'lamp' || deps.lit(l.light))
    }
  }
  art.refresh()
  return art
}
