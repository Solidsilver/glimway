/**
 * Height lab (dev only): the hand-made test area, 3×3 chunks (72×72
 * tiles) of levels built the way a generator could build them. Pure data.
 *
 * Authoring is in two steps, as a generated chunk would be:
 *  1. a top-height map (what you'd stand on, in whole levels) and grounds;
 *     faces are then derived: wherever land drops to the south, the face
 *     takes ROWS_PER_LEVEL rows a level off the lower land in front of it.
 *  2. carved features: ramps and trails (tiles whose edges climb), cave
 *     mouths in faces, and the cave layer (tunnels, a chamber) with its
 *     portals.
 *
 * The map (north up; levels 0 valley, 1 plateau, 2 shoulder):
 *
 *   rows  3–21  the mountain shoulder (cols 36–59), level 2, its east side a
 *               two-level drop straight to the valley: the lookout.
 *   rows 22–24  the shoulder's face, with the switchback (cols 40–46) and the
 *               second cave mouth (cols 52–53).
 *   rows  6–36  the plateau (cols 12–59), level 1; it steps back to row 33
 *               east of col 45.
 *   rows 37–39  the plateau's face: the ramp (cols 16–18) and the first cave
 *               mouth (cols 30–31).
 *   below       the valley floor, a pond to the south-west.
 *
 *   The cave: a tunnel from the first mouth runs north and down under the
 *   plateau into a chamber (level -1, rows 17–31, under the plateau and the
 *   shoulder's edge); a second tunnel climbs east under the shoulder and
 *   comes out of the second mouth onto the plateau.
 */
import {
  CAVE,
  DX,
  DY,
  E,
  KIND,
  N,
  ROWS_PER_LEVEL,
  S,
  SURFACE,
  TILE_PX,
  W,
  findPath,
  newLayer,
  portalKey,
  setClosed,
  setFlat,
  walkable,
  type Dir,
  type Layer,
  type Node,
  type Stack
} from './levels.ts'
import { DAYLIGHT, LIGHT_RES, caveAmbient, caveCover, caveLevels, caveStops, crystalLight, daylight, openAir, sunnyFaceRock, type Glow } from './light.ts'
import { Lighting } from './lighting.ts'

export { CAVE, SURFACE }

export const LAB_W = 72
export const LAB_H = 72

/** Ground palette: indexes into this are a layer's `ground`. Content ground ids, plus the cave's own (its floor cut stone or rough rock: ./art.ts paintCave). */
export const GROUNDS = ['meadow', 'moss', 'trodden', 'path', 'water', 'bank', 'woods', 'cave-floor', 'cave-rock', 'cave-rough'] as const
export type GroundId = (typeof GROUNDS)[number]
export const G = Object.fromEntries(GROUNDS.map((g, i) => [g, i])) as Record<GroundId, number>


export interface PropSpot {
  kind: 'oak' | 'pine' | 'birch' | 'boulder' | 'fern' | 'cairn' | 'standing-stone' | 'thicket'
  tx: number
  ty: number
  variant: number
  /** Walks are shut on its tile (ferns aren't). */
  blocks: boolean
}

export interface Mouth {
  /** Columns of the opening, the face's rows (lintel first), and the cave layer tiles just inside. */
  x0: number
  x1: number
  lintel: number
  arch: [number, number]
}

/** The lab's areas: the first round's valley, plateau and shoulder; the mountain with its saddle and deep cave (./mountain.ts). */
export type AreaName = 'shoulder' | 'mountain'

export interface AreaOptions {
  /** Walked tiles from a mouth to where daylight is gone. */
  skyTiles: number
}

