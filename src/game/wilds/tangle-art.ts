/**
 * Code-drawn pixel art for the Tangle, in the game's own style (1 px dark
 * outlines, lit from the upper left, crisp nearest-neighbour): trees and
 * woods pieces for the generator's decor (src/lib/wilds/tangle.ts), and a
 * per-pixel ground painter so paths, moss and the old road follow the
 * layout with ragged edges instead of square tiles.
 *
 * The chunk's ground is painted with a margin of fogged woods around it, so
 * a view wider than the chunk looks into deep trees rather than the void.
 * Nothing here is a third-party asset.
 */
import type Phaser from 'phaser'
import { DECOR_ART, TANGLE_GROUND, valueNoise } from '../../lib/wilds/tangle.ts'
import type { DecorKind } from '../../lib/wilds/types.ts'
import { TILE } from '../textures.ts'
import type { WorldData } from '../worlds.ts'
import { TANGLE_VARIANTS, tangleFrame } from './tangle-key.ts'
import { lookForAtlas, wildsLook, type DecorPalette, type GroundPalette, type Leaf } from './wilds-looks.ts'

type C = CanvasRenderingContext2D

/** Fogged woods painted around the chunk, in tiles (sides, top/bottom). */
const MARGIN_X = 10
const MARGIN_Y = 3
/** The scene's clear colour (src/game/main.ts): the margin fogs into it. */
const VOID: RGB = [0x24, 0x1f, 0x31]

const O = '#241a1c'

/**
 * The leaf palette the pieces draw with. Set for the duration of one
 * (synchronous) atlas build — the Tangle's, or the outer drift's in a Mark.
 */
let P: DecorPalette = wildsLook('tangle', null).decor
const BARK = { xd: '#2a1d16', dk: '#45301f', md: '#5e432c', lt: '#7a5a3a', hi: '#94734c' }
const IRON_BARK = { xd: '#1e1a1c', dk: '#302a2c', md: '#463d3c', lt: '#5f5450', hi: '#7a6d64' }
const BIRCH_BARK = { xd: '#5c564c', dk: '#9a9284', md: '#c8c0ae', lt: '#e4dccb', hi: '#f4efe2', mark: '#2e2a28' }
const WOOD = { xd: '#4a3220', dk: '#6b4c2e', md: '#8a6642', lt: '#b08a5c', hi: '#d8bc8c', ring: '#9c7a50' }
const STONE = { xd: '#4f4a44', dk: '#6c665c', md: '#8a8476', lt: '#a8a292', hi: '#c8c2b0', white: '#efe9dc' }
const CAP = { dk: '#8a4026', md: '#b8602e', lt: '#d88444', hi: '#f0b070', stem: '#e8dcc0', stemDk: '#b4a487', gill: '#6e4a36' }
const AMBER = { dk: '#b06a1c', md: '#e8a53c', hi: '#ffd98a' }
const SHADOW = 'rgba(14,10,18,0.38)'

// ---------------------------------------------------------------- helpers

type RGB = [number, number, number]

function rect(c: C, x: number, y: number, w: number, h: number, col: string): void {
  if (w <= 0 || h <= 0) return
  c.fillStyle = col
  c.fillRect(x, y, w, h)
}

function px(c: C, x: number, y: number, col: string): void {
  rect(c, Math.round(x), Math.round(y), 1, 1, col)
}

function oval(c: C, cx: number, cy: number, rx: number, ry: number, col: string): void {
  for (let y = -Math.ceil(ry); y <= Math.ceil(ry); y++)
    for (let x = -Math.ceil(rx); x <= Math.ceil(rx); x++)
      if ((x * x) / (rx * rx + 0.3) + (y * y) / (ry * ry + 0.3) <= 1) px(c, cx + x, cy + y, col)
}

/** Deterministic 0..1 per pixel, for speckle. */
function h01(x: number, y: number, s = 0): number {
  let v = (Math.imul(x | 0, 73856093) ^ Math.imul(y | 0, 19349663) ^ Math.imul(s | 0, 83492791)) | 0
  v = Math.imul(v ^ (v >>> 13), 1274126177)
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296
}

function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function strHash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193)
  return h >>> 0
}


/** Outline a drawn silhouette: every clear pixel touching a filled one becomes O. */
function outline(c: C, w: number, h: number, col = O): void {
  const d = c.getImageData(0, 0, w, h).data
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 200
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (!filled(x, y) && (filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1))) px(c, x, y, col)
}

/** Soft contact shadow under a piece, drawn after the outline. */
function shadow(c: C, cx: number, cy: number, rx: number, ry: number): void {
  const d = c.getImageData(0, 0, c.canvas.width, c.canvas.height).data
  c.fillStyle = SHADOW
  for (let y = -ry; y <= ry; y++)
    for (let x = -rx; x <= rx; x++) {
      if ((x * x) / (rx * rx + 0.3) + (y * y) / (ry * ry + 0.3) > 1) continue
      const X = Math.round(cx + x)
      const Y = Math.round(cy + y)
      if (X < 0 || Y < 0 || X >= c.canvas.width || Y >= c.canvas.height) continue
      if (d[(Y * c.canvas.width + X) * 4 + 3] > 0) continue
      c.fillRect(X, Y, 1, 1)
    }
}


/**
 * A leafy crown: overlapping clumps, each with a dark rim below-right and
 * lit from the upper left; the lower part of the crown sits in its own shade.
 */
