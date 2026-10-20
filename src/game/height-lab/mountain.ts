/**
 * Height lab (dev only): the second area, 4×4 chunks (96×96 tiles): a
 * mountain range five levels above the valley, a trail that winds to its
 * summit, a saddle to the far side, and a deep cave under it. Pure data,
 * built the way ./area.ts builds the first area (heights, derived faces,
 * then carving), with one addition: the cave's floors have levels too, and
 * its drops are derived from a cave height map the same way.
 *
 * The map (north up; screen-space tiles, so a level is 3 rows of face):
 *
 *   rows  0–11  the far side: a high meadow, level 1.
 *   rows 12–21  the range's north flank, level 2.
 *   rows 22–50  level 3; the saddle (cols 59–71) runs north through it
 *               between two level-4 masses; two ramps take it down north
 *               to the flank and the meadow.
 *   rows 24–40  the masses, level 4: west (cols 0–58) and east (72–95).
 *   rows 25–30  the summit, level 5 (cols 30–46), faces in front.
 *   rows 51–53, 41–43, 31–33, 61–63, 71–73: the faces (each one level, so
 *               3 rows), from the valley up: ramp (cols 20–22), then
 *               switchbacks at cols 26–34, 44–52, 24–32 and 36–44.
 *   rows 74–95  the valley, level 0, with the cave's two mouths in the
 *               first face (cols 56–57 in, 40–41 out).
 *
 *   The deep cave (one cave layer; its floors at levels 0 to -4): from the
 *   east mouth a tunnel runs north and down to -1, bends east, slopes down
 *   to -2 and runs north under the saddle; a branch east slopes to -3 and
 *   ends in a pocket. The main way turns west along a ledge (-2) that
 *   overlooks the cavern (-4) two levels below; at the ledge's west end a
 *   long ramp goes down into the cavern. From the cavern's south side a
 *   tunnel climbs four levels to the west mouth.
 */
import { CAVE, KIND, N, S, SURFACE, W, newLayer, setClosed, type Layer, type Node, type Stack } from './levels.ts'
import {
  G,
  caveRock,
  deriveFaces,
  ellipse,
  hash,
  idx,
  lightArea,
  pathLine,
  portal,
  ramp,
  rect,
  trail,
  type AreaOptions,
  type LabArea,
  type Mouth,
  type PropSpot
} from './area.ts'
import { caveLevels, type Glow } from './light.ts'

export const MOUNTAIN_W = 96
export const MOUNTAIN_H = 96

/** The cave's way down, for the tests: where each leg of it lies. */
export const DEEP = {
  mouthIn: { x0: 56, x1: 57 },
  mouthOut: { x0: 40, x1: 41 },
  /** A tile on each leg of the way down, in order, with its floor level. */
  legs: [
    { tx: 56, ty: 69, z: 0 },
    { tx: 62, ty: 58, z: -1 },
    { tx: 75, ty: 45, z: -2 },
    { tx: 50, ty: 29, z: -2 },
    { tx: 42, ty: 44, z: -4 }
  ],
  /** The dead end's pocket. */
  pocket: { tx: 90, ty: 52, z: -3 },
  /** The ledge over the cavern, and a cavern tile straight below it (south, past the drop). */
  ledge: { tx: 44, ty: 31 },
  below: { tx: 44, ty: 38 }
} as const

/** A switchback across a 3-row face: legs side by side, joined only at their turns. From (x0, foot) east (dir 1) or west (dir -1). */
function switchback(x0: number, foot: number, len: number, dir: 1 | -1): [number, number][] {
  const p: [number, number][] = [[x0, foot]]
  for (let i = 0; i <= len; i++) p.push([x0 + dir * i, foot - 1])
  for (let i = len; i >= 0; i--) p.push([x0 + dir * i, foot - 2])
  for (let i = 0; i <= len - 2; i++) p.push([x0 + dir * i, foot - 3])
  p.push([x0 + dir * (len - 2), foot - 4])
  return p
}

