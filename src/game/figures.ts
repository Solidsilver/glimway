/**
 * Measuring figures on a delivered sheet (no DOM: the atlas build and the
 * tests both run it on decoded PNG texels).
 *
 * The playtest-1 residents' measured crops (atlas.json) are unreliable:
 * some cut a figure in half, some span two cells, and every frame was fitted
 * to its own box, so a person's frames neither share a scale nor a foot
 * point (breathing jumped, walking showed a neighbour's half). So the build
 * finds the figures itself: each opaque connected region of the sheet, with
 * the loose specks near it (a stray hair, a detached hand), and the
 * generator's stray pixels between cells dropped. A frame is then exactly
 * its figure's pixels, nothing from a neighbouring cell.
 */

export interface Rgba {
  w: number
  h: number
  data: Uint8Array | Uint8ClampedArray
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** One figure: its bounding box and its pixels (indices into the sheet). */
export interface Figure extends Box {
  pixels: Int32Array
}

/**
 * Figures are found by their solid texels (the generator's soft halo can
 * bridge two cells), then take the soft texels (any alpha) that touch them.
 */
const SOLID = 128
/** How far (px) a figure's soft edge reaches past its solid texels; fainter haze beyond is the generator's. */
const EDGE = 2

/**
 * The figures on a sheet: 8-connected solid regions. A region smaller than
 * `minShare` of the largest is a speck: it joins the figure whose box (grown
 * by `margin` px) holds its centre, or is dropped as the generator's noise.
 * Then each figure grows into the soft texels around it (its anti-aliased
 * edge) up to EDGE px out, nearest figure first; the rest of the soft haze
 * is dropped.
 */
export function findFigures(img: Rgba, opts: { minShare?: number; margin?: number } = {}): Figure[] {
  const { w, h, data } = img
  const minShare = opts.minShare ?? 0.08
  const margin = opts.margin ?? 10
  const label = new Int32Array(w * h).fill(-1)
  const regions: { box: Box; pixels: number[] }[] = []
  const stack: number[] = []
  for (let start = 0; start < w * h; start++) {
    if (label[start] !== -1 || data[start * 4 + 3] < SOLID) continue
    const id = regions.length
    const pixels: number[] = []
    let x0 = w, y0 = h, x1 = -1, y1 = -1
    label[start] = id
    stack.push(start)
    while (stack.length) {
      const p = stack.pop()!
      pixels.push(p)
      const px = p % w
      const py = (p - px) / w
      if (px < x0) x0 = px
      if (px > x1) x1 = px
      if (py < y0) y0 = py
      if (py > y1) y1 = py
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx
          if (nx < 0 || nx >= w) continue
          const n = ny * w + nx
          if (label[n] === -1 && data[n * 4 + 3] >= SOLID) {
            label[n] = id
            stack.push(n)
          }
        }
      }
    }
    regions.push({ box: { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 }, pixels })
  }
  const largest = Math.max(0, ...regions.map((r) => r.pixels.length))
  const big = regions.filter((r) => r.pixels.length >= largest * minShare)
  const joined = big.map((r) => ({ box: { ...r.box }, parts: [r.pixels] }))
  for (const r of regions) {
    if (r.pixels.length >= largest * minShare) continue
    const cx = r.box.x + r.box.w / 2
    const cy = r.box.y + r.box.h / 2
    const home = big.findIndex((b) => cx >= b.box.x - margin && cx < b.box.x + b.box.w + margin && cy >= b.box.y - margin && cy < b.box.y + b.box.h + margin)
    if (home < 0) continue
    const f = joined[home]
    const x0 = Math.min(f.box.x, r.box.x)
    const y0 = Math.min(f.box.y, r.box.y)
    f.box = { x: x0, y: y0, w: Math.max(f.box.x + f.box.w, r.box.x + r.box.w) - x0, h: Math.max(f.box.y + f.box.h, r.box.y + r.box.h) - y0 }
    f.parts.push(r.pixels)
  }
  // The soft edge: breadth-first from every figure at once.
  const owner = new Int32Array(w * h).fill(-1)
  let frontier: number[] = []
  joined.forEach((f, i) => {
    for (const part of f.parts) for (const p of part) {
      owner[p] = i
      frontier.push(p)
    }
  })
  const soft: number[][] = joined.map(() => [])
  for (let ring = 0; ring < EDGE && frontier.length; ring++) {
    const next: number[] = []
    for (const p of frontier) {
      const px = p % w
      const py = (p - px) / w
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy
        if (ny < 0 || ny >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx
          if (nx < 0 || nx >= w) continue
          const n = ny * w + nx
          const a = data[n * 4 + 3]
          if (owner[n] !== -1 || a === 0 || a >= SOLID) continue
          owner[n] = owner[p]
          soft[owner[p]].push(n)
          next.push(n)
        }
      }
    }
    frontier = next
  }
  return joined.map((f, i) => {
    const pixels = Int32Array.from([...f.parts.flat(), ...soft[i]])
    let x0 = f.box.x, y0 = f.box.y, x1 = f.box.x + f.box.w, y1 = f.box.y + f.box.h
    for (const p of soft[i]) {
      const x = p % w
      const y = (p - x) / w
      if (x < x0) x0 = x
      if (y < y0) y0 = y
      if (x + 1 > x1) x1 = x + 1
      if (y + 1 > y1) y1 = y + 1
    }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, pixels }
  })
}