export interface LabArea {
  name: AreaName
  stack: Stack
  /** Surface top height per tile (levels) before carving: what stands above a cave. */
  top: Int8Array
  props: PropSpot[]
  mouths: Mouth[]
  /** Crystals in the cave (tile middles; z: the floor's level): lights. */
  glows: Glow[]
  spawn: Node
  /** The remote player's loop (BFS walks between these). */
  route: Node[]
  /** Creature homes. */
  homes: { layer: number; tx: number; ty: number; art: 'slime' | 'mushroom' }[]
  /** The cave's walked distance from the nearest mouth, per tile (./light.ts daylight). */
  walk: Float32Array
  /** The cave layer's ambient light per tile (r, g, b), what stops light, and floor levels (./light.ts). */
  ambient: Float32Array
  /** Open air per tile, 0–1: the land seen out of the mouths (./light.ts openAir). */
  air: Float32Array
  stops: Uint8Array
  /** The cave's floor level per tile, smooth along ramps (./light.ts caveLevels). */
  levels: Float32Array
  /** The mouths' arch tiles (1): where the cave's floor shows from outside, in the cave's light. */
  arches: Uint8Array
  /** How much the cave's image covers, per light texel (./light.ts caveCover). */
  cover: Float32Array
}

/** An area as authored: everything but what's worked out from it (light). */
export type AreaPlan = Omit<LabArea, 'walk' | 'ambient' | 'air' | 'stops' | 'levels' | 'arches' | 'cover'>

/** Work out an authored area's light: daylight from its mouths, open air, what stops light. */
export function lightArea(plan: AreaPlan, opts: AreaOptions): LabArea {
  const walk = daylight(plan.stack, opts.skyTiles)
  const cave = plan.stack.layers[CAVE]!
  const air = openAir(plan.stack, plan.top)
  const arches = new Uint8Array(plan.stack.w * plan.stack.h)
  for (const m of plan.mouths) for (let tx = m.x0; tx <= m.x1; tx++) for (const ty of m.arch) arches[ty * plan.stack.w + tx] = 1
  return { ...plan, walk, ambient: caveAmbient(plan.stack, air), air, stops: caveStops(cave), levels: caveLevels(cave), arches, cover: caveCover(plan.stack, air, TILE_PX, LIGHT_RES) }
}

/** Where depth darkens the cave (1): its own floor, drops, water and rock, not the open air or the sunny face round an arch. */
export function caveMaterial(area: LabArea): Uint8Array {
  const cave = area.stack.layers[CAVE]!
  const out = new Uint8Array(area.stack.w * area.stack.h)
  for (let i = 0; i < out.length; i++) out[i] = cave.kind[i] !== KIND.none && !sunnyFaceRock(area.stack, area.air, i) ? 1 : 0
  return out
}

/** The area's lighting (./lighting.ts): daylight on the surface; the cave's ambient, rock and crystals below. */
export function areaLighting(area: LabArea): Lighting {
  const { w, h } = area.stack
  const lights = new Lighting({ w, h, tile: TILE_PX, res: LIGHT_RES, layers: 2 })
  const day = new Float32Array(w * h * 3)
  for (let i = 0; i < w * h; i++) day.set(DAYLIGHT, i * 3)
  lights.setAmbient(SURFACE, day)
  lights.setAmbient(CAVE, area.ambient)
  lights.setOccluders(CAVE, area.stops)
  lights.setLevels(CAVE, area.levels, caveMaterial(area))
  lights.setCover(CAVE, area.cover)
  area.glows.forEach((g, i) => lights.add(crystalLight(g, i, TILE_PX)))
  return lights
}

/** Walked tiles from a mouth to where daylight is gone, unless switched. */
export const SKY_TILES = 6

export const DEFAULT_AREA_OPTIONS: AreaOptions = { skyTiles: SKY_TILES }

// ---------------------------------------------------------------- helpers

export const idx = (l: { w: number }, tx: number, ty: number) => ty * l.w + tx

export function rect(fn: (tx: number, ty: number) => void, x0: number, y0: number, x1: number, y1: number): void {
  for (let ty = y0; ty <= y1; ty++) for (let tx = x0; tx <= x1; tx++) fn(tx, ty)
}

