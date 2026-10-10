/**
 * Code-drawn pixel art for the Commons and homesteads, in the game's own
 * style (src/game/textures.ts): 1 px dark outlines, warm palette, crisp
 * nearest-neighbour. Nothing here is a third-party asset.
 *
 * Only what the Commons pass doesn't deliver is drawn here (the delivered
 * art always ships: ./commons-pass.ts, ./commons-pass-install.ts, which also
 * builds the composites). Hedge and fence runs compose its modular pieces;
 * the room walls are drawn here and the delivered back wall and floor are
 * laid over them.
 *
 * Textures are generated once at boot (BootScene) except the hedge and fence
 * runs, which are made on demand for their length (`ensureSceneryTexture`).
 * If a texture with the same key was loaded from a file first, it wins.
 */
import type Phaser from 'phaser'
import { blitFrame, commonsFrame } from './commons-pass.ts'
import { addArtCanvas, artCanvas, artDensity, artSource, drawArt } from './density.ts'
import { ROOM_HEARTH } from './cottage.ts'
import { hash01 } from '../lib/hash.ts'

type C = CanvasRenderingContext2D

const O = '#3a2a28'
const WOOD = { hi: '#c49a62', lt: '#a8804e', md: '#8a6642', dk: '#6b4c2e', xd: '#4a3220' }
const OAK = { hi: '#9a7448', lt: '#7e5c3a', md: '#654628', dk: '#4a3220', xd: '#33221a' }
const STONE = { hi: '#cfc6b6', lt: '#b0a796', md: '#958c7d', dk: '#7a7264', xd: '#5c564c' }
const LEAF = { hi: '#9cc46a', lt: '#7fb35c', md: '#5f8f4c', dk: '#4a7339', xd: '#335527' }
const FLAME = { core: '#fff3c4', hi: '#ffd24a', md: '#f29a3a', dk: '#c4542a' }
const GLOW = '#ffd98a'
const CREAM = '#efe2c0'

function rect(c: C, x: number, y: number, w: number, h: number, col: string): void {
  if (w <= 0 || h <= 0) return
  c.fillStyle = col
  c.fillRect(x, y, w, h)
}

/** Filled box with a 1 px outline. */
function box(c: C, x: number, y: number, w: number, h: number, fill: string, line = O): void {
  rect(c, x, y, w, h, line)
  rect(c, x + 1, y + 1, w - 2, h - 2, fill)
}

function px(c: C, x: number, y: number, col: string): void {
  rect(c, x, y, 1, 1, col)
}

/** Pixel-perfect filled disc (no anti-aliasing). */
function disc(c: C, cx: number, cy: number, r: number, col: string): void {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) if (x * x + y * y <= r * r + r * 0.6) px(c, Math.round(cx + x), Math.round(cy + y), col)
}

/** Pixel-perfect filled ellipse. */
function oval(c: C, cx: number, cy: number, rx: number, ry: number, col: string): void {
  for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) if ((x * x) / (rx * rx + 0.3) + (y * y) / (ry * ry + 0.3) <= 1) px(c, Math.round(cx + x), Math.round(cy + y), col)
}

/** Pixel rows → canvas, palette by character ('.' is clear). */
function paint(c: C, rows: string[], pal: Record<string, string>, ox = 0, oy = 0): void {
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const col = pal[row[x]]
      if (col) px(c, ox + x, oy + y, col)
    }
  })
}

/**
 * A `w`×`h` world-px texture drawn by `draw` in world px; `density` texels
 * a world px (./density.ts) when it composes delivered art.
 */
function makeTexture(scene: Phaser.Scene, key: string, w: number, h: number, draw: (c: C) => void, density = 1): void {
  if (scene.textures.exists(key)) return
  const [canvas, c] = artCanvas(w, h, density)
  draw(c)
  addArtCanvas(scene, key, canvas, density)
}

/** Outline a drawn silhouette: every clear pixel touching a filled one becomes O. */
function outline(c: C, w: number, h: number): void {
  const img = c.getImageData(0, 0, w, h)
  const d = img.data
  const filled = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && d[(y * w + x) * 4 + 3] > 0
  const edge: number[] = []
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (!filled(x, y) && (filled(x + 1, y) || filled(x - 1, y) || filled(x, y + 1) || filled(x, y - 1))) edge.push(x, y)
  for (let i = 0; i < edge.length; i += 2) px(c, edge[i], edge[i + 1], O)
}

// ---------------------------------------------------------------- hedges & fences

const HEDGE = { hi: '#9ad65e', lt: '#5fae3c', md: '#3d8a2e', dk: '#2a6424', xd: '#183e18' }