function crown(c: C, rnd: () => number, cx: number, cy: number, rx: number, ry: number, rMin: number, rMax: number, count: number, pal: Leaf, salt: number): void {
  const clumps: [number, number, number][] = [[cx, cy, Math.min(rx, ry) - 1]]
  for (let i = 0; i < count; i++) {
    const r = rMin + rnd() * (rMax - rMin)
    const a = rnd() * Math.PI * 2
    const d = Math.sqrt(rnd())
    clumps.push([cx + Math.cos(a) * d * Math.max(0, rx - r), cy + Math.sin(a) * d * Math.max(0, ry - r), r])
  }
  clumps.sort((a, b) => a[1] - b[1])
  for (const [x, y, r] of clumps) {
    oval(c, x + 1, y + 1, r, r * 0.9, pal.xd)
    for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++)
      for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) {
        if ((dx * dx) / (r * r + 0.3) + (dy * dy) / (r * r * 0.81 + 0.3) > 1) continue
        const X = Math.round(x + dx)
        const Y = Math.round(y + dy)
        const lit = (-dx - dy * 1.3) / r
        const n = h01(X, Y, salt)
        const low = Y > cy + ry * 0.35
        let col = lit > 0.95 ? (n < 0.5 ? pal.hi : pal.lt) : lit > 0.15 ? (n < 0.4 ? pal.lt : pal.md) : lit < -0.75 ? pal.dk : n < 0.22 ? pal.dk : pal.md
        if (low && col === pal.lt) col = pal.md
        else if (low && col === pal.md && n < 0.55) col = pal.dk
        if (col === pal.hi && n < 0.12) col = pal.gl
        px(c, X, Y, col)
      }
  }
}

type Bark = typeof BARK

/** A trunk from `top` down to `base`, lit on the left, flaring at the root. */
function trunk(c: C, cx: number, top: number, base: number, w: number, bark: Bark, flare = 2): void {
  for (let y = top; y <= base; y++) {
    const f = y >= base - 1 ? flare : y >= base - 2 ? Math.ceil(flare / 2) : 0
    const x0 = Math.round(cx - w / 2) - f
    const x1 = Math.round(cx + w / 2) - 1 + f
    for (let x = x0; x <= x1; x++) {
      const t = (x - x0) / Math.max(1, x1 - x0)
      const n = h01(x, y, 3)
      px(c, x, y, t < 0.25 ? (n < 0.3 ? bark.hi : bark.lt) : t < 0.65 ? (n < 0.25 ? bark.dk : bark.md) : n < 0.3 ? bark.xd : bark.dk)
    }
  }
}

// ---------------------------------------------------------------- the pieces

type Draw = (c: C, rnd: () => number, w: number, h: number, v: number) => void

const drawOak: Draw = (c, rnd, w, h, v) => {
  const cx = w / 2
  const base = h - 4
  trunk(c, cx, 14, base, 4 + (v % 2), BARK, 2)
  crown(c, rnd, cx, 11 + rnd(), w / 2 - 2, 9.5, 3.5, 5.5, 8, P.oak, v)
  outline(c, w, h)
  shadow(c, cx + 2, h - 3, 7, 2)
}

const drawIronOak: Draw = (c, rnd, w, h, v) => {
  const cx = w / 2
  const base = h - 4
  trunk(c, cx, 18, base, 7, IRON_BARK, 3)
  // Tight bark: fine dark lines up the trunk.
  for (let y = 22; y < base - 1; y += 2) px(c, cx - 1 + (y % 4 === 0 ? 1 : 0), y, IRON_BARK.xd)
  // Roots gripping the ground.
  for (const s of [-1, 1]) {
    for (let i = 0; i < 5; i++) px(c, cx + s * (4 + i), base - (i < 2 ? 1 : 0), i % 2 ? IRON_BARK.dk : IRON_BARK.md)
  }
  crown(c, rnd, cx, 14, w / 2 - 2, 12.5, 4.5, 7, 11, P.iron, v + 40)
  // A bead of amber on the bark (the woods' own memory).
  const ay = base - 6 - (v % 3)
  px(c, cx + 1, ay, AMBER.hi)
  px(c, cx + 1, ay + 1, AMBER.md)
  px(c, cx + 2, ay + 1, AMBER.dk)
  outline(c, w, h)
  shadow(c, cx + 3, h - 3, 11, 2)
}

const drawPine: Draw = (c, rnd, w, h, v) => {
  const cx = Math.floor(w / 2)
  const base = h - 4
  trunk(c, cx + 0.5, base - 6, base, 3, BARK, 1)
  const tiers = 4 + (v % 2)
  const top = 2
  const bottom = base - 4
  const step = (bottom - top) / (tiers + 0.6)
  for (let t = 0; t < tiers; t++) {
    const y0 = Math.round(top + t * step)
    const y1 = Math.round(top + (t + 1.6) * step)
    const hwMax = Math.min(w / 2 - 1, 3 + (t + 1) * ((w / 2 - 3) / tiers))
    for (let y = y0; y <= y1; y++) {
      const hw = ((y - y0) / Math.max(1, y1 - y0)) * hwMax + 0.5
      for (let x = Math.round(cx - hw); x <= Math.round(cx + hw); x++) {
        const rel = (x - cx) / Math.max(1, hw)
        const n = h01(x, y, v + 7)
        if (y === y1 && n < 0.45) continue
        const col = rel < -0.45 ? (n < 0.4 ? P.pine.hi : P.pine.lt) : rel < 0.25 ? (n < 0.3 ? P.pine.lt : P.pine.md) : rel < 0.7 ? P.pine.dk : P.pine.xd
        px(c, x, y, y >= y1 - 1 && col !== P.pine.xd ? P.pine.dk : col)
      }
    }
  }
  px(c, cx, top - 1, P.pine.lt)
  void rnd
  outline(c, w, h)
  shadow(c, cx + 2, h - 3, 6, 2)
}