/** Figures in reading order: rows (by vertical overlap), top to bottom, each left to right. */
export function figureRows<T extends Box>(figures: T[]): T[][] {
  const rows: { y0: number; y1: number; items: T[] }[] = []
  for (const f of [...figures].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))) {
    const cy = f.y + f.h / 2
    const row = rows.find((r) => cy >= r.y0 && cy < r.y1)
    if (row) {
      row.items.push(f)
      row.y0 = Math.min(row.y0, f.y)
      row.y1 = Math.max(row.y1, f.y + f.h)
    } else rows.push({ y0: f.y, y1: f.y + f.h, items: [f] })
  }
  return rows.sort((a, b) => a.y0 - b.y0).map((r) => r.items.sort((a, b) => a.x - b.x))
}

/**
 * A standing figure's foot point (sheet px): the bottom of its box, under
 * the alpha-weighted centre of its head and torso (the top `upper` of it).
 * The legs and swinging arms move through a walk; the head and body don't,
 * so a person's frames anchored here stand still while they breathe and step.
 */
export function footPoint(img: Rgba, f: Figure, upper = 0.55): { x: number; y: number } {
  const limit = f.y + f.h * upper
  let sx = 0, sa = 0
  for (const p of f.pixels) {
    const x = p % img.w
    const y = (p - x) / img.w
    if (y >= limit) continue
    const a = img.data[p * 4 + 3]
    sx += (x + 0.5) * a
    sa += a
  }
  return { x: sa ? sx / sa : f.x + f.w / 2, y: f.y + f.h }
}

/**
 * The figure's pixels alone on a transparent canvas covering `region` (sheet
 * px, whole), so a sampling rect anywhere inside it reads nothing else of
 * the sheet; `x`, `y` is where the canvas's origin sits on the sheet.
 */
export function extractFigure(img: Rgba, f: Figure, region: Box): Rgba & { x: number; y: number } {
  const { x: ox, y: oy, w, h } = region
  const data = new Uint8Array(w * h * 4)
  for (const p of f.pixels) {
    const x = p % img.w
    const y = (p - x) / img.w
    if (x < ox || y < oy || x >= ox + w || y >= oy + h) continue
    const o = ((y - oy) * w + (x - ox)) * 4
    data.set(img.data.subarray(p * 4, p * 4 + 4), o)
  }
  return { w, h, data, x: ox, y: oy }
}

/** A box grown by `pad` px on every side (whole px). */
export function grow(b: Box, pad: number): Box {
  const x = Math.floor(b.x - pad)
  const y = Math.floor(b.y - pad)
  return { x, y, w: Math.ceil(b.x + b.w + pad) - x, h: Math.ceil(b.y + b.h + pad) - y }
}

/**
 * Name a sheet's figures by its layout: `rows` lists the frame names of each
 * row of figures, left to right. Throws when the sheet's figures don't fall
 * into exactly that many rows of exactly those lengths.
 */
export function layoutFigures(img: Rgba, rows: readonly (readonly string[])[], what: string): Map<string, Figure> {
  const found = figureRows(findFigures(img))
  const want = rows.map((r) => r.length).join(',')
  const got = found.map((r) => r.length).join(',')
  if (want !== got) throw new Error(`${what}: expected figure rows ${want}, found ${got}`)
  const out = new Map<string, Figure>()
  rows.forEach((r, i) => r.forEach((name, j) => out.set(name, found[i][j])))
  return out
}

/** How many of a figure's pixels lie inside a box. */
export function overlap(img: Rgba, f: Figure, b: Box): number {
  let n = 0
  for (const p of f.pixels) {
    const x = p % img.w
    const y = (p - x) / img.w
    if (x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h) n++
  }
  return n
}

/**
 * Where a source rect lands when drawn at `scale` texels per source px with
 * source point `anchor` on canvas point `at`: the whole-texel destination
 * rect covering it, and the exact (fractional) source rect that maps onto
 * that destination at the same scale. Every frame of a group drawn this way
 * shares one scale and one anchor, to the texel.
 */
export function placeAt(box: Box, anchor: { x: number; y: number }, at: [number, number], scale: number): { s: [number, number, number, number]; d: [number, number, number, number] } {
  const eps = 1e-9
  const dx0 = Math.floor(at[0] + (box.x - anchor.x) * scale + eps)
  const dy0 = Math.floor(at[1] + (box.y - anchor.y) * scale + eps)
  const dx1 = Math.ceil(at[0] + (box.x + box.w - anchor.x) * scale - eps)
  const dy1 = Math.ceil(at[1] + (box.y + box.h - anchor.y) * scale - eps)
  return {
    s: [anchor.x + (dx0 - at[0]) / scale, anchor.y + (dy0 - at[1]) / scale, (dx1 - dx0) / scale, (dy1 - dy0) / scale],
    d: [dx0, dy0, dx1 - dx0, dy1 - dy0],
  }
}
