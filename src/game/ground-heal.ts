/**
 * Seam healing for the playtest-1 ground tiles (scripts/build-atlases.ts runs
 * it on the baked texels; no Phaser, no DOM, so tests run it too).
 *
 * The delivered tiles aren't seamless: a tile's right edge doesn't continue
 * into its own left edge, let alone into another variant's. Healing makes
 * every tile of a family share its border texels with one reference tile
 * (the family's first), so any two tiles of the family meet without a seam,
 * in any order, side by side or stacked:
 *
 *  - Each tile's left band is cut over to the reference's middle columns
 *    (c, c+1, …) and its right band to the columns just before them
 *    (…, c-2, c-1), so tile A's last column and tile B's first are the
 *    reference's neighbouring columns c-1 and c.
 *  - The cut is a minimum-error boundary (image quilting): a path through
 *    the band where the tile and the reference differ least, so a stone or
 *    a leaf is cut along a gap rather than through its middle.
 *  - Then the same top and bottom, against the reference after its own
 *    left/right pass. The top and bottom cuts start and end at fixed rows,
 *    so the left and right edge columns are built the same way on every
 *    tile and stay continuous after this second pass.
 */

/** An RGBA image, `w`×`h`, row-major. */
export interface Rgba {
  w: number
  h: number
  data: Uint8Array | Uint8ClampedArray
}

/** How far into a tile the cuts may wander (texels, a quarter of a 64-texel tile). */
export const HEAL_BAND = 16

function copy(img: Rgba): Rgba {
  return { w: img.w, h: img.h, data: new Uint8Array(img.data) }
}

/** Squared colour distance between a texel of `a` and one of `b`. */
function diff(a: Rgba, ax: number, ay: number, b: Rgba, bx: number, by: number): number {
  const i = (ay * a.w + ax) * 4
  const j = (by * b.w + bx) * 4
  const r = a.data[i] - b.data[j]
  const g = a.data[i + 1] - b.data[j + 1]
  const bl = a.data[i + 2] - b.data[j + 2]
  return r * r + g * g + bl * bl
}

function put(out: Rgba, x: number, y: number, src: Rgba, sx: number, sy: number): void {
  const i = (y * out.w + x) * 4
  const j = (sy * src.w + sx) * 4
  out.data[i] = src.data[j]
  out.data[i + 1] = src.data[j + 1]
  out.data[i + 2] = src.data[j + 2]
  out.data[i + 3] = src.data[j + 3]
}

/**
 * A minimum-cost path down `n` steps through `lo..hi` (inclusive): at each
 * step the path moves at most one place. `cost(step, place)`. `start` /
 * `end` pin the first / last step's place.
 */
export function seam(n: number, lo: number, hi: number, cost: (step: number, place: number) => number, start?: number, end?: number): number[] {
  const width = hi - lo + 1
  const acc = new Float64Array(n * width)
  const from = new Int8Array(n * width)
  for (let p = 0; p < width; p++) acc[p] = start === undefined || start === lo + p ? cost(0, lo + p) : Infinity
  for (let s = 1; s < n; s++) {
    for (let p = 0; p < width; p++) {
      let best = Infinity
      let dir = 0
      for (let d = -1; d <= 1; d++) {
        const q = p + d
        if (q < 0 || q >= width) continue
        const v = acc[(s - 1) * width + q]
        // Prefer going straight on ties: a calmer seam.
        if (v < best || (v === best && d === 0)) {
          best = v
          dir = d
        }
      }
      acc[s * width + p] = best + cost(s, lo + p)
      from[s * width + p] = dir
    }
  }
  let p = 0
  if (end !== undefined) p = end - lo
  else for (let q = 1; q < width; q++) if (acc[(n - 1) * width + q] < acc[(n - 1) * width + p]) p = q
  const path = new Array<number>(n)
  for (let s = n - 1; s >= 0; s--) {
    path[s] = lo + p
    p += from[s * width + p]
  }
  return path
}

/**
 * The left and right bands of `tile` cut over to `ref`'s middle columns
 * (`ref` is the same size). Square tiles only.
 */
export function healColumns(tile: Rgba, ref: Rgba, band = HEAL_BAND): Rgba {
  const n = tile.w
  const c = n >> 1
  const out = copy(tile)
  // Left band: texels left of the cut come from ref's columns c, c+1, ….
  const left = seam(n, 1, band - 1, (y, x) => diff(tile, x, y, ref, c + x, y))
  // Right band: texels right of the cut come from ref's columns …, c-2, c-1.
  const right = seam(n, n - band, n - 2, (y, x) => diff(tile, x, y, ref, c - n + x, y))
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < left[y]; x++) put(out, x, y, ref, c + x, y)
    for (let x = right[y] + 1; x < n; x++) put(out, x, y, ref, c - n + x, y)
  }
  return out
}

/**
 * The top and bottom bands of `tile` cut over to `ref`'s middle rows, the
 * cuts pinned to the same rows at both edge columns (see the module note).
 */