function drawHedge(c: C, w: number, h: number, vertical: boolean): void {
  // A clipped field hedge: a lumpy crown of leaf clumps over a shaded face.
  const top = 7
  rect(c, 1, top + 2, w - 2, h - top - 3, HEDGE.md)
  const clumps: [number, number, number][] = []
  if (vertical) {
    for (let y = top; y < h - 7; y += 5) {
      clumps.push([4 + Math.round(hash01(1, y) * 2), y + 2, 4])
      clumps.push([w - 5 - Math.round(hash01(2, y) * 2), y + 4, 4])
      clumps.push([w / 2, y + 3, 4])
    }
  } else {
    for (let x = 2; x < w - 1; x += 6) {
      clumps.push([x + Math.round(hash01(x, 1) * 3), top + 1 + Math.round(hash01(x, 2) * 2), 4 + (hash01(x, 3) < 0.35 ? 1 : 0)])
      clumps.push([x + 3, top + 6 + Math.round(hash01(x, 4) * 2), 4])
    }
  }
  // Each clump casts a dark rim below-right, then is lit from the upper left.
  clumps.sort((a, b) => a[1] - b[1])
  for (const [x, y, r] of clumps) {
    disc(c, x + 1, y + 1, r, HEDGE.xd)
    for (let dy = -r; dy <= r; dy++)
      for (let dx = -r; dx <= r; dx++) {
        const d = dx * dx + dy * dy
        if (d > r * r) continue
        const lit = -dx - dy * 1.4
        const n = hash01(x + dx, y + dy, 6)
        const col = lit > r * 1.1 ? (n < 0.55 ? HEDGE.hi : HEDGE.lt) : lit > 0 ? (n < 0.45 ? HEDGE.lt : HEDGE.md) : lit < -r * 0.8 ? HEDGE.dk : n < 0.25 ? HEDGE.dk : HEDGE.md
        px(c, x + dx, y + dy, col)
      }
  }
  // The shaded face under the crown, rooted in darker soil.
  const img = c.getImageData(0, 0, w, h).data
  const at = (x: number, y: number) => img[(y * w + x) * 4 + 3] > 0
  for (let x = 1; x < w - 1; x++) {
    for (let y = h - 6; y < h - 1; y++) if (at(x, y)) px(c, x, y, y >= h - 3 ? HEDGE.xd : hash01(x, y, 8) < 0.4 ? HEDGE.dk : HEDGE.md)
  }
  // A few blossoms so long hedges don't read as a wall.
  for (let i = 0; i < w * h; i += 131) {
    const x = 2 + Math.floor(hash01(i, 7) * (w - 4))
    const y = top + Math.floor(hash01(i, 8) * Math.max(1, h - top - 9))
    if (at(x, y) && hash01(i, 9) < 0.4) px(c, x, y, hash01(i, 10) < 0.5 ? '#fff3d6' : '#e891ac')
  }
  outline(c, w, h)
}

function drawFenceH(c: C, w: number): void {
  // Two rails, a post at each tile's middle.
  for (const y of [5, 10]) {
    rect(c, 0, y, w, 3, O)
    rect(c, 0, y + 1, w, 1, WOOD.lt)
    rect(c, 0, y + 2, w, 0, WOOD.md)
  }
  for (let x = 6; x < w; x += 16) {
    box(c, x, 2, 4, 14, WOOD.md)
    rect(c, x + 1, 3, 2, 1, WOOD.hi)
    rect(c, x + 1, 13, 2, 2, WOOD.dk)
  }
}

function drawFenceV(c: C, h: number): void {
  rect(c, 6, 0, 4, h, O)
  rect(c, 7, 0, 2, h, WOOD.lt)
  rect(c, 8, 0, 1, h, WOOD.md)
  for (let y = 4; y < h; y += 16) {
    box(c, 5, y, 6, 9, WOOD.md)
    rect(c, 6, y + 1, 4, 2, WOOD.hi)
    rect(c, 6, y + 6, 4, 2, WOOD.dk)
  }
}

/**
 * Run keys: `hedge-h-<n>`, `hedge-v-<n>`, `fence-h-<n>`, `fence-v-<n>`. A
 * back hedge that turns down the plot's outer side says which end turns:
 * `-turnw` (its west end) or `-turne` (its east end).
 */
const RUN = /^(hedge|fence)-(h|v)-(\d+)(?:-(turnw|turne))?$/

/** Hedge and fence runs are drawn for their length the first time they're used. */
export function ensureSceneryTexture(scene: Phaser.Scene, key: string): boolean {
  if (scene.textures.exists(key)) return true
  const m = RUN.exec(key)
  if (!m) return false
  const n = Math.max(1, Math.min(64, Number(m[3])))
  const kind = m[1] as 'hedge' | 'fence'
  const dir = m[2] as 'h' | 'v'
  if (deliveredRun(scene, key, kind, dir, n, m[4] as 'turnw' | 'turne' | undefined)) return true
  if (kind === 'hedge') {
    if (dir === 'h') makeTexture(scene, key, n * 16, 22, (c) => drawHedge(c, n * 16, 22, false))
    else makeTexture(scene, key, 16, n * 16 + 6, (c) => drawHedge(c, 16, n * 16 + 6, true))
  } else if (dir === 'h') makeTexture(scene, key, n * 16, 16, (c) => drawFenceH(c, n * 16))
  else makeTexture(scene, key, 16, n * 16, (c) => drawFenceV(c, n * 16))
  return true
}

