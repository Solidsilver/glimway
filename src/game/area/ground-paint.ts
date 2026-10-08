/**
 * Assembling the ground tileset in plain arrays (no DOM: the painting worker,
 * ./ground-worker.ts, and tests run it). ./terrain.ts lays the tileset out
 * as cells `cell` texels a side, `cell + 2` apart, each ringed by a copy of
 * its own edge texels (extruded) so nearest sampling at a tile's edge never
 * picks up its neighbour in the sheet.
 *
 * The extrusion used to be four self-copying `drawImage`s per cell on the
 * tileset canvas, and each overlay its own `putImageData`: seconds of
 * main-thread work on the Commons. Here it's array copies, and the canvas
 * takes the whole tileset in one `putImageData`.
 */
import { EDGE_TEXTURE, WATER_FRAME_COUNT, paintEdge, parseEdgeKey, waterAt, type GroundClass } from './ground-field.ts'
import { TILE } from '../../lib/tile.ts'

/** An RGBA buffer `w` texels wide. */
export interface Texels {
  w: number
  data: Uint8ClampedArray
}

/**
 * Ring the cell whose top-left texel is (x, y) with copies of its edges, as
 * the four `drawImage`s did: the top and bottom rows out, then the left and
 * right columns (corners included) out.
 */
export function extrude(t: Texels, x: number, y: number, cell: number): void {
  const { w, data } = t
  const row = (from: number, to: number) => data.copyWithin((to * w + x) * 4, (from * w + x) * 4, (from * w + x + cell) * 4)
  row(y, y - 1)
  row(y + cell - 1, y + cell)
  for (let yy = y - 1; yy <= y + cell; yy++) {
    const o = yy * w * 4
    for (let c = 0; c < 4; c++) {
      data[o + (x - 1) * 4 + c] = data[o + x * 4 + c]
      data[o + (x + cell) * 4 + c] = data[o + (x + cell - 1) * 4 + c]
    }
  }
}

/** Copy a `cell`² RGBA cell into the tileset at (x, y) and extrude it. */
export function putCell(t: Texels, x: number, y: number, cell: number, rgba: Uint8ClampedArray): void {
  for (let r = 0; r < cell; r++) t.data.set(rgba.subarray(r * cell * 4, (r + 1) * cell * 4), ((y + r) * t.w + x) * 4)
  extrude(t, x, y, cell)
}

/** The textures some overlay jobs are painted from, by name (EDGE_TEXTURE's, and the pond frames where they show water). */
export function edgeRefNames(jobs: readonly EdgeJob[] = []): string[] {
  const names = new Set<string>(Object.values(EDGE_TEXTURE))
  for (const j of jobs) {
    const { n, tx, ty } = parseEdgeKey(j.key)
    if (n.includes('water')) names.add(waterAt(tx, ty, j.f))
  }
  return [...names]
}

/** One overlay cell to paint: an edge key (./ground-field.ts edgeKey) at water frame `f`. */
export interface EdgeJob {
  key: string
  f: number
  /** Its tileset cell index. */
  i: number
}

/** Paint overlay cells from reference textures (`cell`² RGBA each, by name). */
export function paintEdgeJobs(jobs: EdgeJob[], refs: Record<string, Uint8ClampedArray>, k: number): { i: number; rgba: Uint8ClampedArray }[] {
  const cell = TILE * k
  return jobs.map((j) => {
    const { n, tx, ty } = parseEdgeKey(j.key)
    const tex = (c: GroundClass, f: number, x: number, y: number): [number, number, number] => {
      const t = refs[c === 'water' ? waterAt(tx, ty, f % WATER_FRAME_COUNT) : EDGE_TEXTURE[c]]
      const o = (y * cell + x) * 4
      return [t[o], t[o + 1], t[o + 2]]
    }
    return { i: j.i, rgba: paintEdge(n, tx, ty, k, j.f, tex) }
  })
}