export function ellipse(fn: (tx: number, ty: number) => void, cx: number, cy: number, rx: number, ry: number): void {
  for (let ty = Math.floor(cy - ry); ty <= Math.ceil(cy + ry); ty++)
    for (let tx = Math.floor(cx - rx); tx <= Math.ceil(cx + rx); tx++) {
      const u = (tx - cx) / rx
      const v = (ty - cy) / ry
      if (u * u + v * v <= 1) fn(tx, ty)
    }
}

/** Small integer hash, for scattering. */
export function hash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/**
 * Faces from a top-height map: where land drops to the south by k levels,
 * the k × ROWS_PER_LEVEL tiles in front of it (on the lower land) are face.
 * Everything else is flat at its height. With a mask (a cave's floor), only
 * the tiles in it are touched: the rest stays as it was.
 */
export function deriveFaces(l: Layer, top: Int8Array, mask?: Uint8Array): void {
  const inMask = (j: number) => !mask || mask[j] === 1
  for (let ty = 0; ty < l.h; ty++) for (let tx = 0; tx < l.w; tx++) if (inMask(idx(l, tx, ty))) setFlat(l, tx, ty, top[idx(l, tx, ty)]!)
  for (let tx = 0; tx < l.w; tx++)
    for (let ty = 0; ty < l.h - 1; ty++) {
      if (!inMask(idx(l, tx, ty))) continue
      const hi = top[idx(l, tx, ty)]!
      const lo = top[idx(l, tx, ty + 1)]!
      if (hi <= lo) continue
      const rows = (hi - lo) * ROWS_PER_LEVEL
      for (let i = 1; i <= rows && ty + i < l.h; i++) {
        const j = idx(l, tx, ty + i)
        if (top[j]! >= hi || !inMask(j)) break
        setClosed(l, tx, ty + i, KIND.face)
        l.faceTop[j] = hi
        l.faceRow[j] = i - 1
        l.faceRows[j] = rows
      }
    }
}

/**
 * A trail: tiles in walking order, the first and last on the land it joins
 * (left as they are). The tiles between climb evenly from z0 to z1, each
 * open only toward the tiles before and after it, so a trail's legs can
 * run side by side on a face without joining.
 */
export function trail(l: Layer, path: [number, number][], z0: number, z1: number, ground: number): void {
  const n = path.length
  const bound = (j: number) => z0 + ((z1 - z0) * j) / (n - 2)
  for (let i = 1; i < n - 1; i++) {
    const [tx, ty] = path[i]!
    setClosed(l, tx, ty, KIND.slope)
    l.ground[idx(l, tx, ty)] = ground
    l.faceRow[idx(l, tx, ty)] = -1
    for (const [j, other] of [
      [i - 1, path[i - 1]!],
      [i, path[i + 1]!]
    ] as const) {
      const d = ([N, E, S, W] as Dir[]).find((dd) => tx + DX[dd] === other[0] && ty + DY[dd] === other[1])
      if (d === undefined) throw new Error(`height lab: trail tiles ${tx},${ty} and ${other} don't touch`)
      l.edge[idx(l, tx, ty) * 4 + d] = bound(j)
    }
  }
}

/**
 * A ramp across a rectangle, rising toward `up` from zLow to zHigh: open
 * along its length and between its lanes, shut at its outer sides.
 */
export function ramp(l: Layer, x0: number, y0: number, x1: number, y1: number, up: Dir, zLow: number, zHigh: number, ground: number): void {
  const vertical = up === N || up === S
  const len = vertical ? y1 - y0 + 1 : x1 - x0 + 1
  rect((tx, ty) => {
    // How far along the rise this tile starts (0 at the low end).
    const along = up === N ? y1 - ty : up === S ? ty - y0 : up === E ? tx - x0 : x1 - tx
    const lo = zLow + ((zHigh - zLow) * along) / len
    const hi = zLow + ((zHigh - zLow) * (along + 1)) / len
    const mid = (lo + hi) / 2
    const i = idx(l, tx, ty)
    setClosed(l, tx, ty, KIND.slope)
    l.ground[i] = ground
    l.faceRow[i] = -1
    const e = l.edge
    const down = ((up + 2) & 3) as Dir
    e[i * 4 + up] = hi
    e[i * 4 + down] = lo
    const sides: Dir[] = vertical ? [E, W] : [N, S]
    for (const s of sides) {
      const outer = vertical ? (s === E ? tx === x1 : tx === x0) : s === S ? ty === y1 : ty === y0
      e[i * 4 + s] = outer ? Number.NaN : mid
    }
  }, x0, y0, x1, y1)
}