/**
 * A run from the delivered modular pieces (commons pass), at the same size
 * and anchor as the code-drawn run. Horizontal runs set one piece a tile
 * (corner or end caps at the ends), with the outline each piece carries at
 * a join painted over from its own interior so the run reads as one hedge,
 * or one rail with a post a tile. Vertical runs repeat the middle of the
 * upright piece between its top and its foot (the delivered upright fence
 * piece is a stacked spool, so the fence uses the corner piece's post).
 * False when the pieces didn't load.
 */
function deliveredRun(scene: Phaser.Scene, key: string, kind: 'hedge' | 'fence', dir: 'h' | 'v', n: number, turn?: 'turnw' | 'turne'): boolean {
  const piece = (name: string) => commonsFrame(`${kind}-${name}`)
  // Hedges keep the code-drawn run's 6 px of crown above the top tile.
  const lift = kind === 'hedge' ? 6 : 0
  if (dir === 'v') {
    const upright = piece(kind === 'hedge' ? 'straight-v' : 'corner')
    const src = upright ? artSource(scene, `commons-art:${upright.key}`) : null
    if (!src) return false
    const h = n * 16
    makeTexture(scene, key, 16, h + lift, (c) => {
      if (kind === 'fence') {
        // The corner piece's post (its left 4 px), one a tile, on the old line.
        for (let i = 0; i < n; i++) drawArt(c, src, 6, i * 16, 4, 16, 0, 0, 4, 16)
        return
      }
      // Hedge: the piece's crown, its leafy middle repeated, then its foot.
      drawArt(c, src, 0, lift, 16, 4, 0, 0, 16, 4)
      for (let y = 4; y < h - 4; y += 8) {
        const rows = Math.min(8, h - 4 - y)
        drawArt(c, src, 0, lift + y, 16, rows, 0, 4, 16, rows)
      }
      drawArt(c, src, 0, lift + h - 4, 16, 4, 0, 12, 16, 4)
    }, src.density)
    return true
  }
  const pieces: { name: string; flip?: boolean }[] = []
  for (let i = 0; i < n; i++) {
    if (kind === 'fence') pieces.push(i === 0 && n > 1 ? { name: 'corner' } : i === n - 1 && n > 1 ? { name: 'corner', flip: true } : { name: 'straight-h' })
    else if (n === 1) pieces.push({ name: 'straight-h' })
    else if (i === 0) pieces.push({ name: turn === 'turnw' ? 'corner-se' : 'end-w' })
    else if (i === n - 1) pieces.push({ name: turn === 'turne' ? 'corner-sw' : 'end-e' })
    else pieces.push({ name: 'straight-h' })
  }
  if (!pieces.every((p) => piece(p.name))) return false
  const w = n * 16
  const h = 16 + lift
  const k = artDensity(scene)
  makeTexture(scene, key, w, h, (c) => {
    pieces.forEach((p, i) => {
      const f = piece(p.name)!
      const d = f.destinationRect
      blitFrame(scene, f, c, { x: i * 16 + d.x, y: lift + d.y, w: d.w, h: d.h }, p.flip)
    })
    // In texels: copy world-px columns (k texels each) over the joins.
    const tw = w * k
    const img = c.getImageData(0, 0, tw, h * k)
    const px = img.data
    const copy = (fx: number, tx: number, y: number) => {
      for (let t = 0; t < k; t++) {
        const a = (y * tw + fx * k + t) * 4
        const b = (y * tw + tx * k + t) * 4
        for (let n = 0; n < 4; n++) px[b + n] = px[a + n]
      }
    }
    for (let j = 1; j < n; j++) {
      const at = j * 16
      for (let y = lift * k; y < h * k; y++) {
        if (kind === 'hedge') {
          copy(at - 2, at - 1, y)
          copy(at + 1, at, y)
        } else for (let x = at; x < at + 3; x++) copy(at + 3, x, y)
      }
    }
    c.putImageData(img, 0, 0)
  }, k)
  return true
}

// ---------------------------------------------------------------- Silas's yard & the meadow

function drawStump(c: C): void {
  // Windfall: three leafy branches left at the stump, as the custom runs.
  oval(c, 7, 9, 6, 3, OAK.dk)
  rect(c, 2, 6, 11, 4, OAK.md)
  oval(c, 7, 6, 5, 2, '#c4a074')
  oval(c, 7, 6, 2, 1, '#a8804e')
  px(c, 1, 10, OAK.dk)
  px(c, 13, 10, OAK.dk)
  for (const [x, y] of [[3, 3], [9, 2], [12, 4]]) {
    px(c, x, y + 1, OAK.dk)
    px(c, x - 1, y, LEAF.lt)
    px(c, x, y - 1, LEAF.md)
    px(c, x + 1, y, LEAF.hi)
  }
  outline(c, 15, 12)
}