const drawBirch: Draw = (c, rnd, w, h, v) => {
  const cx = Math.floor(w / 2)
  const base = h - 4
  for (let y = 9; y <= base; y++) {
    px(c, cx - 1, y, BIRCH_BARK.hi)
    px(c, cx, y, BIRCH_BARK.lt)
    px(c, cx + 1, y, BIRCH_BARK.dk)
    if (h01(cx, y, v) < 0.22) {
      px(c, cx, y, BIRCH_BARK.mark)
      if (h01(cx, y, v + 1) < 0.5) px(c, cx - 1, y, BIRCH_BARK.mark)
    }
  }
  crown(c, rnd, cx + 0.5, 10, w / 2 - 3, 8, 3, 4.5, 6, P.birch, v + 20)
  // Trunk showing through the sparse lower crown.
  for (let y = 15; y <= 18; y++) px(c, cx, y, BIRCH_BARK.md)
  outline(c, w, h)
  shadow(c, cx + 2, h - 3, 5, 2)
}

const drawSnag: Draw = (c, rnd, w, h, v) => {
  // A dead birch, broken off, with turncaps shelving up its side.
  const cx = Math.floor(w / 2)
  const base = h - 4
  const top = 4 + (v % 3)
  for (let y = top; y <= base; y++) {
    px(c, cx - 1, y, BIRCH_BARK.lt)
    px(c, cx, y, BIRCH_BARK.md)
    px(c, cx + 1, y, BIRCH_BARK.dk)
    if (h01(cx, y, v + 5) < 0.25) px(c, cx, y, BIRCH_BARK.mark)
  }
  // Jagged break at the top.
  px(c, cx - 1, top - 1, BIRCH_BARK.md)
  px(c, cx + 1, top - 2, BIRCH_BARK.dk)
  // Two bare branches.
  for (let i = 1; i <= 4; i++) px(c, cx - 1 - i, top + 6 - Math.floor(i / 2), BIRCH_BARK.dk)
  for (let i = 1; i <= 3; i++) px(c, cx + 1 + i, top + 10 - Math.floor(i / 2), BIRCH_BARK.dk)
  // Shelf caps, all tilted the same way.
  for (const [y, s] of [[base - 4, -1], [base - 9, 1], [base - 13, -1]] as const) {
    const x = cx + s * 2
    rect(c, x - 2, y, 4, 1, CAP.md)
    px(c, x - 2, y, CAP.hi)
    rect(c, x - 1, y + 1, 3, 1, CAP.dk)
  }
  void rnd
  outline(c, w, h)
  shadow(c, cx + 2, h - 3, 5, 2)
}

const drawThicket: Draw = (c, rnd, w, h, v) => {
  crown(c, rnd, w / 2, h - 9, w / 2 - 2, 6.5, 3, 4.5, 7, P.shrub, v + 60)
  // Bramble berries or hazel catkins.
  const berry = v % 2 === 0 ? '#9a2e44' : '#d8c47a'
  for (let i = 0; i < 4; i++) px(c, 4 + Math.floor(rnd() * (w - 8)), h - 13 + Math.floor(rnd() * 6), berry)
  outline(c, w, h)
  shadow(c, w / 2 + 2, h - 2, 9, 1)
}

/** The windfall custom: three leafy branches left at the stump. */
function leafyBranches(c: C, cx: number, y: number): void {
  for (const [x, yy] of [[cx - 5, y - 1], [cx + 1, y - 3], [cx + 5, y]]) {
    px(c, x, yy + 1, WOOD.dk)
    px(c, x - 1, yy, P.oak.lt)
    px(c, x, yy - 1, P.oak.md)
    px(c, x + 1, yy, P.oak.hi)
    px(c, x, yy, P.oak.lt)
  }
}

const drawStump: Draw = (c, _rnd, w, h, v) => {
  const cx = w / 2
  oval(c, cx, h - 6, 6, 3, BARK.dk)
  rect(c, cx - 6, h - 10, 12, 4, BARK.md)
  rect(c, cx - 6, h - 10, 3, 4, BARK.lt)
  oval(c, cx, h - 10, 5, 2, WOOD.lt)
  oval(c, cx, h - 10, 2, 1, WOOD.md)
  px(c, cx - 7, h - 6, BARK.dk)
  px(c, cx + 6, h - 6, BARK.dk)
  if (v % 2 === 0) leafyBranches(c, cx, h - 11)
  else {
    // Moss on the cut.
    px(c, cx - 3, h - 11, P.moss.lt)
    px(c, cx - 2, h - 11, P.moss.md)
  }
  outline(c, w, h)
  shadow(c, cx + 2, h - 2, 7, 1)
}

const drawRingStump: Draw = (c, _rnd, w, h) => {
  // A tight-ringed iron-oak stump: rings too close to slide a needle between.
  const cx = w / 2
  oval(c, cx, h - 6, 9, 3, IRON_BARK.dk)
  rect(c, cx - 9, h - 10, 18, 4, IRON_BARK.md)
  rect(c, cx - 9, h - 10, 4, 4, IRON_BARK.lt)
  for (let x = cx - 8; x < cx + 8; x += 3) px(c, x, h - 8, IRON_BARK.xd)
  oval(c, cx, h - 10, 8, 3, WOOD.hi)
  for (let r = 1; r <= 7; r++) {
    if (r % 2) continue
    for (let a = 0; a < 40; a++) {
      const t = (a / 40) * Math.PI * 2
      px(c, cx + Math.cos(t) * r, h - 10 + Math.sin(t) * r * 0.38, WOOD.ring)
    }
  }
  px(c, cx, h - 10, WOOD.dk)
  leafyBranches(c, cx, h - 12)
  outline(c, w, h)
  shadow(c, cx + 2, h - 2, 10, 1)
}