/** Paint a path (ground only) along straight runs between points, on flat land. */
export function pathLine(l: Layer, pts: [number, number][]): void {
  for (let k = 0; k < pts.length - 1; k++) {
    let [x, y] = pts[k]!
    const [x1, y1] = pts[k + 1]!
    while (x !== x1 || y !== y1) {
      if (l.kind[idx(l, x, y)] === KIND.flat && l.ground[idx(l, x, y)] !== G.water) l.ground[idx(l, x, y)] = G.path
      if (x !== x1) x += Math.sign(x1 - x)
      else y += Math.sign(y1 - y)
    }
    if (l.kind[idx(l, x1, y1)] === KIND.flat) l.ground[idx(l, x1, y1)] = G.path
  }
}

export function portal(stack: Stack, a: number, tx: number, ty: number, d: Dir, b: number): void {
  stack.portals.set(portalKey(stack, a, tx, ty, d), b)
  const back = ((d + 2) & 3) as Dir
  stack.portals.set(portalKey(stack, b, tx + DX[d], ty + DY[d], back), a)
}

// ---------------------------------------------------------------- the area

export function buildLabArea(opts: AreaOptions = DEFAULT_AREA_OPTIONS): LabArea {
  const w = LAB_W
  const h = LAB_H
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
  rect(setTop(1, G.moss), 12, 6, 45, 36)
  rect(setTop(1, G.moss), 46, 6, 59, 33)
  rect(setTop(2, G.trodden), 36, 3, 59, 21)
  deriveFaces(surface, top)

  // Water: a pond in the valley (shut), sand round it.
  ellipse((tx, ty) => (surface.ground[idx(surface, tx, ty)] = G.bank), 9, 56, 7, 4.5)
  ellipse((tx, ty) => {
    setClosed(surface, tx, ty, KIND.water)
    surface.ground[idx(surface, tx, ty)] = G.water
  }, 9, 56, 5.5, 3.2)

  // Paths (paint only): valley spawn to the ramp and the mouth; across the
  // plateau to the switchback and the second mouth; over the shoulder.
  pathLine(surface, [[24, 60], [24, 46], [17, 46], [17, 40]])
  pathLine(surface, [[24, 46], [30, 46], [30, 40]])
  pathLine(surface, [[17, 36], [17, 30], [40, 30], [40, 25]])
  pathLine(surface, [[40, 30], [52, 30], [52, 25]])
  pathLine(surface, [[44, 21], [44, 12], [55, 12], [55, 9]])
  pathLine(surface, [[55, 12], [58, 12]])

  // 2. Carved: the ramp up the plateau's face (three lanes, rows 37–39).
  ramp(surface, 16, 37, 18, 39, N, 0, 1, G.trodden)

  // The switchback up the shoulder's face (rows 22–24), legs side by side.
  const sw: [number, number][] = [[40, 25]]
  for (let x = 40; x <= 46; x++) sw.push([x, 24])
  for (let x = 46; x >= 40; x--) sw.push([x, 23])
  for (let x = 40; x <= 44; x++) sw.push([x, 22])
  sw.push([44, 21])
  trail(surface, sw, 1, 2, G.path)

  // Cave mouths: an arch two rows high under a lintel, two tiles wide.
  const mouths: Mouth[] = [
    { x0: 30, x1: 31, lintel: 37, arch: [38, 39] },
    { x0: 52, x1: 53, lintel: 22, arch: [23, 24] }
  ]
  for (const m of mouths) for (let tx = m.x0; tx <= m.x1; tx++) for (const ty of m.arch) setClosed(surface, tx, ty, KIND.mouth)

  // The cave layer: the first tunnel (level 0 at the arch, down to -1),
  // the chamber, the second tunnel climbing east under the shoulder to the
  // second mouth (level 1).
  const floor = (z: number, ground: number = G['cave-floor']) => (tx: number, ty: number) => {
    setFlat(cave, tx, ty, z)
    cave.ground[idx(cave, tx, ty)] = ground
  }
  rect(floor(0), 30, 38, 31, 39)
  ramp(cave, 30, 33, 31, 37, S, -1, 0, G['cave-floor'])
  rect(floor(-1), 30, 29, 31, 32)
  // The chamber is natural rock; the tunnels are cut.
  ellipse(floor(-1, G['cave-rough']), 32, 24, 10, 7)
  // Pillars and a still pool in the chamber.
  for (const [tx, ty] of [[27, 22], [28, 22], [27, 23], [36, 26], [37, 26], [36, 27], [33, 19]] as const) {
    setClosed(cave, tx, ty, KIND.rock)
    cave.ground[idx(cave, tx, ty)] = G['cave-rock']
  }
  ellipse((tx, ty) => {
    setClosed(cave, tx, ty, KIND.water)
    cave.ground[idx(cave, tx, ty)] = G.water
  }, 26.5, 27.5, 2.6, 1.6)
  ramp(cave, 41, 20, 50, 21, E, -1, 1, G['cave-floor'])
  rect(floor(1), 51, 20, 53, 21)
  rect(floor(1), 52, 22, 53, 24)
  for (const tx of [30, 31]) portal(stack, SURFACE, tx, 40, N, CAVE)
  for (const tx of [52, 53]) portal(stack, SURFACE, tx, 25, N, CAVE)

  // (Light is worked out from the finished plan: lightArea.)
  caveRock(stack, top)

  // Props: woods round the valley's edges, pines and stones on the plateau,
  // a cairn at the shoulder's lookout.
  const props: PropSpot[] = []
  const clear = new Set<number>()
  const keepClear = (cx: number, cy: number, r: number) => rect((tx, ty) => clear.add(idx(surface, tx, ty)), cx - r, cy - r, cx + r, cy + r)
  keepClear(24, 46, 3)
  keepClear(17, 41, 2)
  keepClear(30, 41, 2)
  keepClear(40, 26, 1)
  keepClear(52, 26, 2)
  keepClear(44, 20, 1)
  keepClear(57, 12, 2)
  const place = (p: PropSpot) => {
    const i = idx(surface, p.tx, p.ty)
    if (clear.has(i) || surface.kind[i] !== KIND.flat || surface.ground[i] === G.path || surface.ground[i] === G.bank) return
    // Never at a cliff's foot or lip: trees there hide the edge.
    for (let d = 0; d < 4; d++) {
      const k = surface.kind[idx(surface, Math.min(w - 1, Math.max(0, p.tx + DX[d])), Math.min(h - 1, Math.max(0, p.ty + DY[d])))]
      if (k !== KIND.flat) return
    }
    if (p.blocks) setClosed(surface, p.tx, p.ty, KIND.prop)
    props.push(p)
  }
  for (let ty = 1; ty < h - 1; ty++)
    for (let tx = 1; tx < w - 1; tx++) {
      const r = hash(tx, ty, 1)
      const z = top[idx(surface, tx, ty)]!
      const edge = Math.min(tx, ty, w - 1 - tx, h - 1 - ty)
      const v = Math.floor(hash(tx, ty, 2) * 8)
      if (z === 0) {
        const dense = edge < 6 || (tx > 60 && ty > 40) || (ty > 52 && tx > 34)
        if (r < (dense ? 0.16 : 0.025)) place({ kind: hash(tx, ty, 3) < 0.6 ? 'oak' : hash(tx, ty, 4) < 0.5 ? 'pine' : 'birch', tx, ty, variant: v, blocks: true })
        else if (r > 0.975) place({ kind: 'fern', tx, ty, variant: v, blocks: false })
      } else if (z === 1) {
        if (r < 0.035) place({ kind: hash(tx, ty, 3) < 0.7 ? 'pine' : 'boulder', tx, ty, variant: v, blocks: true })
        else if (r > 0.97) place({ kind: 'fern', tx, ty, variant: v, blocks: false })
      } else if (r < 0.03) place({ kind: 'boulder', tx, ty, variant: v, blocks: true })
    }
  place({ kind: 'cairn', tx: 55, ty: 8, variant: 1, blocks: true })
  place({ kind: 'standing-stone', tx: 59, ty: 15, variant: 2, blocks: true })

  const spawn: Node = { layer: SURFACE, tx: 24, ty: 47 }
  const route: Node[] = [
    { layer: SURFACE, tx: 26, ty: 49 },
    { layer: SURFACE, tx: 17, ty: 32 },
    { layer: SURFACE, tx: 44, ty: 17 },
    { layer: SURFACE, tx: 57, ty: 12 },
    { layer: SURFACE, tx: 40, ty: 27 },
    { layer: SURFACE, tx: 17, ty: 32 },
    { layer: SURFACE, tx: 30, ty: 43 },
    { layer: CAVE, tx: 33, ty: 24 },
    { layer: CAVE, tx: 52, ty: 22 },
    { layer: SURFACE, tx: 50, ty: 29 },
    { layer: SURFACE, tx: 17, ty: 32 }
  ]
  return lightArea(
    {
      name: 'shoulder',
      stack,
      top,
      props,
      mouths,
      glows: [
        { tx: 24, ty: 24, z: -1, color: 0x7fd8ff },
        { tx: 39, ty: 21, z: -1, color: 0xb48cff },
        { tx: 33, ty: 29, z: -1, color: 0x7fffc8 },
        { tx: 29, ty: 18, z: -1, color: 0x7fd8ff }
      ],
      spawn,
      route,
      homes: [
        { layer: SURFACE, tx: 24, ty: 31, art: 'slime' },
        { layer: CAVE, tx: 35, ty: 23, art: 'mushroom' }
      ]
    },
    opts
  )
}