function drawTallGrass(c: C, seeded: boolean): void {
  const blades = seeded ? [[1, 9], [3, 11], [5, 8], [7, 10], [9, 7]] : [[1, 7], [3, 9], [5, 6], [7, 8]]
  for (const [x, hgt] of blades) {
    const lean = hash01(x, hgt) < 0.5 ? -1 : 1
    for (let i = 0; i < hgt; i++) px(c, x + (i > hgt - 3 ? lean : 0), 12 - i, i > hgt - 4 ? LEAF.hi : i < 3 ? LEAF.dk : LEAF.lt)
    if (seeded && hgt > 8) px(c, x + lean, 12 - hgt, '#d9c48a')
  }
}

function drawWildflowers(c: C): void {
  for (const [x, y, col] of [[1, 4, '#fff3d6'], [4, 2, '#e891ac'], [7, 5, '#8fb8ff'], [3, 6, '#ffd24a'], [8, 2, '#fff3d6']] as const) {
    px(c, x, y + 1, LEAF.dk)
    px(c, x, y + 2, LEAF.md)
    px(c, x, y, col)
  }
}

function drawStake(c: C): void {
  box(c, 2, 2, 3, 12, '#c4a074')
  rect(c, 3, 3, 1, 10, '#e0bb8c')
  rect(c, 5, 3, 3, 2, '#c4523a')
  px(c, 7, 5, '#c4523a')
}

function drawSmallPost(c: C): void {
  box(c, 1, 3, 6, 15, OAK.md)
  rect(c, 2, 4, 2, 13, OAK.lt)
  box(c, 0, 0, 8, 4, OAK.lt)
  rect(c, 1, 1, 6, 1, OAK.hi)
}

function drawCommonsBoard(c: C): void {
  // The Commons board hangs off the south gatepost: a cart wheel burned in.
  rect(c, 3, 0, 1, 4, '#4a4452')
  rect(c, 20, 0, 1, 4, '#4a4452')
  box(c, 0, 3, 24, 13, '#b08a5e')
  rect(c, 1, 4, 22, 1, '#c4a074')
  disc(c, 12, 9, 4, OAK.dk)
  disc(c, 12, 9, 3, '#b08a5e')
  for (const [dx, dy] of [[0, -3], [0, 3], [-3, 0], [3, 0], [-2, -2], [2, 2], [-2, 2], [2, -2]]) px(c, 12 + dx, 9 + dy, OAK.dk)
  px(c, 12, 9, OAK.dk)
  rect(c, 3, 13, 18, 1, '#8a6642')
}

// ---------------------------------------------------------------- the campsite

function drawLogSeat(c: C): void {
  box(c, 0, 2, 14, 6, OAK.md)
  rect(c, 1, 3, 12, 1, OAK.lt)
  disc(c, 2, 5, 1, '#c4a074')
}

function drawCampPatch(c: C): void {
  // Levelled earth: trodden in the middle, grass feathering in at the edge.
  const W = 120
  const H = 76
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const d = ((x - W / 2) / (W / 2)) ** 2 + ((y - H / 2) / (H / 2)) ** 2
      const n = hash01(x >> 1, y >> 1, 21)
      if (d + (n - 0.5) * 0.35 > 1) continue
      const edge = d > 0.7
      px(c, x, y, edge ? (n < 0.5 ? 'rgba(150,112,70,0.55)' : 'rgba(120,150,70,0.45)') : n < 0.12 ? '#9a7a52' : n > 0.9 ? '#c4a074' : '#b08a5e')
    }
}

// ---------------------------------------------------------------- decorations

/** Decoration art, keyed by item id. `w` and `h` are footprint pixels; art may rise above. */
interface DecoArt {
  /** Extra pixels drawn above the footprint (tall things). */
  rise: number
  draw(c: C, w: number, h: number, quarter: boolean): void
}