const drawLog: Draw = (c, _rnd, w, h, v) => {
  const y0 = h - 10
  rect(c, 3, y0, w - 7, 7, BARK.md)
  rect(c, 3, y0, w - 7, 2, BARK.lt)
  rect(c, 3, y0 + 5, w - 7, 2, BARK.dk)
  for (let x = 5; x < w - 6; x += 4) px(c, x, y0 + 3 + (x % 3 === 0 ? 1 : 0), BARK.xd)
  // The cut end, rings showing.
  oval(c, w - 4, y0 + 3, 2, 3.5, WOOD.lt)
  px(c, w - 4, y0 + 3, WOOD.dk)
  px(c, w - 4, y0 + 1, WOOD.ring)
  px(c, w - 4, y0 + 5, WOOD.ring)
  // Moss along the top, a broken branch stub, turncaps on the old wood.
  for (let x = 4; x < w - 8; x++) if (h01(x, 1, v) < 0.55) px(c, x, y0, h01(x, 2, v) < 0.5 ? P.moss.lt : P.moss.md)
  px(c, 9, y0 - 1, BARK.md)
  px(c, 8, y0 - 2, BARK.dk)
  if (v % 2 === 0) {
    for (const x of [14, 18]) {
      rect(c, x - 1, y0 - 2, 3, 1, CAP.md)
      px(c, x - 1, y0 - 2, CAP.hi)
      px(c, x, y0 - 1, CAP.stem)
    }
  }
  outline(c, w, h)
  shadow(c, w / 2 + 2, h - 2, 13, 1)
}

const drawBoulder: Draw = (c, _rnd, w, h, v) => {
  const cx = w / 2
  const cy = h - 8
  oval(c, cx, cy, 8, 5.5, STONE.dk)
  oval(c, cx - 1, cy - 1, 6.5, 4.5, STONE.md)
  oval(c, cx - 2, cy - 2, 4, 2.5, STONE.lt)
  px(c, cx - 3, cy - 3, STONE.hi)
  px(c, cx + 2, cy + 1, STONE.xd)
  px(c, cx + 3, cy, STONE.xd)
  // A moss cap.
  for (let x = -5; x <= 4; x++) {
    const top = cy - 5 + Math.round(Math.abs(x) * 0.35)
    const deep = 1 + (h01(x, 0, v) < 0.5 ? 1 : 0)
    for (let y = top; y < top + deep; y++) px(c, cx + x, y, h01(x, y, v) < 0.5 ? P.moss.lt : P.moss.md)
    if (x < -1) px(c, cx + x, top, P.moss.hi)
  }
  outline(c, w, h)
  shadow(c, cx + 2, h - 2, 8, 1)
}

const drawCairn: Draw = (c, _rnd, w, h, v) => {
  // Stones topped by a white river-stone: a route-mark at a fork.
  const cx = w / 2
  const stones: [number, number, number, number][] = [
    [cx, h - 5, 5.5, 2.5],
    [cx + (v % 2 ? 1 : -1), h - 9, 4.5, 2],
    [cx, h - 12.5, 3.5, 1.7],
    [cx + (v % 2 ? -1 : 1), h - 15.5, 2.5, 1.5],
  ]
  for (const [x, y, rx, ry] of stones) {
    oval(c, x, y, rx, ry, STONE.dk)
    oval(c, x - 0.5, y - 0.5, rx - 1, ry - 0.6, STONE.md)
    px(c, x - rx + 2, y - 1, STONE.lt)
  }
  oval(c, cx, h - 18.5, 2, 1.3, STONE.white)
  px(c, cx - 1, h - 19, '#ffffff')
  px(c, cx + 2, h - 6, P.moss.md)
  px(c, cx - 3, h - 5, P.moss.lt)
  outline(c, w, h)
  shadow(c, cx + 2, h - 2, 6, 1)
}

const drawFern: Draw = (c, _rnd, w, h, v) => {
  const cx = Math.floor(w / 2)
  const base = h - 1
  const fronds = 5 + (v % 2)
  for (let f = 0; f < fronds; f++) {
    const a = -Math.PI / 2 + ((f / (fronds - 1)) - 0.5) * 2.5
    const len = 6 + ((f + v) % 3)
    for (let i = 1; i <= len; i++) {
      const droop = (i * i) / (len * 2.2)
      const x = cx + Math.cos(a) * i
      const y = base + Math.sin(a) * i * 0.85 + droop
      const lit = Math.cos(a) < 0
      px(c, x, y, i > len - 2 ? P.moss.hi : lit ? P.moss.lt : P.moss.md)
      // Leaflets off the frond.
      if (i % 2 === 0 && i < len) px(c, x + (Math.cos(a) < 0 ? -1 : 1) * 0.6, y - 1, lit ? P.moss.hi : P.moss.lt)
    }
  }
  px(c, cx, base, P.moss.dk)
  px(c, cx - 1, base, P.moss.dk)
}

const drawGrass: Draw = (c, _rnd, _w, h, v) => {
  const blades: [number, number][] = [[1, 5], [3, 7], [5, 6], [7, 8], [9, 5]]
  for (const [x, hgt] of blades) {
    const lean = h01(x, hgt, v) < 0.5 ? -1 : 1
    for (let i = 0; i < hgt; i++) px(c, x + (i > hgt - 3 ? lean : 0), h - 1 - i, i > hgt - 3 ? P.moss.hi : i < 2 ? P.moss.dk : P.moss.lt)
  }
}

