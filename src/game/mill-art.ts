/**
 * The Tolley mill, code-drawn in the game's pixel style (1 px dark
 * outlines, warm palette, crisp nearest-neighbour), until the art pack
 * has one (docs/art-requests.md, "Tolley mill"):
 *
 *   - `mill-house`   64×64: timber walls on a stone footing, a slate roof,
 *                    a sack-hoist beam over the door, flour on the step.
 *   - `mill-hopper`  16×20: a grain hopper on splayed legs, tallies in fives.
 *   - `mill-wheel-<n>` / `mill-wheel-mended-<n>` 32×32, n = 0..3: the
 *                    waterwheel in four steps of an eighth-turn (eight
 *                    paddles, so frame 3 runs back into frame 0). The
 *                    mended wheel has new pale paddles, rope lashings at
 *                    every spoke and an iron band; the old one is grey and
 *                    has a split paddle.
 *   - `mill-froth-<n>` 14×6, n = 0..1: white water where the paddles bite.
 *
 * Nothing here is a third-party asset. Made on demand
 * (`ensureMillTexture`), like the Commons' hedge runs.
 */
import type Phaser from 'phaser'

type C = CanvasRenderingContext2D

const O = '#3a2a28'
const WOOD = { hi: '#c49a62', lt: '#a8804e', md: '#8a6642', dk: '#6b4c2e', xd: '#4a3220' }
const OLD = { hi: '#a39580', lt: '#8a7c68', md: '#6e6252', dk: '#54493c', xd: '#3c342b' }
const NEW = { hi: '#e2c08a', lt: '#d0a86c', md: '#b08850' }
const STONE = { hi: '#cfc6b6', lt: '#b0a796', md: '#958c7d', dk: '#7a7264', xd: '#5c564c' }
const SLATE = { hi: '#7d8794', md: '#5e6773', dk: '#454c57', xd: '#323843' }
const ROPE = '#e6d6a0'
const IRON = '#4b4f57'
const FLOUR = '#f4eee0'
const GLOW = '#ffd98a'

/** Wheel frames (one eighth-turn in four steps). */
export const MILL_WHEEL_FRAMES = 4
export const MILL_WHEEL_SIZE = 32

function rect(c: C, x: number, y: number, w: number, h: number, col: string): void {
  if (w <= 0 || h <= 0) return
  c.fillStyle = col
  c.fillRect(x, y, w, h)
}

function px(c: C, x: number, y: number, col: string): void {
  rect(c, x, y, 1, 1, col)
}

/** Deterministic 0..1 per pixel, for speckle. */
function h01(x: number, y: number, s = 0): number {
  let v = (x * 73856093) ^ (y * 19349663) ^ (s * 83492791)
  v = Math.imul(v ^ (v >>> 13), 1274126177)
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296
}

function make(scene: Phaser.Scene, key: string, w: number, h: number, draw: (c: C) => void): void {
  if (scene.textures.exists(key)) return
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const c = canvas.getContext('2d')!
  c.imageSmoothingEnabled = false
  draw(c)
  scene.textures.addCanvas(key, canvas)
}

// ------------------------------------------------------------ the house

