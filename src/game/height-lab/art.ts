/**
 * Height lab (dev only): its art, drawn in code at start. The surface
 * ground is the Wilds' own painter (../wilds/ground-paint.ts), split into
 * one image a level and shaded by height: drier and paler as land rises,
 * shadow at a cliff's foot, a sunlit lip at its top, a dark line on side
 * drops. Cliff faces, the arches, the cave's floor and rock, and the light
 * and haze overlays are placeholders drawn here, pixel by pixel.
 */
import Phaser from 'phaser'
import { TERRAIN } from '../../lib/tile.ts'
import { wildsGround } from '../../lib/wilds/data.ts'
import { paintGround } from '../wilds/ground-paint.ts'
import { groundTable } from '../wilds/ground-table.ts'
import { wildsLook } from '../wilds/wilds-looks.ts'
import { fnv1a32 } from '../../lib/hash.ts'
import { CAVE, GROUNDS, SURFACE, type LabArea } from './area.ts'
import { DX, DY, KIND, TILE_PX, type Layer } from './levels.ts'
import { caveLevels, sunnyFaceRock } from './light.ts'

type RGB = [number, number, number]

/** One level's ground image: its texture, where it goes (world px), and its level. */
export interface LevelImage {
  key: string
  x: number
  y: number
  level: number
}

const T = TILE_PX

function hash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 1442695041) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t
const hex = (s: string): RGB => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)]

/** The level a surface tile's ground is drawn with (a face or ramp: the land at its foot). */
export function groundLevel(area: LabArea, i: number): number {
  const l = area.stack.layers[SURFACE]!
  const k = l.kind[i]
  if (k === KIND.slope) {
    let lo = Infinity
    for (let d = 0; d < 4; d++) {
      const e = l.edge[i * 4 + d]!
      if (!Number.isNaN(e)) lo = Math.min(lo, e)
    }
    return Math.floor(lo + 0.001)
  }
  if (k === KIND.flat) return Math.round(l.edge[i * 4]!)
  return area.top[i]!
}

/** Canvas texture from RGBA pixels. */
function addPixels(scene: Phaser.Scene, key: string, w: number, h: number, px: Uint8ClampedArray, linear = false): void {
  if (scene.textures.exists(key)) scene.textures.remove(key)
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(w, h)
  img.data.set(px)
  ctx.putImageData(img, 0, 0)
  const tex = scene.textures.addCanvas(key, canvas)!
  if (linear) tex.setFilter(Phaser.Textures.FilterMode.LINEAR)
}

// ---------------------------------------------------------------- surface ground

/**
 * Paint the surface and cut it into level images. The painter is the
 * open map's (chunk by chunk, as the window paints); the shading on top is
 * the height's.
 */