const drawFlowers: Draw = (c, _rnd, _w, h, v) => {
  const cols = v % 2 ? ['#f2ecd8', '#8fb8ff', '#f2ecd8'] : ['#ffd24a', '#f2ecd8', '#c8a0e8']
  const spots: [number, number][] = [[2, 3], [5, 1], [8, 3], [4, 5], [9, 0]]
  spots.forEach(([x, y], i) => {
    px(c, x, y + 1, P.moss.md)
    px(c, x, y + 2, P.moss.dk)
    px(c, x, y, cols[i % cols.length])
  })
  void h
}

/** Turncaps: tilted caps on pale stems, leaning west (flip: east). */
const drawTurncaps: Draw = (c, _rnd, w, h, v) => {
  const caps: [number, number][] = v % 2 ? [[3, 6], [7, 8], [10, 5]] : [[2, 5], [6, 7], [9, 6], [11, 4]]
  for (const [x, hgt] of caps) {
    if (x >= w) continue
    const base = h - 1
    // Stem bowing toward the lean.
    for (let i = 0; i < hgt - 2; i++) px(c, x - (i > hgt - 4 ? 1 : 0), base - i, i < 1 ? CAP.stemDk : CAP.stem)
    const top = base - hgt + 1
    const cx = x - 1
    // The cap tips down on the leaning side.
    rect(c, cx - 2, top + 1, 4, 1, CAP.md)
    rect(c, cx - 1, top, 3, 1, CAP.lt)
    px(c, cx - 1, top, CAP.hi)
    px(c, cx - 3, top + 2, CAP.dk)
    px(c, cx - 2, top + 2, CAP.gill)
    px(c, cx + 2, top + 1, CAP.dk)
  }
  outline(c, w, h)
}

const drawRoots: Draw = (c, _rnd, w, h, v) => {
  // Roots creeping down onto the path from the trunk above.
  const strands = 3
  for (let s = 0; s < strands; s++) {
    let x = 4 + s * 4 + (v % 2)
    for (let y = 0; y < h - 2 - s * 2; y++) {
      px(c, x, y, y < 3 ? BARK.md : BARK.dk)
      if (y < 4) px(c, x + 1, y, BARK.xd)
      if (h01(s, y, v) < 0.35) x += s === 0 ? -1 : s === 2 ? 1 : h01(y, s, v) < 0.5 ? -1 : 1
      x = Math.max(0, Math.min(w - 1, x))
    }
  }
}

const drawLitter: Draw = (c, _rnd, w, h, v) => {
  const cols = ['#a8642e', '#c48a3c', '#7a4a26', '#d8a050']
  for (let i = 0; i < 9; i++) {
    const x = Math.floor(h01(i, 1, v) * (w - 2)) + 1
    const y = Math.floor(h01(i, 2, v) * (h - 2)) + 1
    const col = cols[i % cols.length]
    px(c, x, y, col)
    if (i % 3 === 0) px(c, x + 1, y, col)
  }
  // A twig.
  for (let i = 0; i < 5; i++) px(c, 3 + i, h - 3 - (i > 2 ? 1 : 0), WOOD.dk)
}

const drawPebbles: Draw = (c, _rnd, w, h, v) => {
  for (let i = 0; i < 4; i++) {
    const x = 1 + Math.floor(h01(i, 3, v) * (w - 3))
    const y = 1 + Math.floor(h01(i, 4, v) * (h - 3))
    px(c, x, y, STONE.lt)
    px(c, x + 1, y, STONE.md)
    px(c, x, y + 1, STONE.dk)
  }
}

const drawReeds: Draw = (c, _rnd, w, h, v) => {
  // Reeds at the water's edge: tall blades, a few bulrush heads.
  const stems: [number, number][] = v % 2 ? [[2, 10], [4, 13], [6, 9], [8, 12], [11, 10]] : [[1, 9], [3, 12], [6, 13], [9, 10], [12, 11]]
  for (const [x, hgt] of stems) {
    const lean = h01(x, hgt, v) < 0.5 ? -1 : 1
    for (let i = 0; i < hgt; i++) px(c, x + (i > hgt - 4 ? lean : 0), h - 1 - i, i > hgt - 3 ? P.moss.hi : i < 3 ? P.moss.dk : P.moss.md)
    if (hgt >= 12) {
      rect(c, x + lean, h - hgt - 1, 1, 3, P.reedHead)
      px(c, x + lean, h - hgt - 2, P.moss.lt)
    }
  }
  void w
}

const DRAW: Record<DecorKind, Draw> = {
  oak: drawOak,
  pine: drawPine,
  birch: drawBirch,
  'iron-oak': drawIronOak,
  snag: drawSnag,
  thicket: drawThicket,
  stump: drawStump,
  'ring-stump': drawRingStump,
  log: drawLog,
  boulder: drawBoulder,
  cairn: drawCairn,
  fern: drawFern,
  grass: drawGrass,
  flowers: drawFlowers,
  turncaps: drawTurncaps,
  reeds: drawReeds,
  roots: drawRoots,
  litter: drawLitter,
  pebbles: drawPebbles,
}

/**
 * Draw every decor piece into one atlas texture (frames `<kind>-<n>`) the
 * first time a look is shown: hundreds of trees sharing one texture batch
 * into a single draw, where separate textures would not. One atlas per look
 * (the Tangle, the outer drift in each Mark): see ./wilds-looks.ts.
 */
