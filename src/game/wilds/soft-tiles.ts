/**
 * Worn tile art (open-map.md 2.5, the Lantern Road): a delivered ground tile
 * (the road's paving) turned and mirrored, its edge broken away toward the
 * open sides so the road ends in loose stones and earth rather than a
 * straight line, or worn through in patches. The pieces are baked once per
 * (frame, orientation, open sides, wear) into their own textures at the
 * art's density, and shared by every tile that needs the same one.
 */
import type Phaser from 'phaser'
import { addArtCanvas, artSource } from '../density.ts'
import { valueNoise } from './noise.ts'

/** Open sides and corners: the neighbours that aren't the same surface. */
export const OPEN = { n: 1, e: 2, s: 4, w: 8, ne: 16, se: 32, sw: 64, nw: 128 } as const

/**
 * Which sides and corners of (tx, ty) are open: `same` says whether a tile
 * carries the same surface. A corner counts only where both its sides are
 * closed (an inner corner of the band).
 */
export function openSides(tx: number, ty: number, same: (tx: number, ty: number) => boolean): number {
  let m = 0
  if (!same(tx, ty - 1)) m |= OPEN.n
  if (!same(tx + 1, ty)) m |= OPEN.e
  if (!same(tx, ty + 1)) m |= OPEN.s
  if (!same(tx - 1, ty)) m |= OPEN.w
  if (!(m & (OPEN.n | OPEN.e)) && !same(tx + 1, ty - 1)) m |= OPEN.ne
  if (!(m & (OPEN.s | OPEN.e)) && !same(tx + 1, ty + 1)) m |= OPEN.se
  if (!(m & (OPEN.s | OPEN.w)) && !same(tx - 1, ty + 1)) m |= OPEN.sw
  if (!(m & (OPEN.n | OPEN.w)) && !same(tx - 1, ty - 1)) m |= OPEN.nw
  return m
}

/**
 * How much of a tile stays at (u, v) (0..1 across, 0..1 down) with these
 * open sides: 1 kept, 0 broken away. `n` is the edge's noise (0..1), `holes`
 * a second noise for wear inside. Pure, for the tests.
 */
export function kept(u: number, v: number, open: number, n: number, holes: number | null): boolean {
  let d = Infinity
  if (open & OPEN.n) d = Math.min(d, v)
  if (open & OPEN.s) d = Math.min(d, 1 - v)
  if (open & OPEN.w) d = Math.min(d, u)
  if (open & OPEN.e) d = Math.min(d, 1 - u)
  if (open & OPEN.ne) d = Math.min(d, Math.hypot(1 - u, v) - 0.05)
  if (open & OPEN.se) d = Math.min(d, Math.hypot(1 - u, 1 - v) - 0.05)
  if (open & OPEN.sw) d = Math.min(d, Math.hypot(u, 1 - v) - 0.05)
  if (open & OPEN.nw) d = Math.min(d, Math.hypot(u, v) - 0.05)
  // Loose stones at the edge: the break wanders between a tenth and half a tile in.
  if (d < 0.1 + 0.4 * n) return false
  return holes === null || holes < 0.7
}

/**
 * The texture for `frame` turned by `orient` (0..3 quarter turns, +4
 * mirrored), with its open sides broken away and, when `wear` is set, worn
 * through in patches; `nv` picks one of a few noise patterns. Null when the
 * art didn't load.
 */
export function softTile(scene: Phaser.Scene, frame: string, orient: number, open: number, wear: boolean, nv: number): string | null {
  const key = `om-soft:${frame}:${orient}:${open}:${wear ? 1 : 0}:${nv}`
  if (scene.textures.exists(key)) return key
  const src = artSource(scene, frame)
  if (!src) return null
  const W = src.image.width
  const H = src.image.height
  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = false
  ctx.save()
  ctx.translate(W / 2, H / 2)
  ctx.rotate(((orient & 3) * Math.PI) / 2)
  if (orient & 4) ctx.scale(-1, 1)
  ctx.drawImage(src.image, -W / 2, -H / 2)
  ctx.restore()
  const img = ctx.getImageData(0, 0, W, H)
  const edge = valueNoise(0x2a51 + nv * 977)
  const holes = valueNoise(0x7c13 + nv * 131)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W
      const v = (y + 0.5) / H
      // Noise in stone-sized cells, so the edge breaks along stones, not texels.
      if (!kept(u, v, open, edge(u * 5, v * 5), wear ? holes(u * 4 + 9, v * 4 + 9) : null)) img.data[(y * W + x) * 4 + 3] = 0
    }
  ctx.putImageData(img, 0, 0)
  return addArtCanvas(scene, key, canvas, src.density) ? key : null
}