export function paintSurface(scene: Phaser.Scene, area: LabArea): LevelImage[] {
  const l = area.stack.layers[SURFACE]!
  const W = l.w * T
  const H = l.h * T
  const look = wildsLook('outer', 'Carting')
  const terrain = GROUNDS.map((g) => (g.startsWith('cave') ? TERRAIN.dirt : (TERRAIN as Record<string, number>)[wildsGround(g).terrain]!))
  const src = {
    ground: (tx: number, ty: number) => {
      const cx = Math.min(l.w - 1, Math.max(0, tx))
      const cy = Math.min(l.h - 1, Math.max(0, ty))
      return terrain[l.ground[cy * l.w + cx]!]!
    },
    solid: (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < l.w && ty < l.h && l.kind[ty * l.w + tx] === KIND.water
  }
  const px = new Uint8ClampedArray(W * H * 4)
  const CH = 24 * T
  const patch = new Uint8ClampedArray(CH * CH * 4)
  for (let y0 = 0; y0 < H; y0 += CH)
    for (let x0 = 0; x0 < W; x0 += CH) {
      paintGround(patch, x0, y0, CH, CH, src, look.ground, fnv1a32('height-lab'), groundTable())
      for (let y = 0; y < CH; y++) px.set(patch.subarray(y * CH * 4, (y + 1) * CH * 4), ((y0 + y) * W + x0) * 4)
    }
  shadeSurface(area, px, W)
  // Cut by level, each to its bounding box.
  const levels = new Map<number, { x0: number; y0: number; x1: number; y1: number }>()
  const lvl = new Int8Array(l.w * l.h)
  for (let i = 0; i < l.w * l.h; i++) {
    const z = groundLevel(area, i)
    lvl[i] = z
    const tx = i % l.w
    const ty = Math.floor(i / l.w)
    const b = levels.get(z) ?? { x0: tx, y0: ty, x1: tx, y1: ty }
    levels.set(z, { x0: Math.min(b.x0, tx), y0: Math.min(b.y0, ty), x1: Math.max(b.x1, tx), y1: Math.max(b.y1, ty) })
  }
  const out: LevelImage[] = []
  for (const [z, b] of [...levels].sort((a, b) => a[0] - b[0])) {
    const w = (b.x1 - b.x0 + 1) * T
    const h = (b.y1 - b.y0 + 1) * T
    const cut = new Uint8ClampedArray(w * h * 4)
    for (let ty = b.y0; ty <= b.y1; ty++)
      for (let tx = b.x0; tx <= b.x1; tx++) {
        if (lvl[ty * l.w + tx] !== z) continue
        for (let y = 0; y < T; y++) {
          const from = ((ty * T + y) * W + tx * T) * 4
          cut.set(px.subarray(from, from + T * 4), (((ty - b.y0) * T + y) * w + (tx - b.x0) * T) * 4)
        }
      }
    const key = `hl-ground-${z}`
    addPixels(scene, key, w, h, cut)
    out.push({ key, x: b.x0 * T, y: b.y0 * T, level: z })
  }
  return out
}

/** Height's shading on the painted surface (in place). */
function shadeSurface(area: LabArea, px: Uint8ClampedArray, W: number): void {
  const l = area.stack.layers[SURFACE]!
  const topAt = (tx: number, ty: number) => (tx < 0 || ty < 0 || tx >= l.w || ty >= l.h ? 0 : area.top[ty * l.w + tx]!)
  const kindAt = (tx: number, ty: number) => (tx < 0 || ty < 0 || tx >= l.w || ty >= l.h ? KIND.flat : l.kind[ty * l.w + tx]!)
  const tint = (x: number, y: number, c: RGB, t: number) => {
    const i = (y * W + x) * 4
    px[i] = mix(px[i]!, c[0], t)
    px[i + 1] = mix(px[i + 1]!, c[1], t)
    px[i + 2] = mix(px[i + 2]!, c[2], t)
  }
  const shade = (x: number, y: number, k: number) => {
    const i = (y * W + x) * 4
    px[i] = px[i]! * k
    px[i + 1] = px[i + 1]! * k
    px[i + 2] = px[i + 2]! * k
  }
  const dry = hex('#e6d9a8')
  const stone = hex('#a8a296')
  const ink = hex('#1d1a24')
  const dark = hex('#100c14')
  const snow = hex('#eef2f8')
  for (let ty = 0; ty < l.h; ty++)
    for (let tx = 0; tx < l.w; tx++) {
      const i = ty * l.w + tx
      const k = l.kind[i]
      const z = groundLevel(area, i)
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          const wx = tx * T + x
          const wy = ty * T + y
          // Higher land is drier and paler; the shoulder is stony.
          if (z === 1) tint(wx, wy, dry, 0.1)
          if (z >= 2) tint(wx, wy, stone, 0.32)
          if (z >= 4) tint(wx, wy, stone, 0.25)
          // The summit keeps old snow.
          if (z >= 5) tint(wx, wy, snow, 0.5 + hash(wx >> 2, wy >> 2, 21) * 0.2)
          if (k === KIND.mouth) {
            // The arch's dark, a little light spilling in at its foot.
            const m = area.mouths.find((mm) => tx >= mm.x0 && tx <= mm.x1)!
            const depth = (ty - m.arch[0]) * T + y
            const edge = Math.min(tx * T + x - m.x0 * T, (m.x1 + 1) * T - 1 - (tx * T + x))
            tint(wx, wy, dark, edge < 2 ? 0.7 : 0.94 - (depth / (2 * T)) * 0.25)
          }
          if (k === KIND.slope) {
            // Worn steps across a ramp, a retaining wall where a trail's
            // leg runs above another (a shut edge with land lower beyond).
            const vertical = !Number.isNaN(l.edge[i * 4]!) && !Number.isNaN(l.edge[i * 4 + 2]!)
            if (vertical && y % 4 === 0) shade(wx, wy, 0.82)
            if (!vertical && Number.isNaN(l.edge[i * 4 + 2]!) && y >= T - 3) tint(wx, wy, stone, y === T - 1 ? 0.2 : 0.55)
            if (Number.isNaN(l.edge[i * 4 + 2]!) && y === T - 1) shade(wx, wy, 0.6)
            if (Number.isNaN(l.edge[i * 4]!) && y === 0) shade(wx, wy, 0.75)
          }
        }
      if (k === KIND.face || k === KIND.mouth || k === KIND.water) continue
      // Shadow at a face's foot (the face is north of this tile).
      if (kindAt(tx, ty - 1) === KIND.face || kindAt(tx, ty - 1) === KIND.mouth)
        for (let y = 0; y < 7; y++) for (let x = 0; x < T; x++) shade(tx * T + x, ty * T + y, 0.62 + y * 0.055)
      // A sunlit lip where the land drops away south (a face below).
      if (kindAt(tx, ty + 1) === KIND.face || kindAt(tx, ty + 1) === KIND.mouth)
        for (let x = 0; x < T; x++) {
          tint(tx * T + x, ty * T + T - 2, hex('#fff2c4'), 0.35)
          tint(tx * T + x, ty * T + T - 1, hex('#fff2c4'), 0.5)
        }
      // A drop to the north or the sides: a dark rim, shade inside it.
      const here = topAt(tx, ty)
      if (topAt(tx, ty - 1) < here) for (let x = 0; x < T; x++) {
        tint(tx * T + x, ty * T, ink, 0.6)
        tint(tx * T + x, ty * T + 1, hex('#fff2c4'), 0.25)
      }
      for (const [d, x0] of [[1, T - 1], [3, 0]] as const) {
        if (topAt(tx + DX[d], ty) >= here || kindAt(tx + DX[d], ty) === KIND.face) continue
        for (let y = 0; y < T; y++) {
          tint(tx * T + x0, ty * T + y, ink, 0.75)
          tint(tx * T + x0 + (d === 1 ? -1 : 1), ty * T + y, ink, 0.3)
        }
      }
      // Lower land beside a higher side: a cast shadow (the sun from the south-west).
      if (topAt(tx - 1, ty) > here && kindAt(tx - 1, ty) !== KIND.face) for (let y = 0; y < T; y++) for (let x = 0; x < 5; x++) shade(tx * T + x, ty * T + y, 0.7 + x * 0.06)
      if (topAt(tx + 1, ty) > here && kindAt(tx + 1, ty) !== KIND.face) for (let y = 0; y < T; y++) for (let x = 0; x < 3; x++) shade(tx * T + T - 1 - x, ty * T + y, 0.8 + x * 0.06)
    }
}