export function ensureTangleAtlas(scene: Phaser.Scene, key: string): boolean {
  const look = lookForAtlas(key)
  if (!look) return false
  if (scene.textures.exists(key)) return true
  const kinds = Object.keys(DRAW) as DecorKind[]
  const pad = 1
  const width = Math.max(...kinds.map((k) => (DECOR_ART[k].w + pad) * TANGLE_VARIANTS)) + pad
  const height = kinds.reduce((sum, k) => sum + DECOR_ART[k].h + pad, pad)
  const atlas = document.createElement('canvas')
  atlas.width = width
  atlas.height = height
  const ac = atlas.getContext('2d')!
  ac.imageSmoothingEnabled = false
  const frames: [string, number, number, number, number][] = []
  P = look.decor
  let y = pad
  for (const kind of kinds) {
    const { w, h } = DECOR_ART[kind]
    for (let v = 0; v < TANGLE_VARIANTS; v++) {
      // Each piece draws on its own canvas (outlines read the whole canvas).
      const piece = document.createElement('canvas')
      piece.width = w
      piece.height = h
      const c = piece.getContext('2d', { willReadFrequently: true })!
      c.imageSmoothingEnabled = false
      const name = tangleFrame(kind, v)
      DRAW[kind](c, seeded(strHash(name)), w, h, v)
      const x = pad + v * (w + pad)
      ac.drawImage(piece, x, y)
      frames.push([name, x, y, w, h])
    }
    y += h + pad
  }
  const texture = scene.textures.addCanvas(key, atlas)!
  for (const [name, x, fy, w, h] of frames) texture.add(name, 0, x, fy, w, h)
  return true
}

// ---------------------------------------------------------------- ground

type Cat = 'woods' | 'moss' | 'path' | 'trodden' | 'road' | 'water'

const GROUND_CAT: Record<number, Cat> = {
  [TANGLE_GROUND.woods]: 'woods',
  [TANGLE_GROUND.moss]: 'moss',
  [TANGLE_GROUND.verge]: 'moss',
  [TANGLE_GROUND.path]: 'moss',
  [TANGLE_GROUND.trodden]: 'trodden',
  [TANGLE_GROUND.road]: 'road',
  [TANGLE_GROUND.water]: 'water',
}

/** 4×4 Bayer matrix (0..15) for ordered dithering. */
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5]
const bayer = (x: number, y: number) => (BAYER[(y & 3) * 4 + (x & 3)] + 0.5) / 16

/**
 * Paint a Tangle chunk's ground (plus the fogged margin of woods around it)
 * into one canvas texture and place it under everything.
 */