function drawHouse(c: C): void {
  // Stone footing (the lower 9 px), coursed and mossy at the joints.
  rect(c, 1, 54, 62, 10, O)
  for (let y = 55; y < 63; y++)
    for (let x = 2; x < 62; x++) {
      const course = Math.floor((y - 55) / 4)
      const joint = (y - 55) % 4 === 3 || (x + course * 5) % 10 === 0
      px(c, x, y, joint ? STONE.dk : h01(x, y, 3) < 0.25 ? STONE.hi : h01(x, y, 4) < 0.5 ? STONE.lt : STONE.md)
    }
  // Timber walls: upright boards, weathered.
  rect(c, 3, 25, 58, 30, O)
  for (let y = 26; y < 54; y++)
    for (let x = 4; x < 60; x++) {
      const seam = (x - 4) % 5 === 4
      px(c, x, y, seam ? WOOD.dk : h01(x, y, 7) < 0.12 ? WOOD.lt : (x - 4) % 10 < 5 ? WOOD.md : '#93704a')
    }
  // A beam under the eaves.
  rect(c, 3, 25, 58, 3, O)
  rect(c, 4, 26, 56, 1, WOOD.dk)
  // Slate roof, gable-end on, overhanging the walls.
  for (let y = 2; y <= 26; y++) {
    const half = Math.round(6 + (y - 2) * (26 / 24))
    const x0 = 32 - half
    const x1 = 32 + half - 1
    px(c, x0, y, O)
    px(c, x1, y, O)
    for (let x = x0 + 1; x < x1; x++) {
      const row = Math.floor((y - 2) / 3)
      const edge = (y - 2) % 3 === 2
      const tile = (x + (row % 2) * 2) % 4 === 0
      px(c, x, y, edge ? SLATE.xd : tile ? SLATE.dk : h01(x, y, 9) < 0.18 ? SLATE.hi : SLATE.md)
    }
  }
  rect(c, 26, 1, 12, 1, O)
  rect(c, 27, 2, 10, 1, SLATE.hi)
  rect(c, 0, 26, 64, 1, O)
  // The loft door and sack-hoist beam high on the gable.
  rect(c, 27, 13, 10, 10, O)
  rect(c, 28, 14, 8, 8, WOOD.dk)
  rect(c, 31, 14, 1, 8, WOOD.xd)
  rect(c, 22, 11, 20, 2, O)
  rect(c, 23, 11, 18, 1, WOOD.lt)
  px(c, 24, 13, IRON)
  rect(c, 24, 14, 1, 14, ROPE)
  // Front door (the door tile is the second column: x 16..31).
  rect(c, 17, 37, 14, 18, O)
  rect(c, 18, 38, 12, 17, WOOD.dk)
  for (let x = 18; x < 30; x += 3) rect(c, x, 38, 1, 17, WOOD.xd)
  rect(c, 18, 42, 12, 1, WOOD.xd)
  rect(c, 18, 50, 12, 1, WOOD.xd)
  px(c, 27, 46, '#e0c070')
  // A small lit window, shuttered open.
  rect(c, 41, 36, 10, 9, O)
  rect(c, 42, 37, 8, 7, GLOW)
  rect(c, 45, 37, 1, 7, O)
  rect(c, 42, 40, 8, 1, O)
  rect(c, 38, 36, 3, 9, WOOD.lt)
  rect(c, 51, 36, 3, 9, WOOD.lt)
  // Sacks against the wall by the door, and flour dust on the step.
  for (const [sx, sy] of [[6, 46], [10, 48]] as const) {
    rect(c, sx, sy, 7, 8, O)
    rect(c, sx + 1, sy + 1, 5, 7, '#d8c8a0')
    rect(c, sx + 2, sy, 3, 1, '#b8a678')
  }
  rect(c, 15, 60, 18, 3, STONE.hi)
  for (let x = 14; x < 36; x++) for (let y = 58; y < 64; y++) if (h01(x, y, 11) < (y > 59 ? 0.55 : 0.2)) px(c, x, y, FLOUR)
}

function drawHopper(c: C): void {
  // Splayed legs.
  rect(c, 2, 11, 2, 9, O)
  rect(c, 12, 11, 2, 9, O)
  px(c, 3, 12, WOOD.md)
  px(c, 12, 12, WOOD.md)
  rect(c, 3, 16, 10, 1, WOOD.dk)
  // The funnel box: wide at the top, narrowing to the spout.
  for (let y = 2; y <= 12; y++) {
    const inset = Math.floor((y - 2) / 2)
    rect(c, inset, y, 16 - inset * 2, 1, O)
    rect(c, inset + 1, y, 14 - inset * 2, 1, (y + inset) % 4 === 0 ? WOOD.dk : WOOD.md)
  }
  rect(c, 0, 1, 16, 2, O)
  rect(c, 1, 1, 14, 1, WOOD.lt)
  // Grain heaped in the top, flour dusting the spout.
  rect(c, 3, 0, 10, 1, '#d8c070')
  rect(c, 6, 13, 4, 2, O)
  px(c, 7, 15, FLOUR)
  px(c, 8, 16, FLOUR)
  // Tallies scratched in fives on the side.
  for (let i = 0; i < 3; i++) {
    const x = 3 + i * 3
    for (let k = 0; k < 2; k++) px(c, x + k, 6, WOOD.hi)
    px(c, x, 7, WOOD.hi)
  }
}