// ---------------------------------------------------------------- faces

/** Face frames: `face-<part>-<v>[-e|-w]` (part top, mid or bottom of the face; an end on the east or west), and the lintels. */
export const FACES_KEY = 'hl-faces'

export function facePart(row: number, rows: number): 'top' | 'mid' | 'bottom' {
  return row === 0 ? 'top' : row === rows - 1 ? 'bottom' : 'mid'
}

/**
 * Rock face placeholders, 16×16 each, neutral grey so a tint can warm or
 * cool them by level: strata, cracks, a grassy lip on the top row, moss
 * and rubble at the foot. The lintel halves carry the arch's top.
 */
export function drawFaces(scene: Phaser.Scene): void {
  if (scene.textures.exists(FACES_KEY)) return
  const parts = ['top', 'mid', 'bottom'] as const
  const ends = ['', '-e', '-w'] as const
  const names: string[] = []
  for (const p of parts) for (let v = 0; v < 4; v++) for (const e of ends) names.push(`face-${p}-${v}${e}`)
  names.push('lintel-w', 'lintel-e')
  const cols = 12
  const rows = Math.ceil(names.length / cols)
  const W = cols * (T + 2)
  const H = rows * (T + 2)
  const px = new Uint8ClampedArray(W * H * 4)
  const frames: [string, number, number][] = []
  names.forEach((name, n) => {
    const ox = (n % cols) * (T + 2) + 1
    const oy = Math.floor(n / cols) * (T + 2) + 1
    frames.push([name, ox, oy])
    const [, part, vs, end] = /^(?:face-(\w+)-(\d)(-[ew])?|lintel-([ew]))$/.exec(name) ?? []
    const lintel = name.startsWith('lintel')
    const v = lintel ? 0 : Number(vs)
    const rowBase = part === 'top' || lintel ? 0 : part === 'mid' ? 1 : 2
    for (let y = 0; y < T; y++)
      for (let x = 0; x < T; x++) {
        const gy = rowBase * T + y // height down the face
        const r = hash(x + v * 17, gy, 5)
        let c = 168 - gy * 1.3 + (r - 0.5) * 22
        // Strata: a darker line every 6 px, stepping a pixel with x.
        const sy = (gy + (x > 7 + v ? 1 : 0)) % 6
        if (sy === 0) c -= 34
        else if (sy === 1) c += 10
        // A crack or two down the face.
        if (x === 3 + ((v * 5) % 9) && hash(v, gy >> 2, 9) < 0.55) c -= 40
        let rgb: RGB = [c, c * 0.98, c * 0.95]
        let a = 255
        if (part === 'top' && y < 3) rgb = y === 0 ? [92, 140, 60] : y === 1 ? [74, 116, 50] : [c + 26, c + 24, c + 20]
        if (part === 'top' && y === 3 && hash(x, v, 3) < 0.4) rgb = [74, 116, 50]
        if (part === 'bottom' && y > 11) {
          const k = (y - 11) / 5
          rgb = [mix(c, 60, k), mix(c, 74, k), mix(c, 52, k)]
          if (hash(x, y + v, 4) < 0.18) rgb = [72, 104, 52]
        }
        if (end === '-e' && x >= T - 2) rgb = rgb.map((ch) => ch * (x === T - 1 ? 0.45 : 0.7)) as RGB
        if (end === '-w' && x <= 1) rgb = rgb.map((ch) => ch * (x === 0 ? 0.55 : 0.8)) as RGB
        if (lintel) {
          // The arch's top: dark below a curve that meets the far side's.
          const fromMid = name === 'lintel-w' ? T - x : x + 1
          const curve = T - 1 - Math.sqrt(Math.max(0, 1 - Math.pow(fromMid / (T + 1), 2))) * 9
          if (y > curve) rgb = [22, 18, 28]
          else if (y > curve - 2) rgb = rgb.map((ch) => ch * 0.55) as RGB
        }
        const i = ((oy + y) * W + ox + x) * 4
        px[i] = rgb[0]
        px[i + 1] = rgb[1]
        px[i + 2] = rgb[2]
        px[i + 3] = a
        a = 255
      }
  })
  addPixels(scene, FACES_KEY, W, H, px)
  const tex = scene.textures.get(FACES_KEY)
  for (const [name, x, y] of frames) tex.add(name, 0, x, y, T, T)
}