export function buildTangleGround(scene: Phaser.Scene, world: WorldData): void {
  const look = wildsLook(world.groundStyle === 'outer' ? 'outer' : 'tangle', world.groundMark)
  const G = look.ground
  const S = TILE
  const W = world.width
  const H = world.height
  const ox = MARGIN_X * S
  const oy = MARGIN_Y * S
  const cw = (W + 2 * MARGIN_X) * S
  const chh = (H + 2 * MARGIN_Y) * S
  const seed = strHash(world.areaId)
  const warpA = valueNoise(seed ^ 0x9e3779b9)
  const warpB = valueNoise(seed ^ 0x7f4a7c15)
  const shadeN = valueNoise(seed ^ 0x1b873593)
  const dapple = valueNoise(seed ^ 0xcc9e2d51)
  const litter = valueNoise(seed ^ 0x2c1b3c6d)
  const quiet = valueNoise(seed ^ 0x6a09e667)

  const inside = (tx: number, ty: number) => tx >= 0 && ty >= 0 && tx < W && ty < H
  const solidAt = (tx: number, ty: number): boolean => (inside(tx, ty) ? world.solid[ty][tx] : !outsideExit(world, tx, ty))
  const catAt = (tx: number, ty: number): Cat => {
    if (!inside(tx, ty)) return outsideExit(world, tx, ty) ? 'moss' : 'woods'
    return GROUND_CAT[world.ground[ty][tx]] ?? 'moss'
  }
  // The trodden line: 1 on a path's centre tiles, a little on its verges,
  // sampled smoothly per pixel so a stepped route reads as a winding trail.
  const trailAt = (tx: number, ty: number): number => {
    if (!inside(tx, ty)) {
      const k = exitColumn(world, tx, ty)
      return k === 1 ? 1 : k >= 0 ? 0.2 : 0
    }
    const g = world.ground[ty][tx]
    return g === TANGLE_GROUND.path ? 1 : g === TANGLE_GROUND.verge ? 0.2 : 0
  }
  // Openness per tile (share of the 3×3 that is walkable), sampled smoothly
  // per pixel: ground near the trees sits in their shade.
  const tw = W + 2 * MARGIN_X
  const th = H + 2 * MARGIN_Y
  const open = new Float32Array(tw * th)
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      let n = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (!solidAt(x - MARGIN_X + dx, y - MARGIN_Y + dy)) n++
      open[y * tw + x] = n / 9
    }
  const openAt = (wx: number, wy: number): number => {
    const fx = wx / S - 0.5 + MARGIN_X
    const fy = wy / S - 0.5 + MARGIN_Y
    const x0 = Math.max(0, Math.min(tw - 2, Math.floor(fx)))
    const y0 = Math.max(0, Math.min(th - 2, Math.floor(fy)))
    const ax = Math.max(0, Math.min(1, fx - x0))
    const ay = Math.max(0, Math.min(1, fy - y0))
    const a = open[y0 * tw + x0] + (open[y0 * tw + x0 + 1] - open[y0 * tw + x0]) * ax
    const b = open[(y0 + 1) * tw + x0] + (open[(y0 + 1) * tw + x0 + 1] - open[(y0 + 1) * tw + x0]) * ax
    return a + (b - a) * ay
  }

  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = chh
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!
  ctx.imageSmoothingEnabled = false
  const img = ctx.createImageData(cw, chh)
  const out = img.data

  for (let py = 0; py < chh; py++) {
    for (let px0 = 0; px0 < cw; px0++) {
      const wx = px0 - ox
      const wy = py - oy
      // Ragged edges: look the category up through a wobbly lens.
      const jx = (warpA(wx / 7, wy / 7) - 0.5) * 7 + (h01(wx, wy, 1) - 0.5) * 1.5
      const jy = (warpB(wx / 7, wy / 7) - 0.5) * 7 + (h01(wx, wy, 2) - 0.5) * 1.5
      const tx = Math.floor((wx + jx) / S)
      const ty = Math.floor((wy + jy) / S)
      let cat = catAt(tx, ty)
      let trail = 0
      if (cat === 'moss' || cat === 'woods') {
        const fx = (wx + jx * 0.6) / S - 0.5
        const fy = (wy + jy * 0.6) / S - 0.5
        const x0 = Math.floor(fx)
        const y0 = Math.floor(fy)
        const ax = fx - x0
        const ay = fy - y0
        const a = trailAt(x0, y0) + (trailAt(x0 + 1, y0) - trailAt(x0, y0)) * ax
        const b = trailAt(x0, y0 + 1) + (trailAt(x0 + 1, y0 + 1) - trailAt(x0, y0 + 1)) * ax
        trail = a + (b - a) * ay
        if (trail > 0.5) cat = 'path'
      }
      const ramp = G[cat]
      const n = h01(wx, wy, 5)
      // Base tone: a soft low-frequency wash plus per-pixel grain.
      let level = 1.6 + (shadeN(wx / 18, wy / 18) - 0.5) * 2.2 + (n - 0.5) * (cat === 'woods' ? 0.9 : 0.5)
      if (cat !== 'woods') {
        // Shade near the trees; sun-flecks where the canopy opens.
        const o = openAt(wx, wy)
        level += (o - 0.75) * 3.2
        if (dapple(wx / 10, wy / 10) > 0.66 + (bayer(wx, wy) - 0.5) * 0.08) level += 1.2
        level += 1
      }
      let col: RGB = ramp[Math.max(0, Math.min(ramp.length - 1, Math.round(level + (bayer(wx, wy) - 0.5) * 0.6)))]

      if (cat === 'woods') {
        // Leaf litter lies in drifts, not as even speckle.
        if (n < 0.35 && litter(wx / 6, wy / 6) > G.litterAmount) col = G.litter[Math.floor(h01(wx, wy, 6) * G.litter.length)]
        else if (n > 0.95) col = G.mossFleck[Math.floor(h01(wx, wy, 7) * G.mossFleck.length)]
      } else if (cat === 'moss') {
        if (n > 0.96) col = G.grassFleck[Math.floor(h01(wx, wy, 8) * G.grassFleck.length)]
        else if (n < 0.2 && litter(wx / 6, wy / 6) > G.litterAmount + 0.1) col = G.litter[Math.floor(h01(wx, wy, 6) * G.litter.length)]
      } else if (cat === 'path' || cat === 'trodden') {
        // Moss creeps in at the trail's edge; pebbles and ruts on the tread.
        if (cat === 'path' && trail < 0.57 && n < 0.5) col = G.moss[Math.max(0, Math.min(5, Math.round(level)))]
        else if (n > 0.988) col = G.pebble
        else if (n < 0.012) col = ramp[0]
      } else if (cat === 'road') {
        // Broken cobbles: gaps grow toward the road's ragged edges.
        const fray = catAt(Math.floor((wx + jx * 1.8) / S), Math.floor((wy + jy * 1.8) / S)) !== 'road'
        col = (fray && n < 0.7 ? null : cobble(wx, wy, level, G)) ?? (solidAt(Math.floor(wx / S), Math.floor(wy / S)) ? G.woods : G.path)[Math.max(0, Math.min(4, Math.round(level - 0.5)))]
      } else if (cat === 'water') {
        // Still water: darker at the bank, a few bright ripple lines.
        const o = openAt(wx, wy)
        const t = Math.round(1.5 + (shadeN(wx / 9, wy / 9) - 0.5) * 2 + o * 1.5 + (bayer(wx, wy) - 0.5) * 0.6)
        col = G.water[Math.max(0, Math.min(G.water.length - 2, t))]
        if (h01(Math.floor(wx / 4), wy, 21) < 0.08 && wy % 3 === 0) col = G.water[G.water.length - 1]
      }
      // The white quiet: pale drifts lying across the outer Wilds.
      if (G.mist && cat !== 'water') {
        const q = quiet(wx / 26, wy / 26) + (bayer(wx, wy) - 0.5) * 0.08
        if (q > 0.62) {
          const a = q > 0.72 ? 0.28 : 0.15
          col = [Math.round(col[0] + (G.mist[0] - col[0]) * a), Math.round(col[1] + (G.mist[1] - col[1]) * a), Math.round(col[2] + (G.mist[2] - col[2]) * a)]
        }
      }
      const i = (py * cw + px0) * 4
      out[i] = col[0]
      out[i + 1] = col[1]
      out[i + 2] = col[2]
      out[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)

  // The woods beyond the chunk: trees drawn straight into the ground canvas.
  paintMarginTrees(scene, ctx, world, seed, look.atlas)
  fogMargin(ctx, cw, chh, W, H)

  const key = `ground-${world.areaId}-${look.atlas}`
  if (scene.textures.exists(key)) scene.textures.remove(key)
  scene.textures.addCanvas(key, canvas)
  scene.add.image(-ox, -oy, key).setOrigin(0, 0).setDepth(-10)
}

/** Broken cobbles of the old road: rows of stones, mossy joints, gaps. */
function cobble(wx: number, wy: number, level: number, G: GroundPalette): RGB | null {
  const row = Math.floor(wy / 5)
  const shift = (row % 2) * 3
  const col = Math.floor((wx + shift) / 6)
  const cx = (wx + shift) - col * 6
  const cy = wy - row * 5
  if (h01(col, row, 11) < 0.3) return null
  if (cx === 0 || cy === 0) return h01(wx, wy, 12) < 0.7 ? G.jointMoss[Math.floor(h01(wx, wy, 13) * 2)] : G.mortar
  // Moss grown over part of a stone.
  if (h01(col, row, 15) < 0.25 && h01(wx, wy, 16) < 0.6) return G.jointMoss[Math.floor(h01(wx, wy, 17) * 2)]
  const tone = Math.round(level - 1 + (h01(col, row, 14) - 0.5) * 2 + (cy === 1 ? 1 : cy === 4 ? -1 : 0))
  return G.road[Math.max(0, Math.min(G.road.length - 1, tone))]
}

/**
 * Outside the chunk, where an exit's path carries on into the woods: the
 * column across the gap (0..2), or -1 elsewhere.
 */
function exitColumn(world: WorldData, tx: number, ty: number): number {
  for (const e of world.exits) {
    if (e.tw > e.th) {
      if (tx < e.tx || tx >= e.tx + e.tw) continue
      if ((e.ty === 0 && ty < 0) || (e.ty === world.height - 1 && ty >= world.height)) return tx - e.tx
    } else {
      if (ty < e.ty || ty >= e.ty + e.th) continue
      if ((e.tx === 0 && tx < 0) || (e.tx === world.width - 1 && tx >= world.width)) return ty - e.ty
    }
  }
  return -1
}

const outsideExit = (world: WorldData, tx: number, ty: number): boolean => exitColumn(world, tx, ty) >= 0

const MARGIN_KINDS: DecorKind[] = ['oak', 'oak', 'oak', 'pine', 'pine', 'iron-oak', 'birch', 'thicket']

function paintMarginTrees(scene: Phaser.Scene, ctx: C, world: WorldData, seed: number, atlasKey: string): void {
  const rnd = seeded(seed ^ 0x51ed270b)
  const W = world.width
  const H = world.height
  const spots: { kind: DecorKind; x: number; y: number; v: number; flip: boolean }[] = []
  for (let ty = -MARGIN_Y; ty < H + MARGIN_Y + 2; ty++) {
    for (let tx = -MARGIN_X; tx < W + MARGIN_X; tx++) {
      if (tx >= 0 && ty >= 0 && tx < W && ty < H) continue
      if (outsideExit(world, tx, ty) || outsideExit(world, tx - 1, ty) || outsideExit(world, tx + 1, ty) || outsideExit(world, tx, ty - 1)) continue
      if (rnd() < 0.12) continue
      const kind = MARGIN_KINDS[Math.floor(rnd() * MARGIN_KINDS.length)]
      spots.push({ kind, x: tx * TILE + 8 + Math.round((rnd() - 0.5) * 8), y: (ty + 1) * TILE - Math.round(rnd() * 4), v: Math.floor(rnd() * TANGLE_VARIANTS), flip: rnd() < 0.5 })
    }
  }
  spots.sort((a, b) => a.y - b.y)
  const ox = MARGIN_X * TILE
  const oy = MARGIN_Y * TILE
  // Only ever paint outside the chunk: inside, the trees are real sprites.
  ctx.save()
  ctx.beginPath()
  ctx.rect(0, 0, ctx.canvas.width, ctx.canvas.height)
  ctx.rect(ox, oy, W * TILE, H * TILE)
  ctx.clip('evenodd')
  ensureTangleAtlas(scene, atlasKey)
  const src = scene.textures.get(atlasKey).getSourceImage() as CanvasImageSource
  for (const s of spots) {
    const f = scene.textures.getFrame(atlasKey, tangleFrame(s.kind, s.v))
    const dx = Math.round(s.x + ox - f.cutWidth / 2)
    const dy = Math.round(s.y + oy - f.cutHeight)
    if (s.flip) {
      ctx.save()
      ctx.scale(-1, 1)
      ctx.drawImage(src, f.cutX, f.cutY, f.cutWidth, f.cutHeight, -dx - f.cutWidth, dy, f.cutWidth, f.cutHeight)
      ctx.restore()
    } else ctx.drawImage(src, f.cutX, f.cutY, f.cutWidth, f.cutHeight, dx, dy, f.cutWidth, f.cutHeight)
  }
  ctx.restore()
}

/** Fade the margin into the scene's clear colour, in dithered steps. */
function fogMargin(ctx: C, cw: number, chh: number, W: number, H: number): void {
  const img = ctx.getImageData(0, 0, cw, chh)
  const d = img.data
  const ox = MARGIN_X * TILE
  const oy = MARGIN_Y * TILE
  for (let y = 0; y < chh; y++) {
    for (let x = 0; x < cw; x++) {
      const wx = x - ox
      const wy = y - oy
      const dx = wx < 0 ? -wx / (MARGIN_X * TILE) : wx >= W * TILE ? (wx - W * TILE) / (MARGIN_X * TILE) : 0
      const dy = wy < 0 ? -wy / (MARGIN_Y * TILE) : wy >= H * TILE ? (wy - H * TILE) / (MARGIN_Y * TILE) : 0
      const dist = Math.max(dx * 1.1, dy)
      if (dist <= 0.04) continue
      const steps = 5
      const f = Math.min(1, Math.floor(Math.min(1, dist * 1.15) * steps + bayer(x, y)) / steps)
      const i = (y * cw + x) * 4
      const a = f * 0.94
      d[i] = Math.round(d[i] + (VOID[0] - d[i]) * a)
      d[i + 1] = Math.round(d[i + 1] + (VOID[1] - d[i + 1]) * a)
      d[i + 2] = Math.round(d[i + 2] + (VOID[2] - d[i + 2]) * a)
      d[i + 3] = 255
    }
  }
  ctx.putImageData(img, 0, 0)
}