const DECO: Record<string, DecoArt> = {
  'wooden-stool': {
    rise: 0,
    draw(c) {
      for (const [x, y] of [[3, 10], [11, 10], [7, 13]]) rect(c, x, y, 2, 3, O)
      oval(c, 8, 8, 6, 3, O)
      oval(c, 8, 8, 5, 2, WOOD.lt)
      rect(c, 4, 8, 9, 2, WOOD.md)
      oval(c, 8, 7, 5, 2, WOOD.hi)
      px(c, 6, 7, WOOD.lt)
    }
  },
  'reading-chair': {
    rise: 6,
    draw(c, w, h, quarter) {
      const R = '#8c3f3a'
      const r = '#b05a4c'
      const k = '#6e2e2a'
      if (!quarter) {
        // Facing you: high back, rolled arms, a footstool in front.
        box(c, 1, 0, 14, 12, R)
        rect(c, 2, 1, 12, 3, r)
        box(c, 0, 8, 16, 11, R)
        box(c, 0, 7, 4, 12, k)
        box(c, 12, 7, 4, 12, k)
        rect(c, 4, 9, 8, 4, r)
        for (const x of [1, 13]) rect(c, x, 19, 2, 2, O)
        box(c, 3, 25, 10, 7, R)
        rect(c, 4, 26, 8, 2, r)
        for (let x = 5; x < 12; x += 3) px(c, x, 29, '#efe2c0')
      } else {
        // Side on: the back to the left, the stool to the right.
        box(c, 0, 0, 6, 20, R)
        rect(c, 1, 1, 2, 18, r)
        box(c, 4, 7, 13, 13, R)
        box(c, 4, 4, 12, 5, k)
        rect(c, 6, 10, 10, 3, r)
        box(c, 22, 9, 9, 9, R)
        rect(c, 23, 10, 7, 2, r)
      }
      void w
      void h
    }
  },
  'braided-rug': {
    rise: -1,
    draw(c) {
      // Thick wool in old Carting colours: ochre, teal, brick, cream.
      const rings = ['#3a2a28', '#c9922e', '#2f7f7a', '#b25a3c', '#efe2c0', '#c9922e', '#2f7f7a', '#b25a3c']
      rings.forEach((col, i) => oval(c, 15.5, 16, 15 - i * 2, 13 - i * 2, col))
      for (let y = 4; y < 29; y += 2) for (let x = 2; x < 30; x += 3) if (hash01(x, y, 2) < 0.2) px(c, x, y, 'rgba(255,255,255,0.18)')
    }
  },
  'iron-lantern': {
    rise: 6,
    draw(c) {
      box(c, 4, 18, 8, 3, '#4a4452')
      box(c, 3, 6, 10, 13, '#4a4452')
      rect(c, 5, 8, 6, 9, GLOW)
      rect(c, 6, 9, 4, 4, '#fff3c4')
      rect(c, 7, 8, 2, 9, '#4a4452')
      box(c, 5, 2, 6, 5, '#5a5464')
      rect(c, 7, 0, 2, 3, O)
    }
  },
  // A homestead's lantern post: a squared oak post, a crossbar for the name,
  // an amber lamp hung from it (the light that holds the land).
  'lantern-post': {
    rise: 22,
    draw(c) {
      box(c, 4, 34, 8, 4, STONE.md)
      box(c, 6, 6, 4, 30, WOOD.dk)
      rect(c, 7, 7, 1, 28, WOOD.md)
      box(c, 2, 6, 12, 3, WOOD.md)
      rect(c, 11, 9, 1, 3, O)
      box(c, 9, 12, 5, 7, '#4a4452')
      rect(c, 10, 13, 3, 5, GLOW)
      rect(c, 11, 14, 1, 2, '#fff3c4')
    }
  },
  'oak-table': {
    rise: 2,
    draw(c) {
      for (const x of [3, 27]) box(c, x, 18, 3, 13, OAK.dk)
      box(c, 0, 2, 32, 18, OAK.md)
      rect(c, 1, 3, 30, 13, OAK.lt)
      for (let y = 5; y < 16; y += 4) rect(c, 1, y, 30, 1, OAK.md)
      rect(c, 1, 16, 30, 3, OAK.dk)
      // Tea: a brown pot, two cups.
      box(c, 12, 4, 7, 6, '#6b4423')
      rect(c, 13, 5, 4, 1, '#8a5a34')
      rect(c, 19, 6, 2, 1, '#6b4423')
      box(c, 5, 8, 4, 3, CREAM)
      box(c, 23, 6, 4, 3, CREAM)
    }
  },
  'potted-fern': {
    rise: 6,
    draw(c) {
      box(c, 4, 13, 8, 8, '#b25a3c')
      rect(c, 5, 14, 6, 2, '#c4654f')
      for (const [x, y, l] of [[8, 13, -5], [8, 13, 5], [8, 13, -2], [8, 13, 2], [8, 13, 0]] as const) {
        for (let i = 0; i < 9; i++) {
          const fx = Math.round(x + (l * i) / 8)
          const fy = y - i + Math.round(Math.abs(l) * (i / 9) * (i / 9) * 1.4)
          px(c, fx, fy, i > 6 ? LEAF.hi : LEAF.md)
          if (i % 2 === 0) px(c, fx + (l < 0 ? -1 : 1), fy, LEAF.lt)
        }
      }
      outline(c, 16, 22)
    }
  },
  bookshelf: {
    rise: 14,
    draw(c, w, h, quarter) {
      const BOOK = ['#8c3f3a', '#2f7f7a', '#c9922e', '#4a6f9c', '#6b8a3a', '#b25a3c']
      if (!quarter) {
        box(c, 0, 0, 32, 30, OAK.md)
        rect(c, 2, 2, 28, 26, OAK.dk)
        for (const sy of [2, 11, 20]) {
          // Twelve field journals across the shelves: one for every wick.
          for (let i = 0; i < 6; i++) rect(c, 3 + i * 4 + (sy % 3), sy + 1, 3, 7, BOOK[(i + sy) % BOOK.length])
          rect(c, 2, sy + 8, 28, 1, OAK.lt)
        }
      } else {
        box(c, 0, 0, 14, 32, OAK.md)
        rect(c, 2, 2, 10, 28, OAK.dk)
        for (let i = 0; i < 6; i++) rect(c, 3, 3 + i * 4, 8, 3, BOOK[i])
      }
      void w
      void h
    }
  },
  'gate-shelf': {
    rise: 4,
    draw(c) {
      drawGateShelf(c, false)
    }
  },
  'wash-basin': {
    rise: 2,
    draw(c) {
      for (const x of [3, 11]) rect(c, x, 9, 2, 9, O)
      oval(c, 8, 7, 7, 4, O)
      oval(c, 8, 7, 6, 3, '#c9c4bc')
      oval(c, 8, 7, 4, 2, '#6f9fd4')
      px(c, 6, 6, '#cfe3f5')
    }
  },
  'stone-hearth': {
    rise: 10,
    draw(c, w, h, quarter) {
      const ww = quarter ? 16 : 32
      const hh = quarter ? 32 : 26
      box(c, 0, 0, ww, hh, STONE.md)
      for (let y = 2; y < hh - 2; y += 5) for (let x = 1 + ((y / 5) % 2) * 3; x < ww - 1; x += 7) rect(c, x, y, 1, 4, STONE.dk)
      for (let x = 1; x < ww - 1; x++) for (let y = 4; y < hh; y += 5) px(c, x, y, STONE.dk)
      const mx = quarter ? 3 : 8
      const my = quarter ? 10 : 9
      box(c, mx, my, ww - mx * 2, hh - my - 2, '#2a1c18')
      rect(c, mx + 2, hh - 6, ww - mx * 2 - 4, 2, FLAME.md)
      rect(c, mx + 3, hh - 8, ww - mx * 2 - 6, 2, FLAME.hi)
      px(c, ww / 2, hh - 9, FLAME.core)
      void w
      void h
    }
  },
  'carved-bed': {
    rise: 4,
    draw(c) {
      box(c, 0, 0, 32, 34, OAK.md)
      rect(c, 2, 1, 28, 2, OAK.lt)
      // Carved headboard: a fox and a lamp.
      px(c, 9, 2, OAK.xd)
      px(c, 22, 2, OAK.xd)
      rect(c, 2, 5, 28, 26, '#efe2c0')
      box(c, 4, 5, 10, 6, '#fffbef')
      box(c, 18, 5, 10, 6, '#fffbef')
      rect(c, 2, 13, 28, 18, '#6b8a3a')
      for (let x = 2; x < 30; x += 4) for (let y = 14; y < 31; y += 4) rect(c, x + ((y / 4) % 2) * 2, y, 2, 2, '#8aa65a')
      rect(c, 2, 13, 28, 2, '#8aa65a')
    }
  },
  'woven-basket': {
    rise: 0,
    draw(c) {
      box(c, 2, 5, 12, 10, '#b8925a')
      for (let y = 6; y < 14; y++) for (let x = 3; x < 13; x++) if ((x + y) % 3 === 0) px(c, x, y, '#8a6a3e')
      rect(c, 3, 6, 10, 1, '#d8b07a')
      // Spare bootlaces and twine.
      px(c, 5, 4, '#4a3220')
      px(c, 6, 3, '#4a3220')
      px(c, 9, 4, '#c4b48a')
    }
  },
  'display-stand': {
    rise: 8,
    draw(c) {
      box(c, 3, 10, 10, 11, OAK.md)
      rect(c, 4, 11, 8, 2, OAK.lt)
      box(c, 2, 8, 12, 3, OAK.dk)
      // A whittled fox: long ear on the left.
      paint(c, ['.o..o...', '.oo.o...', '.oooo..o', '..ooooo.', '..o..o..'], { o: '#e8d2a6' }, 4, 2)
      px(c, 5, 1, '#e8d2a6')
      px(c, 5, 0, '#e8d2a6')
    }
  },
  'tool-rack': {
    rise: 10,
    draw(c, w, h, quarter) {
      if (!quarter) {
        box(c, 0, 0, 32, 6, OAK.md)
        for (const x of [2, 28]) box(c, x, 0, 3, 26, OAK.dk)
        // Saw, mallet, chisel, plane: clean, as tools should be.
        rect(c, 7, 6, 2, 14, '#b8b8c0')
        rect(c, 6, 5, 4, 3, OAK.lt)
        box(c, 12, 6, 6, 4, OAK.lt)
        rect(c, 14, 10, 2, 9, OAK.md)
        rect(c, 21, 6, 1, 12, '#b8b8c0')
        rect(c, 20, 5, 3, 3, OAK.lt)
        box(c, 24, 8, 4, 8, OAK.lt)
      } else {
        box(c, 0, 0, 8, 32, OAK.md)
        rect(c, 7, 4, 6, 2, '#b8b8c0')
        rect(c, 7, 12, 6, 3, OAK.lt)
        rect(c, 7, 22, 5, 2, '#b8b8c0')
      }
      void w
      void h
    }
  },
  'amber-sconce': {
    rise: 6,
    draw(c) {
      box(c, 5, 14, 6, 7, STONE.md)
      box(c, 3, 11, 10, 4, STONE.lt)
      disc(c, 8, 7, 4, O)
      disc(c, 8, 7, 3, '#e0a52a')
      disc(c, 8, 6, 2, '#ffd24a')
      px(c, 7, 5, '#fff3c4')
    }
  }
}