/** Tints for faces by the level they rise to: warm sandstone, then cool mountain rock, then pale high stone. */
export const FACE_TINT: Record<number, number> = { 1: 0xf0dcc0, 2: 0xc4c8d2, 3: 0xb0b4c0, 4: 0xa8acb8, 5: 0xd8dce6 }

// ---------------------------------------------------------------- the cave

/**
 * The cave layer's ground: a stone floor (a little cooler on deeper
 * floors), rock round it with a face where it stands over the floor, drops
 * between floors, still black water. Cut into one image a floor level, like
 * the surface, so a level can fade with its depth. Painted as it looks in
 * full light: the light (./lighting.ts) darkens it. Rock that lies over a
 * sunny cliff face (round an arch) isn't painted: you see the face.
 */
/** The cave's colours in full light (they were painted dark for the old dimmer). */
const ALBEDO = 1.45

export function paintCave(scene: Phaser.Scene, area: LabArea): LevelImage[] {
  const l = area.stack.layers[CAVE]!
  let x0 = l.w
  let y0 = l.h
  let x1 = 0
  let y1 = 0
  for (let i = 0; i < l.w * l.h; i++) {
    if (l.kind[i] === KIND.none) continue
    const tx = i % l.w
    const ty = Math.floor(i / l.w)
    x0 = Math.min(x0, tx)
    y0 = Math.min(y0, ty)
    x1 = Math.max(x1, tx)
    y1 = Math.max(y1, ty)
  }
  const w = (x1 - x0 + 1) * T
  const h = (y1 - y0 + 1) * T
  const px = new Uint8ClampedArray(w * h * 4)
  const lvl = caveLevels(l)
  const kindAt = (tx: number, ty: number) => (tx < 0 || ty < 0 || tx >= l.w || ty >= l.h ? KIND.none : l.kind[ty * l.w + tx]!)
  const floorish = (k: number) => k === KIND.flat || k === KIND.slope
  // Rock's distance from the floor (tiles), for its fade at the edge of what's drawn.
  const reach = (tx: number, ty: number) => {
    for (let r = 1; r <= 3; r++)
      for (let y = ty - r; y <= ty + r; y++) for (let x = tx - r; x <= tx + r; x++) if (floorish(kindAt(x, y)) || kindAt(x, y) === KIND.water || kindAt(x, y) === KIND.face) return r
    return 4
  }
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      const i = ty * l.w + tx
      const k = l.kind[i]
      if (k === KIND.none || sunnyFaceRock(area.stack, area.air, i)) continue
      const faceBelow = k === KIND.rock && floorish(kindAt(tx, ty + 1))
      const fade = k === KIND.rock ? [255, 255, 255, 150, 0][reach(tx, ty)]! : 255
      // Deeper floors are a little darker and cooler.
      const deep = Math.max(0, -lvl[i]! - 1) * 0.07
      for (let y = 0; y < T; y++)
        for (let x = 0; x < T; x++) {
          const wx = tx * T + x
          const wy = ty * T + y
          let rgb: RGB
          if (floorish(k)) {
            // Flagged stone: cells of 5 px with dark joints, faint noise.
            const cx = Math.floor((wx + (Math.floor(wy / 5) % 2) * 2) / 5)
            const cy = Math.floor(wy / 5)
            const joint = (wx + (Math.floor(wy / 5) % 2) * 2) % 5 === 0 || wy % 5 === 0
            const base = 66 + hash(cx, cy, 11) * 20 + (hash(wx, wy, 12) - 0.5) * 8
            const c = joint ? base * 0.7 : base
            rgb = [c * 0.92, c * 0.9, c * 1.05]
            if (k === KIND.slope && wy % 4 === 0) rgb = rgb.map((ch) => ch * 0.85) as RGB
            // Shadow at the foot of a rock wall or a drop above.
            const n = kindAt(tx, ty - 1)
            if ((n === KIND.rock || n === KIND.face) && y < 5) rgb = rgb.map((ch) => ch * (0.55 + y * 0.09)) as RGB
            // A pale lip where the floor drops away south.
            if (kindAt(tx, ty + 1) === KIND.face && y >= T - 2) rgb = rgb.map((ch) => ch * (y === T - 1 ? 1.35 : 1.15)) as RGB
          } else if (k === KIND.water) {
            const glint = hash(wx >> 1, wy, 13) < 0.02
            rgb = glint ? [90, 120, 150] : [16 + (wy % 3), 26, 40]
          } else if (k === KIND.face) {
            // A drop between floors: banded rock, darker toward its foot.
            const gy = l.faceRow[i]! * T + y
            const down = gy / Math.max(1, l.faceRows[i]! * T)
            const c = 74 - down * 30 + (hash(wx, wy, 17) - 0.5) * 12 - ((gy + (x > 8 ? 1 : 0)) % 6 === 0 ? 16 : 0)
            rgb = [c * 0.96, c * 0.9, c * 1.06]
          } else if (faceBelow) {
            // The rock's face over the floor: strata, lighter toward the foot.
            const c = 40 + y * 2.2 + (hash(wx, wy, 14) - 0.5) * 12 - ((wy + (x > 8 ? 1 : 0)) % 5 === 0 ? 14 : 0)
            rgb = [c * 0.95, c * 0.9, c * 1.08]
          } else {
            const c = 26 + hash(wx >> 2, wy >> 2, 15) * 10 + (hash(wx, wy, 16) - 0.5) * 6
            rgb = [c, c * 0.92, c * 1.1]
          }
          if (k !== KIND.water) rgb = rgb.map((ch) => ch * ALBEDO) as RGB
          if (deep) rgb = [rgb[0] * (1 - deep), rgb[1] * (1 - deep * 0.8), rgb[2] * (1 - deep * 0.4)]
          const o = (((ty - y0) * T + y) * w + (tx - x0) * T + x) * 4
          px[o] = rgb[0]
          px[o + 1] = rgb[1]
          px[o + 2] = rgb[2]
          px[o + 3] = fade
        }
    }
  // Cut by level, each to its bounding box.
  const boxes = new Map<number, { x0: number; y0: number; x1: number; y1: number }>()
  for (let ty = y0; ty <= y1; ty++)
    for (let tx = x0; tx <= x1; tx++) {
      const i = ty * l.w + tx
      if (l.kind[i] === KIND.none) continue
      const z = lvl[i]!
      const b = boxes.get(z) ?? { x0: tx, y0: ty, x1: tx, y1: ty }
      boxes.set(z, { x0: Math.min(b.x0, tx), y0: Math.min(b.y0, ty), x1: Math.max(b.x1, tx), y1: Math.max(b.y1, ty) })
    }
  const out: LevelImage[] = []
  for (const [z, b] of [...boxes].sort((a, c) => a[0] - c[0])) {
    const cw = (b.x1 - b.x0 + 1) * T
    const ch = (b.y1 - b.y0 + 1) * T
    const cut = new Uint8ClampedArray(cw * ch * 4)
    for (let ty = b.y0; ty <= b.y1; ty++)
      for (let tx = b.x0; tx <= b.x1; tx++) {
        const i = ty * l.w + tx
        if (l.kind[i] === KIND.none || lvl[i] !== z) continue
        for (let y = 0; y < T; y++) {
          const from = (((ty - y0) * T + y) * w + (tx - x0) * T) * 4
          cut.set(px.subarray(from, from + T * 4), (((ty - b.y0) * T + y) * cw + (tx - b.x0) * T) * 4)
        }
      }
    const key = `hl-cave-${z}`
    addPixels(scene, key, cw, ch, cut)
    out.push({ key, x: b.x0 * T, y: b.y0 * T, level: z })
  }
  return out
}