// ------------------------------------------------------------ the wheel

function drawWheel(c: C, frame: number, mended: boolean): void {
  const S = MILL_WHEEL_SIZE
  const cx = (S - 1) / 2
  const cy = (S - 1) / 2
  const step = Math.PI / 4
  const turn = (frame / MILL_WHEEL_FRAMES) * step
  const W = mended ? WOOD : OLD
  /** Angular distance to the nearest of the eight spokes. */
  const off = (a: number) => {
    let d = (a - turn) % step
    if (d < 0) d += step
    return Math.min(d, step - d)
  }
  for (let y = 0; y < S; y++)
    for (let x = 0; x < S; x++) {
      const dx = x - cx
      const dy = y - cy
      const r = Math.hypot(dx, dy)
      const a = Math.atan2(dy, dx)
      const across = r * Math.sin(off(a)) // px from the nearest spoke's line
      const spoke = Math.round((a - turn) / step + 16) % 8
      let col: string | null = null
      if (r > 12.4 && r <= 15.6 && across < 2.6) {
        // Paddles, standing out past the rim; the old wheel has one split short.
        const split = !mended && spoke === 3 && r > 13.6
        if (!split) col = across > 1.7 || r > 15 ? O : mended ? (r > 13.8 ? NEW.hi : NEW.lt) : r > 13.8 ? W.lt : W.md
      } else if (r > 9.8 && r <= 12.4) {
        // The rim: outlined, with an iron band round the mended one.
        col = r > 11.9 || r <= 10.3 ? O : mended && r > 11.1 ? IRON : W.md
      } else if (r <= 2.6) col = r > 1.7 ? O : IRON
      else if (r <= 9.8) {
        // Spokes over the wheel's dark inside.
        col = across < 1.0 ? (r > 8.2 && mended ? ROPE : W.lt) : across < 1.5 ? W.xd : '#2e2622'
      }
      if (col) px(c, x, y, col)
    }
}

function drawFroth(c: C, frame: number): void {
  for (let x = 0; x < 14; x++)
    for (let y = 0; y < 6; y++) {
      const v = h01(x + frame * 7, y, 21)
      const keep = y >= 3 ? v < 0.55 : y === 2 ? v < 0.3 : v < 0.12
      if (keep) px(c, x, y, v < 0.15 ? '#ffffff' : '#d8eef2')
    }
}

/**
 * Make a mill texture by key when asked (false: not a mill key). Keys:
 * mill-house, mill-hopper, mill-wheel-<0..3>, mill-wheel-mended-<0..3>,
 * mill-froth-<0..1>.
 */
export function ensureMillTexture(scene: Phaser.Scene, key: string): boolean {
  if (scene.textures.exists(key)) return key.startsWith('mill-')
  if (key === 'mill-house') make(scene, key, 64, 64, drawHouse)
  else if (key === 'mill-hopper') make(scene, key, 16, 20, drawHopper)
  else {
    const wheel = /^mill-wheel-(mended-)?([0-3])$/.exec(key)
    const froth = /^mill-froth-([01])$/.exec(key)
    if (wheel) make(scene, key, MILL_WHEEL_SIZE, MILL_WHEEL_SIZE, (c) => drawWheel(c, Number(wheel[2]), !!wheel[1]))
    else if (froth) make(scene, key, 14, 6, (c) => drawFroth(c, Number(froth[1])))
    else return false
  }
  return true
}

/** The texture keys of one wheel's turn, in order. */
export function millWheelKeys(scene: Phaser.Scene, mended: boolean): string[] {
  const keys = Array.from({ length: MILL_WHEEL_FRAMES }, (_, i) => `mill-wheel-${mended ? 'mended-' : ''}${i}`)
  for (const k of keys) ensureMillTexture(scene, k)
  return keys
}