/** How far rock is drawn round the cave's floor (tiles). */
export const ROCK_REACH = 3

/**
 * Rock round the cave's floor: within ROCK_REACH tiles of it, wherever the
 * land above stands higher than that floor (so none is drawn over the
 * open valley in front of a mouth).
 */
export function caveRock(stack: Stack, top: Int8Array): void {
  const cave = stack.layers[CAVE]!
  const surface = stack.layers[SURFACE]!
  // A face (or a mouth or trail cut into one) stands as high as its top.
  const above = (i: number) => Math.max(top[i]!, surface.faceTop[i]!)
  for (let ty = 0; ty < cave.h; ty++)
    for (let tx = 0; tx < cave.w; tx++) {
      if (!walkable(cave, tx, ty)) continue
      const z = cave.edge[idx(cave, tx, ty) * 4]!
      const zf = Number.isNaN(z) ? 0 : z
      for (let y = ty - ROCK_REACH; y <= ty + ROCK_REACH; y++)
        for (let x = tx - ROCK_REACH; x <= tx + ROCK_REACH; x++) {
          if (x < 0 || y < 0 || x >= cave.w || y >= cave.h) continue
          const j = idx(cave, x, y)
          if (cave.kind[j] !== KIND.none) continue
          if (above(j) > zf + 0.5) {
            cave.kind[j] = KIND.rock
            cave.ground[j] = G['cave-rock']
          }
        }
    }
}

/** Every route leg walks (the tests and the remote player use this). */
export function routeLegs(area: LabArea): (Node[] | null)[] {
  const legs: (Node[] | null)[] = []
  for (let i = 0; i < area.route.length; i++) legs.push(findPath(area.stack, area.route[i]!, area.route[(i + 1) % area.route.length]!))
  return legs
}