// ---------------------------------------------------------------- overlays

/** The overlays and sprites (the haze, the crystal, …): drawn once. */
export function drawOverlays(scene: Phaser.Scene): void {
  if (scene.textures.exists('hl-haze')) return
  const radial = (key: string, size: number, alphaAt: (r: number) => number, rgb: RGB) => {
    const px = new Uint8ClampedArray(size * size * 4)
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2)
        const i = (y * size + x) * 4
        px[i] = rgb[0]
        px[i + 1] = rgb[1]
        px[i + 2] = rgb[2]
        px[i + 3] = Math.round(255 * Math.max(0, Math.min(1, alphaAt(r))))
      }
    addPixels(scene, key, size, size, px, true)
  }
  const smooth = (t: number) => t * t * (3 - 2 * t)
  radial('hl-haze', 256, (r) => smooth(Math.max(0, Math.min(1, (r - 55) / 90))), [255, 255, 255])
  // A crystal: a little pale shard cluster.
  const cw = 9
  const chh = 11
  const cp = new Uint8ClampedArray(cw * chh * 4)
  const shard = (cx: number, top: number, hgt: number) => {
    for (let y = top; y < chh; y++) {
      const half = Math.max(0, Math.round(((y - top) / hgt) * 1.6))
      for (let x = cx - half; x <= cx + half; x++) {
        if (x < 0 || x >= cw) continue
        const i = (y * cw + x) * 4
        const lit = x <= cx
        cp[i] = lit ? 230 : 150
        cp[i + 1] = lit ? 246 : 190
        cp[i + 2] = 255
        cp[i + 3] = 255
      }
    }
  }
  shard(4, 0, 6)
  shard(1, 4, 4)
  shard(7, 3, 5)
  addPixels(scene, 'hl-crystal', cw, chh, cp)
}