/** Texture key for a decoration's art at a rotation (90/270 share the side view). */
export function decoKey(itemDef: string, rotation: number): string {
  return rotation === 90 || rotation === 270 ? `deco-${itemDef}-q` : `deco-${itemDef}`
}

/** Whether a decoration lies flat on the floor (drawn under everything). */
export function decoFlat(itemDef: string): boolean {
  return (DECO[itemDef]?.rise ?? 0) < 0
}

function makeDeco(scene: Phaser.Scene, id: string, fw: number, fh: number): void {
  const art = DECO[id]
  if (!art) return
  const rise = Math.max(0, art.rise)
  for (const quarter of [false, true]) {
    const [w, h] = quarter ? [fh * 16, fw * 16] : [fw * 16, fh * 16]
    makeTexture(scene, quarter ? `deco-${id}-q` : `deco-${id}`, w, h + rise, (c) => {
      c.translate(0, 0)
      art.draw(c, w, h + rise, quarter)
    })
  }
}

// ---------------------------------------------------------------- the cottage interior

export const ROOM_W = 14
export const ROOM_H = 14

function drawRoomWalls(c: C): void {
  const W = ROOM_W * 16
  const H = ROOM_H * 16
  // Back wall: timber frame and limewash, with the hearth set into it.
  rect(c, 0, 0, W, 48, '#e8dcc0')
  for (let y = 2; y < 46; y++) for (let x = 0; x < W; x++) if (hash01(x >> 1, y >> 1, 12) < 0.07) px(c, x, y, '#d8c9a2')
  rect(c, 0, 0, W, 4, OAK.dk)
  rect(c, 0, 4, W, 1, OAK.xd)
  for (const x of [16, 64, 152, 200]) {
    rect(c, x - 2, 4, 5, 42, OAK.md)
    rect(c, x - 2, 4, 1, 42, OAK.lt)
  }
  rect(c, 0, 44, W, 4, OAK.md)
  rect(c, 0, 47, W, 1, OAK.xd)
  // Window (left), warm light in four panes, a sill with a jar.
  box(c, 26, 12, 28, 22, OAK.dk)
  rect(c, 28, 14, 24, 18, GLOW)
  rect(c, 28, 14, 24, 6, '#fff3c4')
  rect(c, 39, 14, 2, 18, OAK.dk)
  rect(c, 28, 22, 24, 1, OAK.dk)
  box(c, 24, 33, 32, 4, OAK.md)
  box(c, 46, 29, 5, 5, '#8fb8d8')
  // Shelf (middle) with crocks and a folded blanket.
  box(c, 98, 20, 34, 4, OAK.md)
  box(c, 102, 12, 7, 8, '#c4a074')
  box(c, 112, 14, 6, 6, '#8c3f3a')
  box(c, 121, 11, 8, 9, '#6b8a3a')
  // The hearth (right, where the delivered wall has it): quarried stone,
  // never drift-stone.
  const hx = ROOM_HEARTH.x - 16
  box(c, hx, 2, 48, 46, STONE.md)
  for (let y = 4; y < 46; y += 6) for (let x = hx + 1 + ((y / 6) % 2) * 4; x < hx + 47; x += 9) rect(c, x, y, 1, 5, STONE.dk)
  for (let y = 9; y < 46; y += 6) rect(c, hx + 1, y, 46, 1, STONE.dk)
  box(c, hx + 10, 18, 28, 30, '#2a1c18')
  rect(c, hx + 11, 19, 26, 4, '#3a2a28')
  // Mantel with Silas's fox (long ear left) and two crocks.
  box(c, hx - 4, 14, 56, 5, OAK.md)
  rect(c, hx - 3, 15, 54, 1, OAK.lt)
  paint(c, ['.o...o..', 'ooo.oo..', '.ooooo.o', '..oooooo', '..oo.o..'], { o: '#e8d2a6' }, hx + 20, 8)
  px(c, hx + 20, 8, '#e8d2a6')
  box(c, hx + 4, 9, 5, 5, '#b25a3c')
  box(c, hx + 39, 8, 6, 6, '#4a6f9c')
  // Side walls and the near wall, with the doorway.
  rect(c, 0, 0, 16, H, OAK.dk)
  rect(c, W - 16, 0, 16, H, OAK.dk)
  rect(c, 14, 48, 2, H - 64, OAK.xd)
  rect(c, W - 16, 48, 2, H - 64, OAK.xd)
  for (let y = 56; y < H - 16; y += 24) {
    rect(c, 2, y, 12, 2, OAK.md)
    rect(c, W - 14, y, 12, 2, OAK.md)
  }
  rect(c, 0, H - 16, 96, 16, OAK.dk)
  rect(c, 128, H - 16, W - 128, 16, OAK.dk)
  rect(c, 0, H - 16, 96, 2, OAK.md)
  rect(c, 128, H - 16, W - 128, 2, OAK.md)
  // Doormat in the doorway.
  rect(c, 98, H - 14, 28, 12, '#8a6a3e')
  for (let x = 100; x < 124; x += 3) rect(c, x, H - 12, 1, 8, '#b8925a')
}