export function buildMountain(opts: AreaOptions): LabArea {
  const w = MOUNTAIN_W
  const h = MOUNTAIN_H
  const surface = newLayer('surface', w, h)
  const cave = newLayer('cave', w, h)
  const stack: Stack = { w, h, layers: [surface, cave], portals: new Map() }

  // 1. Heights and grounds.
  const top = new Int8Array(w * h)
  const setTop = (z: number, g: number) => (tx: number, ty: number) => {
    top[idx(surface, tx, ty)] = z
    surface.ground[idx(surface, tx, ty)] = g
  }
  rect(setTop(0, G.meadow), 0, 0, w - 1, h - 1)
  rect(setTop(1, G.moss), 0, 0, w - 1, 70)
  rect(setTop(2, G.moss), 0, 12, w - 1, 60)
  rect(setTop(3, G.trodden), 0, 22, w - 1, 50)
  rect(setTop(4, G.trodden), 0, 24, 58, 40)
  rect(setTop(4, G.trodden), 72, 24, w - 1, 40)
  rect(setTop(5, G.trodden), 30, 25, 46, 30)
  // The far meadow is a meadow again.
  rect(setTop(1, G.meadow), 0, 0, w - 1, 11)
  deriveFaces(surface, top)

  // A tarn in the valley, sand round it.
  ellipse((tx, ty) => (surface.ground[idx(surface, tx, ty)] = G.bank), 76, 84, 7, 4.5)
  ellipse((tx, ty) => {
    setClosed(surface, tx, ty, KIND.water)
    surface.ground[idx(surface, tx, ty)] = G.water
  }, 76, 84, 5.5, 3.2)

  // 2. Carved: the way up. A ramp, then four switchbacks, each the other way.
  ramp(surface, 20, 71, 22, 73, N, 0, 1, G.trodden)
  const legs: [number, number][][] = [switchback(26, 64, 8, 1), switchback(44, 54, 8, 1), switchback(32, 44, 8, -1), switchback(36, 34, 8, 1)]
  legs.forEach((p, i) => trail(surface, p, i + 1, i + 2, G.path))
  // The saddle's way down the far side: two ramps north.
  ramp(surface, 64, 19, 66, 21, S, 2, 3, G.trodden)
  ramp(surface, 64, 12, 66, 14, S, 1, 2, G.trodden)

  pathLine(surface, [[30, 82], [30, 76], [21, 76], [21, 74]])
  pathLine(surface, [[21, 70], [21, 66], [26, 66], [26, 64]])
  pathLine(surface, [[30, 82], [56, 82], [56, 74]])
  pathLine(surface, [[40, 82], [40, 74]])
  pathLine(surface, [[32, 60], [32, 57], [44, 57], [44, 54]])
  pathLine(surface, [[50, 50], [50, 47], [32, 47], [32, 44]])
  pathLine(surface, [[50, 47], [65, 47], [65, 22]])
  pathLine(surface, [[26, 40], [26, 36], [36, 36], [36, 34]])
  pathLine(surface, [[65, 18], [65, 15]])
  pathLine(surface, [[65, 11], [65, 6], [50, 6]])

  // Cave mouths in the first face (rows 71–73).
  const mouths: Mouth[] = [
    { x0: DEEP.mouthIn.x0, x1: DEEP.mouthIn.x1, lintel: 71, arch: [72, 73] },
    { x0: DEEP.mouthOut.x0, x1: DEEP.mouthOut.x1, lintel: 71, arch: [72, 73] }
  ]
  for (const m of mouths) for (let tx = m.x0; tx <= m.x1; tx++) for (const ty of m.arch) setClosed(surface, tx, ty, KIND.mouth)

  // 3. The deep cave: a height map and a mask of its floor, faces derived
  // from them (the drop from the ledge into the cavern), then its ramps.
  const caveTop = new Int8Array(w * h)
  const mask = new Uint8Array(w * h)
  // The way in from the east mouth is cut stone (stairs on its ramp);
  // from the bend east on, and the west mouth's way, it's rough rock.
  const cut = G['cave-floor']
  const rough = G['cave-rough']
  const dig = (z: number, ground: number = rough) => (tx: number, ty: number) => {
    const i = idx(cave, tx, ty)
    caveTop[i] = z
    mask[i] = 1
    cave.ground[i] = ground
  }
  // In from the east mouth, down to -1, east and down to -2.
  rect(dig(0, cut), 56, 67, 57, 73)
  rect(dig(-1, cut), 56, 62, 57, 66) // ramp A (carved below)
  rect(dig(-1, cut), 56, 58, 57, 61)
  rect(dig(-1, cut), 58, 58, 68, 59)
  rect(dig(-2), 69, 58, 74, 59) // ramp B
  // North under the saddle at -2; the dead-end branch east and down to -3.
  rect(dig(-2), 75, 28, 76, 59)
  rect(dig(-2), 77, 52, 84, 53)
  rect(dig(-3), 85, 52, 88, 53) // ramp C
  ellipse(dig(-3), 90.5, 52, 2.6, 3.4)
  // The ledge west at -2, and the cavern at -4 below it: the rows between
  // the ledge and the cavern's floor become its drop.
  rect(dig(-2), 26, 28, 74, 31)
  rect(dig(-4), 30, 32, 54, 37)
  ellipse(dig(-4), 42, 44, 13, 7)
  rect(dig(-4), 26, 44, 30, 46)
  rect(dig(-4), 26, 32, 27, 43) // ramp D
  // Out: a tunnel from the cavern's south side climbing to the west mouth.
  rect(dig(-4), 40, 51, 41, 64) // ramp E
  rect(dig(0), 40, 65, 41, 73)
  deriveFaces(cave, caveTop, mask)
  ramp(cave, 56, 62, 57, 66, S, -1, 0, cut)
  ramp(cave, 69, 58, 74, 59, W, -2, -1, rough)
  ramp(cave, 85, 52, 88, 53, W, -3, -2, rough)
  ramp(cave, 26, 32, 27, 43, N, -4, -2, rough)
  ramp(cave, 40, 51, 41, 64, S, -4, 0, rough)
  // Pillars and a still pool in the cavern.
  for (const [tx, ty] of [[35, 41], [36, 41], [35, 42], [50, 42], [51, 42], [47, 49], [33, 46]] as const) {
    setClosed(cave, tx, ty, KIND.rock)
    cave.ground[idx(cave, tx, ty)] = G['cave-rock']
  }
  ellipse((tx, ty) => {
    setClosed(cave, tx, ty, KIND.water)
    cave.ground[idx(cave, tx, ty)] = G.water
  }, 46, 46.5, 3, 1.6)
  for (const m of mouths) for (let tx = m.x0; tx <= m.x1; tx++) portal(stack, SURFACE, tx, 74, N, CAVE)

  caveRock(stack, top)

  // Props: woods in the valley and on the far meadow, pines on the low
  // terraces, boulders higher, nothing on the summit but its cairn.
  const props: PropSpot[] = []
  const clear = new Set<number>()
  const keepClear = (cx: number, cy: number, r: number) => rect((tx, ty) => clear.add(idx(surface, tx, ty)), cx - r, cy - r, cx + r, cy + r)
  for (const p of legs) {
    keepClear(p[0]![0], p[0]![1], 1)
    keepClear(p.at(-1)![0], p.at(-1)![1], 1)
  }
  keepClear(30, 80, 3)
  keepClear(21, 74, 2)
  keepClear(21, 70, 2)
  keepClear(56, 75, 2)
  keepClear(40, 75, 2)
  keepClear(65, 22, 2)
  keepClear(65, 18, 2)
  keepClear(65, 11, 2)
  keepClear(65, 15, 1)
  const place = (p: PropSpot) => {
    const i = idx(surface, p.tx, p.ty)
    if (clear.has(i) || surface.kind[i] !== KIND.flat || surface.ground[i] === G.path || surface.ground[i] === G.bank) return
    for (let d = 0; d < 4; d++) {
      const x = Math.min(w - 1, Math.max(0, p.tx + [0, 1, 0, -1][d]!))
      const y = Math.min(h - 1, Math.max(0, p.ty + [-1, 0, 1, 0][d]!))
      if (surface.kind[idx(surface, x, y)] !== KIND.flat) return
    }
    if (p.blocks) setClosed(surface, p.tx, p.ty, KIND.prop)
    props.push(p)
  }
  for (let ty = 1; ty < h - 1; ty++)
    for (let tx = 1; tx < w - 1; tx++) {
      const r = hash(tx, ty, 31)
      const z = top[idx(surface, tx, ty)]!
      const v = Math.floor(hash(tx, ty, 32) * 8)
      const edge = Math.min(tx, w - 1 - tx, h - 1 - ty)
      if (z === 0) {
        const dense = edge < 5 || (tx > 62 && ty > 88)
        if (r < (dense ? 0.16 : 0.03)) place({ kind: hash(tx, ty, 33) < 0.6 ? 'oak' : hash(tx, ty, 34) < 0.5 ? 'pine' : 'birch', tx, ty, variant: v, blocks: true })
        else if (r > 0.975) place({ kind: 'fern', tx, ty, variant: v, blocks: false })
      } else if (z === 1) {
        if (r < (ty < 12 ? 0.07 : 0.04)) place({ kind: hash(tx, ty, 33) < 0.75 ? 'pine' : 'birch', tx, ty, variant: v, blocks: true })
        else if (r > 0.97) place({ kind: 'fern', tx, ty, variant: v, blocks: false })
      } else if (z === 2) {
        if (r < 0.035) place({ kind: hash(tx, ty, 33) < 0.6 ? 'pine' : 'boulder', tx, ty, variant: v, blocks: true })
      } else if (z <= 4 && r < 0.025) place({ kind: 'boulder', tx, ty, variant: v, blocks: true })
    }
  place({ kind: 'cairn', tx: 38, ty: 26, variant: 1, blocks: true })
  place({ kind: 'standing-stone', tx: 63, ty: 24, variant: 2, blocks: true })
  place({ kind: 'cairn', tx: 66, ty: 9, variant: 3, blocks: true })

  // Crystals: lights along the way down, in the pocket, over the cavern.
  const lv = caveLevels(cave)
  const glow = (tx: number, ty: number, color: number): Glow => ({ tx, ty, z: lv[idx(cave, tx, ty)]!, color })
  const glows: Glow[] = [
    glow(60, 59, 0x7fd8ff),
    glow(76, 42, 0xb48cff),
    glow(91, 51, 0x7fffc8),
    glow(60, 28, 0x7fd8ff),
    glow(36, 39, 0x7fd8ff),
    glow(49, 45, 0xb48cff),
    glow(42, 49, 0x7fffc8),
    glow(30, 45, 0x7fd8ff),
    glow(41, 57, 0xb48cff)
  ]

  const spawn: Node = { layer: SURFACE, tx: 30, ty: 80 }
  const route: Node[] = [
    { layer: SURFACE, tx: 30, ty: 80 },
    { layer: SURFACE, tx: 24, ty: 67 },
    { layer: SURFACE, tx: 33, ty: 57 },
    { layer: SURFACE, tx: 48, ty: 47 },
    { layer: SURFACE, tx: 28, ty: 37 },
    { layer: SURFACE, tx: 38, ty: 28 },
    { layer: SURFACE, tx: 64, ty: 46 },
    { layer: SURFACE, tx: 65, ty: 24 },
    { layer: SURFACE, tx: 58, ty: 6 },
    { layer: SURFACE, tx: 64, ty: 46 },
    { layer: SURFACE, tx: 56, ty: 77 },
    { layer: CAVE, tx: DEEP.pocket.tx, ty: DEEP.pocket.ty },
    { layer: CAVE, tx: 44, ty: 30 },
    { layer: CAVE, tx: 42, ty: 44 },
    { layer: SURFACE, tx: 40, ty: 78 }
  ]
  return lightArea(
    {
      name: 'mountain',
      stack,
      top,
      props,
      mouths,
      glows,
      spawn,
      route,
      homes: [
        { layer: SURFACE, tx: 40, ty: 6, art: 'slime' },
        { layer: CAVE, tx: 38, ty: 45, art: 'mushroom' },
        { layer: CAVE, tx: 90, ty: 53, art: 'mushroom' }
      ]
    },
    opts
  )
}

/** A text map of a layer, a character a tile (for reading the area in a terminal; tests print it on failure). */
export function asciiLayer(l: Layer, top: Int8Array | null): string {
  const lines: string[] = []
  for (let ty = 0; ty < l.h; ty++) {
    let s = ''
    for (let tx = 0; tx < l.w; tx++) {
      const i = ty * l.w + tx
      const k = l.kind[i]
      if (k === KIND.none) s += ' '
      else if (k === KIND.face) s += '#'
      else if (k === KIND.mouth) s += 'M'
      else if (k === KIND.slope) s += '/'
      else if (k === KIND.water) s += '~'
      else if (k === KIND.rock) s += '%'
      else if (k === KIND.prop) s += 't'
      else {
        const z = top ? top[i]! : Math.round(l.edge[i * 4]!)
        s += z < 0 ? String.fromCharCode(96 - z) : String(z)
      }
    }
    lines.push(s)
  }
  return lines.join('\n')
}