export function healRows(tile: Rgba, ref: Rgba, band = HEAL_BAND): Rgba {
  const n = tile.h
  const c = n >> 1
  const out = copy(tile)
  const topPin = band >> 1
  const bottomPin = n - 1 - (band >> 1)
  const top = seam(n, 1, band - 1, (x, y) => diff(tile, x, y, ref, x, c + y), topPin, topPin)
  const bottom = seam(n, n - band, n - 2, (x, y) => diff(tile, x, y, ref, x, c - n + y), bottomPin, bottomPin)
  for (let x = 0; x < n; x++) {
    for (let y = 0; y < top[x]; y++) put(out, x, y, ref, x, c + y)
    for (let y = bottom[x] + 1; y < n; y++) put(out, x, y, ref, x, c - n + y)
  }
  return out
}

/** A tile's local mean colour: a box blur `r` texels each way (clamped at the edges). */
function blur(img: Rgba, r: number): Float32Array {
  const { w, h } = img
  const tmp = new Float32Array(w * h * 3)
  const out = new Float32Array(w * h * 3)
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let ch = 0; ch < 3; ch++) {
        let s = 0
        let n = 0
        for (let d = -r; d <= r; d++) {
          const xx = x + d
          if (xx < 0 || xx >= w) continue
          s += img.data[(y * w + xx) * 4 + ch]
          n++
        }
        tmp[(y * w + x) * 3 + ch] = s / n
      }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      for (let ch = 0; ch < 3; ch++) {
        let s = 0
        let n = 0
        for (let d = -r; d <= r; d++) {
          const yy = y + d
          if (yy < 0 || yy >= h) continue
          s += tmp[(yy * w + x) * 3 + ch]
          n++
        }
        out[(y * w + x) * 3 + ch] = s / n
      }
  return out
}

/**
 * Even out a family's broad shading: each texel loses `strength` of the
 * difference between its tile's local mean (`radius` texels) and the
 * family's mean colour. Painted tiles with a light patch on one side and a
 * dark corner on another otherwise line up into stripes when tiled, however
 * clean their borders are; the fine detail stays.
 */
export function flattenFamily(tiles: Rgba[], strength: number, radius = 10): Rgba[] {
  if (strength <= 0 || tiles.length === 0) return tiles
  const mean = [0, 0, 0]
  let n = 0
  for (const t of tiles)
    for (let i = 0; i < t.data.length; i += 4) {
      for (let ch = 0; ch < 3; ch++) mean[ch] += t.data[i + ch]
      n++
    }
  for (let ch = 0; ch < 3; ch++) mean[ch] /= n
  return tiles.map((t) => {
    const b = blur(t, radius)
    const out = copy(t)
    for (let p = 0; p < t.w * t.h; p++)
      for (let ch = 0; ch < 3; ch++) out.data[p * 4 + ch] = Math.max(0, Math.min(255, Math.round(t.data[p * 4 + ch] - strength * (b[p * 3 + ch] - mean[ch]))))
    return out
  })
}

/** Heal a family of square tiles against its first: every result shares its borders. */
export function healFamily(tiles: Rgba[], band = HEAL_BAND): Rgba[] {
  if (tiles.length === 0) return []
  const ref = tiles[0]
  const refCols = healColumns(ref, ref, band)
  return tiles.map((t) => healRows(t === ref ? refCols : healColumns(t, ref, band), refCols, band))
}

/** Cut tile `i` (a `cell`-texel square in a `cols`-wide grid) out of an atlas. */
export function cellOf(atlas: Rgba, i: number, cell: number, cols: number): Rgba {
  const out: Rgba = { w: cell, h: cell, data: new Uint8Array(cell * cell * 4) }
  const x0 = (i % cols) * cell
  const y0 = Math.floor(i / cols) * cell
  for (let y = 0; y < cell; y++) {
    const from = ((y0 + y) * atlas.w + x0) * 4
    out.data.set(atlas.data.subarray(from, from + cell * 4), y * cell * 4)
  }
  return out
}

/** Write tile `i` back into the atlas. */
export function setCell(atlas: Rgba, i: number, cell: number, cols: number, tile: Rgba): void {
  const x0 = (i % cols) * cell
  const y0 = Math.floor(i / cols) * cell
  for (let y = 0; y < cell; y++) atlas.data.set(tile.data.subarray(y * cell * 4, (y + 1) * cell * 4), ((y0 + y) * atlas.w + x0) * 4)
}

/**
 * The mean colour step across a tile border when `a` sits left of `b`
 * (`vertical`: `a` above `b`), next to the mean step between neighbouring
 * texels inside them: a measure of how visible the seam is (tests, report).
 */
export function seamStep(a: Rgba, b: Rgba, vertical = false): { border: number; inside: number } {
  const n = a.w
  let border = 0
  let inside = 0
  for (let i = 0; i < n; i++) {
    border += vertical ? Math.sqrt(diff(a, i, n - 1, b, i, 0)) : Math.sqrt(diff(a, n - 1, i, b, 0, i))
    inside += vertical ? Math.sqrt(diff(a, i, n - 2, a, i, n - 1)) : Math.sqrt(diff(a, n - 2, i, a, n - 1, i))
  }
  return { border: border / n, inside: inside / n }
}