// ---------------------------------------------------------------- boot

/** Register every fixed Commons/homestead texture (BootScene, after the game's own). */
function drawGateShelf(c: C, stocked: boolean): void {
  // A rustic wooden shelf on posts by the gate.
  box(c, 2, 4, 2, 16, OAK.dk)
  box(c, 14, 4, 2, 16, OAK.dk)
  box(c, 1, 4, 16, 2, OAK.md)
  box(c, 1, 10, 16, 2, OAK.md)
  box(c, 1, 16, 16, 2, OAK.md)
  for (let i = 0; i < 2; i++) rect(c, i, 2 - i, 18 - i * 2, 2, OAK.lt)
  rect(c, 0, 3, 18, 1, OAK.dk)
  if (stocked) {
    box(c, 3, 1, 4, 3, '#7f9fae')
    px(c, 4, 0, '#4a5560')
    box(c, 11, 1, 4, 3, '#c9922e')
    px(c, 12, 0, '#8a5a34')
    box(c, 4, 7, 4, 3, '#c4523a')
    box(c, 10, 7, 5, 3, '#efe2c0')
    box(c, 5, 13, 3, 3, '#3f8f6b')
    box(c, 11, 13, 4, 3, '#8c5a3c')
  }
}

function drawPondIce(c: C): void {
  // Cloudy ice on the frozen pond, in the Quiet: a pale sheet with a
  // frost-glass glint the pick can bite at.
  const sheet = (ox: number, oy: number, w: number, h: number) => {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const edge = x === 0 || y === 0 || x === w - 1 || y === h - 1
        const cloudy = hash01(x + ox, y + oy, 7)
        px(c, ox + x, oy + y, edge ? O : cloudy < 0.3 ? '#9cc3d8' : cloudy < 0.85 ? '#c3dcea' : '#fffbef')
      }
  }
  sheet(2, 3, 11, 6)
  sheet(7, 8, 8, 4)
  px(c, 9, 5, '#fffbef')
  px(c, 10, 5, '#fffbef')
}