/** The level overlay (`grid`): a tint per level, slopes green, faces red, the cave violet. */
export function drawGrid(g: Phaser.GameObjects.Graphics, l: Layer, area: LabArea): void {
  const colors = [0x3050ff, 0xffb030, 0xff4060, 0x40e0ff, 0xffffff]
  const caveColors = [0xd0a0ff, 0xa060ff, 0x7040e0, 0x4020b0, 0x200880]
  const lvl = l.name === 'cave' ? caveLevels(l) : null
  for (let ty = 0; ty < l.h; ty++)
    for (let tx = 0; tx < l.w; tx++) {
      const i = ty * l.w + tx
      const k = l.kind[i]
      if (k === KIND.none) continue
      let c = 0
      let a = 0.18
      if (lvl) c = k === KIND.rock ? 0x301040 : k === KIND.face ? 0xff2020 : caveColors[Math.min(4, Math.max(0, -lvl[i]!))]!
      else if (k === KIND.slope) c = 0x40ff60
      else if (k === KIND.face || k === KIND.mouth) c = 0xff2020
      else {
        const z = area.top[i]!
        if (z === 0) a = 0
        c = colors[Math.min(4, Math.max(0, z - 1))]!
      }
      if (a) {
        g.fillStyle(c, a)
        g.fillRect(tx * T, ty * T, T, T)
      }
      // Shut edges between open tiles: a thin line.
      g.lineStyle(1, 0x000000, 0.35)
      for (const d of [1, 2] as const) {
        const nx = tx + DX[d]
        const ny = ty + DY[d]
        if (nx >= l.w || ny >= l.h) continue
        const a1 = l.edge[i * 4 + d]!
        const b1 = l.edge[(ny * l.w + nx) * 4 + ((d + 2) & 3)]!
        const open = !Number.isNaN(a1) && !Number.isNaN(b1) && Math.abs(a1 - b1) < 0.01
        const any = !Number.isNaN(a1) || !Number.isNaN(b1)
        if (open || !any) continue
        if (d === 1) g.lineBetween(nx * T, ty * T, nx * T, ty * T + T)
        else g.lineBetween(tx * T, ny * T, tx * T + T, ny * T)
      }
    }
}