/**
 * One stepping stone of a ford, cut out of the ford art's water (`frame`
 * is `ford-h-0` or `ford-v-0`, three stones in a row, one a tile; `i` picks
 * one): the water keyed out, stray specks dropped (only the largest piece is
 * kept), and a soft shadow under it, so the stone sits on the painter's own
 * river. Null when the art didn't load.
 */
export function fordStone(scene: Phaser.Scene, frame: string, i: number): string | null {
  const key = `om-stone:${frame}:${i}`
  if (scene.textures.exists(key)) return key
  const src = artSource(scene, frame)
  if (!src) return null
  const across = src.w > src.h
  const T = across ? src.image.width / 3 : src.image.width
  const canvas = document.createElement('canvas')
  canvas.width = T
  canvas.height = T
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(src.image, across ? -i * T : 0, across ? 0 : -i * T)
  const img = ctx.getImageData(0, 0, T, T)
  const d = img.data
  const stone = new Uint8Array(T * T)
  for (let p = 0; p < T * T; p++) stone[p] = isWater(d[p * 4]!, d[p * 4 + 1]!, d[p * 4 + 2]!) ? 0 : 1
  const keep = largestPiece(stone, T)
  for (let p = 0; p < T * T; p++) if (!keep[p]) d[p * 4 + 3] = 0
  ctx.putImageData(img, 0, 0)
  // A soft shadow on the water under the stone.
  const out = document.createElement('canvas')
  out.width = T
  out.height = T
  const o = out.getContext('2d')!
  o.imageSmoothingEnabled = false
  o.fillStyle = 'rgba(8, 20, 24, 0.32)'
  o.beginPath()
  o.ellipse(T / 2 + T * 0.04, T * 0.58, T * 0.42, T * 0.26, 0, 0, Math.PI * 2)
  o.fill()
  o.drawImage(canvas, 0, 0)
  return addArtCanvas(scene, key, out, src.density) ? key : null
}

/** The ford art's water: blue-green over red (the stones are grey and brown). */
export function isWater(r: number, g: number, b: number): boolean {
  return b > r + 8 && g >= r
}

/** The largest 4-connected piece of a mask (T×T), as a mask. */
export function largestPiece(mask: Uint8Array, T: number): Uint8Array {
  const label = new Int32Array(T * T).fill(-1)
  let best = -1
  let bestSize = 0
  let n = 0
  for (let p = 0; p < T * T; p++) {
    if (!mask[p] || label[p] !== -1) continue
    const stack = [p]
    label[p] = n
    let size = 0
    while (stack.length) {
      const q = stack.pop()!
      size++
      const x = q % T
      const y = (q - x) / T
      for (const [nx, ny] of [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]] as const) {
        if (nx < 0 || ny < 0 || nx >= T || ny >= T) continue
        const r = ny * T + nx
        if (mask[r] && label[r] === -1) {
          label[r] = n
          stack.push(r)
        }
      }
    }
    if (size > bestSize) {
      bestSize = size
      best = n
    }
    n++
  }
  const out = new Uint8Array(T * T)
  for (let p = 0; p < T * T; p++) out[p] = label[p] === best ? 1 : 0
  return out
}

type FordTile = { tx: number; ty: number }
const FORD_STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const
const fordKey = (t: FordTile) => `${t.tx},${t.ty}`
const fordOrder = (a: FordTile, b: FordTile) => a.ty - b.ty || a.tx - b.tx

/**
 * One connected line of stones through each ford, following its actual
 * tiles between the dry banks. A route can bend or cross diagonally: no
 * single row or column need span the river. A scrap touching only one bank
 * gets no stones. Find the whole component before clipping to `inside`,
 * so neighbouring chunks (and different seed tiles) choose the same line.
 */