export function generateCommonsArt(scene: Phaser.Scene): void {
  makeTexture(scene, 'gate-shelf', 18, 20, (c) => drawGateShelf(c, false))
  makeTexture(scene, 'gate-shelf-stocked', 18, 20, (c) => drawGateShelf(c, true))
  makeTexture(scene, 'pond-ice', 16, 13, drawPondIce)
  makeTexture(scene, 'stump', 15, 12, drawStump)
  makeTexture(scene, 'tall-grass-a', 10, 13, (c) => drawTallGrass(c, false))
  makeTexture(scene, 'tall-grass-b', 11, 13, (c) => drawTallGrass(c, true))
  makeTexture(scene, 'wildflowers', 10, 8, drawWildflowers)
  makeTexture(scene, 'stake', 8, 14, drawStake)
  makeTexture(scene, 'gatepost-small', 8, 18, drawSmallPost)
  makeTexture(scene, 'commons-board', 24, 17, drawCommonsBoard)
  makeTexture(scene, 'camp-logseat', 14, 8, drawLogSeat)
  makeTexture(scene, 'camp-patch', 120, 76, drawCampPatch)
  makeTexture(scene, 'room-walls', ROOM_W * 16, ROOM_H * 16, drawRoomWalls)
}

/** Decoration textures, from the shared item definitions (footprints in tiles). */
export function generateDecorationArt(scene: Phaser.Scene, items: readonly { id: string; footprint: [number, number] }[]): void {
  for (const it of items) makeDeco(scene, it.id, it.footprint[0], it.footprint[1])
}