export function fordLines(seeds: readonly FordTile[], ford: (tx: number, ty: number) => boolean, wet: (tx: number, ty: number) => boolean, inside: (tx: number, ty: number) => boolean): (FordTile & { across: boolean })[] {
  const seen = new Set<string>()
  const out: (FordTile & { across: boolean })[] = []
  for (const start of seeds) {
    if (seen.has(fordKey(start))) continue
    const piece: FordTile[] = []
    const stack = [start]
    seen.add(fordKey(start))
    // The source contains only loaded tiles, so the component is finite.
    // Width alone cannot bound its area: routes can follow the river.
    while (stack.length) {
      const t = stack.pop()!
      piece.push(t)
      for (const [dx, dy] of FORD_STEPS) {
        const next = { tx: t.tx + dx, ty: t.ty + dy }
        const k = fordKey(next)
        if (!seen.has(k) && ford(next.tx, next.ty)) {
          seen.add(k)
          stack.push(next)
        }
      }
    }
    piece.sort(fordOrder)
    for (const t of fordBankPath(piece, wet)) if (inside(t.tx, t.ty)) out.push(t)
  }
  return out
}

/** Group the dry banks locally, then join their middle contacts through ford tiles. */
function fordBankPath(piece: readonly FordTile[], wet: (tx: number, ty: number) => boolean): (FordTile & { across: boolean })[] {
  const tiles = new Map(piece.map((t) => [fordKey(t), t]))
  const x0 = Math.min(...piece.map((t) => t.tx)) - 1
  const x1 = Math.max(...piece.map((t) => t.tx)) + 1
  const y0 = Math.min(...piece.map((t) => t.ty)) - 1
  const y1 = Math.max(...piece.map((t) => t.ty)) + 1
  const drySeen = new Set<string>()
  const banks: FordTile[][] = []
  for (const t of piece) for (const [dx, dy] of FORD_STEPS) {
    const start = { tx: t.tx + dx, ty: t.ty + dy }
    if (wet(start.tx, start.ty) || drySeen.has(fordKey(start))) continue
    const dry = [start]
    const contacts = new Map<string, FordTile>()
    drySeen.add(fordKey(start))
    for (let i = 0; i < dry.length; i++) for (const [dx, dy] of FORD_STEPS) {
      const at = dry[i]!
      const next = { tx: at.tx + dx, ty: at.ty + dy }
      const k = fordKey(next)
      if (tiles.has(k)) contacts.set(k, tiles.get(k)!)
      if (next.tx < x0 || next.tx > x1 || next.ty < y0 || next.ty > y1 || wet(next.tx, next.ty) || drySeen.has(k)) continue
      drySeen.add(k)
      dry.push(next)
    }
    banks.push([...contacts.values()].sort(fordOrder))
  }
  if (banks.length < 2) return []

  // Stable middle contacts preserve the centre line of a straight crossing.
  const middle = (bank: readonly FordTile[]) => bank[Math.floor((bank.length - 1) / 2)]!
  const start = middle(banks[0]!)
  const queue = [start]
  const prev = new Map<string, FordTile | null>([[fordKey(start), null]])
  for (let i = 0; i < queue.length; i++) for (const [dx, dy] of FORD_STEPS) {
    const at = queue[i]!
    const next = tiles.get(`${at.tx + dx},${at.ty + dy}`)
    if (!next || prev.has(fordKey(next))) continue
    prev.set(fordKey(next), at)
    queue.push(next)
  }
  const stones = new Map<string, FordTile & { across: boolean }>()
  for (const bank of banks.slice(1)) {
    const path: FordTile[] = []
    for (let at: FordTile | null = middle(bank); at; at = prev.get(fordKey(at))!) path.push(at)
    for (let i = 0; i < path.length; i++) {
      const t = path[i]!
      const a = path[i - 1] ?? t
      const b = path[i + 1] ?? t
      stones.set(fordKey(t), { ...t, across: Math.abs(b.tx - a.tx) >= Math.abs(b.ty - a.ty) })
    }
  }
  return [...stones.values()].sort(fordOrder)
}
