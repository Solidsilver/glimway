/**
 * Code-drawn pixel art for the Commons and homesteads, in the game's own
 * style (src/game/textures.ts): 1 px dark outlines, warm palette, crisp
 * nearest-neighbour. Nothing here is a third-party asset.
 *
 * Placeholders that want real art (see .agent/REPORT.md "Art requests"):
 * Silas, the cottage, the decorations, and the cottage interior.
 *
 * Textures are generated once at boot (BootScene) except the hedge and fence
 * runs, which are made on demand for their length (`ensureSceneryTexture`).
 * If a texture with the same key was loaded from a file first, it wins.
 */
import type Phaser from 'phaser'

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

/** Deterministic 0..1 per pixel, for speckle. */
function h01(x: number, y: number, s = 0): number {
  let v = (x * 73856093) ^ (y * 19349663) ^ (s * 83492791)
  v = Math.imul(v ^ (v >>> 13), 1274126177)
  return ((v ^ (v >>> 16)) >>> 0) / 4294967296
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

function makeTexture(scene: Phaser.Scene, key: string, w: number, h: number, draw: (c: C) => void): void {
  if (scene.textures.exists(key)) return
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const c = canvas.getContext('2d')!
  c.imageSmoothingEnabled = false
  draw(c)
  scene.textures.addCanvas(key, canvas)
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
      clumps.push([4 + Math.round(h01(1, y) * 2), y + 2, 4])
      clumps.push([w - 5 - Math.round(h01(2, y) * 2), y + 4, 4])
      clumps.push([w / 2, y + 3, 4])
    }
  } else {
    for (let x = 2; x < w - 1; x += 6) {
      clumps.push([x + Math.round(h01(x, 1) * 3), top + 1 + Math.round(h01(x, 2) * 2), 4 + (h01(x, 3) < 0.35 ? 1 : 0)])
      clumps.push([x + 3, top + 6 + Math.round(h01(x, 4) * 2), 4])
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
        const n = h01(x + dx, y + dy, 6)
        const col = lit > r * 1.1 ? (n < 0.55 ? HEDGE.hi : HEDGE.lt) : lit > 0 ? (n < 0.45 ? HEDGE.lt : HEDGE.md) : lit < -r * 0.8 ? HEDGE.dk : n < 0.25 ? HEDGE.dk : HEDGE.md
        px(c, x + dx, y + dy, col)
      }
  }
  // The shaded face under the crown, rooted in darker soil.
  const img = c.getImageData(0, 0, w, h).data
  const at = (x: number, y: number) => img[(y * w + x) * 4 + 3] > 0
  for (let x = 1; x < w - 1; x++) {
    for (let y = h - 6; y < h - 1; y++) if (at(x, y)) px(c, x, y, y >= h - 3 ? HEDGE.xd : h01(x, y, 8) < 0.4 ? HEDGE.dk : HEDGE.md)
  }
  // A few blossoms so long hedges don't read as a wall.
  for (let i = 0; i < w * h; i += 131) {
    const x = 2 + Math.floor(h01(i, 7) * (w - 4))
    const y = top + Math.floor(h01(i, 8) * Math.max(1, h - top - 9))
    if (at(x, y) && h01(i, 9) < 0.4) px(c, x, y, h01(i, 10) < 0.5 ? '#fff3d6' : '#e891ac')
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

const RUN = /^(hedge|fence)-(h|v)-(\d+)$/

/** Hedge and fence runs are drawn for their length the first time they're used. */
export function ensureSceneryTexture(scene: Phaser.Scene, key: string): boolean {
  if (scene.textures.exists(key)) return true
  const m = RUN.exec(key)
  if (!m) return false
  const n = Math.max(1, Math.min(64, Number(m[3])))
  if (m[1] === 'hedge') {
    if (m[2] === 'h') makeTexture(scene, key, n * 16, 22, (c) => drawHedge(c, n * 16, 22, false))
    else makeTexture(scene, key, 16, n * 16 + 6, (c) => drawHedge(c, 16, n * 16 + 6, true))
  } else if (m[2] === 'h') makeTexture(scene, key, n * 16, 16, (c) => drawFenceH(c, n * 16))
  else makeTexture(scene, key, 16, n * 16, (c) => drawFenceV(c, n * 16))
  return true
}

// ---------------------------------------------------------------- Silas (placeholder)

const silasPal: Record<string, string> = {
  o: O,
  C: '#66703f', // flat cap, olive
  c: '#4b5430',
  H: '#b9b2a6', // grey hair
  S: '#f2c79c',
  s: '#d9a678',
  e: '#4a3228',
  m: '#ddd6ca', // moustache
  T: '#4f6f8c', // faded shirt
  t: '#6c8aa6',
  A: '#8a5a34', // leather apron
  a: '#6b4423',
  P: '#c49a62', // pencil in the pocket
  B: '#4a3220'
}

// Older than the villagers: a flat cap over grey hair, a moustache, a leather
// apron with a carpenter's pencil, weight on the right leg.
const SILAS: string[] = [
  '................',
  '.....oooooo.....',
  '....oCCCCCCo....',
  '...oCCCCCCCCo...',
  '..occccccccccoo.',
  '...oHSSSSSSHo...',
  '...oHeSSSSeHo...',
  '...oSSSSSSSSo...',
  '....oSmmmmSo....',
  '...ooTTTTTToo...',
  '..oTtAAAAAAtTo..',
  '..oStAAAAPAtSo..',
  '...oTAAaAAAAo...',
  '....oAAAAAAo....',
  '....oBo..oBBo...',
  '.....oo...oo....'
]

const SILAS_B: string[] = SILAS.map((row, i) => (i === 10 ? '..oTtAAAAAAtTo..' : i === 11 ? '..oStAAAAPAtSo..' : i === 9 ? '...ooTTTTTToo...' : row))
// Breathing: the shoulders rise a pixel.
SILAS_B[9] = '...ooTTTTTToo...'
SILAS_B[8] = '....oSmmmmSo....'

// ---------------------------------------------------------------- the gate & the hame

function drawGatepost(c: C): void {
  // A stout carters' gatepost: iron-oak on a stone footing, a carved cap.
  box(c, 0, 36, 14, 8, STONE.md)
  rect(c, 1, 37, 12, 2, STONE.lt)
  rect(c, 3, 41, 3, 1, STONE.dk)
  box(c, 2, 6, 10, 32, OAK.md)
  rect(c, 3, 7, 2, 30, OAK.lt)
  rect(c, 9, 7, 2, 30, OAK.dk)
  for (const y of [14, 24]) rect(c, 3, y, 8, 1, OAK.xd)
  box(c, 1, 2, 12, 5, OAK.lt)
  rect(c, 2, 3, 10, 1, OAK.hi)
  box(c, 4, 0, 6, 3, OAK.md)
  rect(c, 3, 33, 8, 3, '#5f8f4c')
  px(c, 4, 32, '#7fb35c')
}

function drawGateLeaf(c: C): void {
  // A five-bar gate swung open against the fence: rails, a brace, two stiles.
  for (const y of [3, 6, 9, 12]) {
    rect(c, 2, y, 40, 3, O)
    rect(c, 2, y + 1, 40, 1, WOOD.lt)
  }
  box(c, 0, 1, 4, 15, WOOD.md)
  box(c, 38, 1, 4, 15, WOOD.md)
  for (let i = 0; i < 34; i++) {
    const x = 4 + i
    const y = 13 - Math.round((i / 34) * 11)
    rect(c, x, y, 1, 2, O)
    px(c, x, y, WOOD.lt)
  }
}

function drawHame(c: C): void {
  // A polished hame: a padded leather collar between two brass-capped arms,
  // hung on a peg. The brass is kept bright.
  const L = '#7a4a2a'
  const l = '#9a6038'
  const B = '#f1c75a'
  const b = '#c9922e'
  for (let y = 4; y <= 19; y++) for (let x = 1; x <= 15; x++) {
    const dx = (x - 8) / 7
    const dy = (y - 11) / 9
    const d = dx * dx + dy * dy
    const inner = ((x - 8) / 3.6) ** 2 + ((y - 12) / 5.6) ** 2
    if (d <= 1 && inner > 1) px(c, x, y, x < 8 ? l : L)
  }
  // Brass arms along the collar, knobs at the top.
  for (let y = 5; y <= 17; y++) {
    const off = Math.round(Math.sqrt(Math.max(0, 1 - ((y - 11) / 9) ** 2)) * 6)
    px(c, 8 - off, y, y < 9 ? B : b)
    px(c, 8 + off, y, b)
  }
  disc(c, 3, 3, 1, B)
  disc(c, 13, 3, 1, b)
  px(c, 3, 2, '#fff3c4')
  px(c, 5, 8, '#fff3c4')
  outline(c, 17, 22)
  // The peg it hangs on.
  rect(c, 7, 0, 3, 2, OAK.dk)
}

// ---------------------------------------------------------------- the heart

function drawWell(c: C): void {
  // Stone drum, dark water, two posts, a little shingle roof, a bucket.
  const W = 32
  // Posts behind.
  box(c, 3, 6, 4, 22, OAK.md)
  box(c, 25, 6, 4, 22, OAK.md)
  // Roof.
  for (let y = 0; y < 9; y++) {
    const inset = Math.max(0, 4 - y)
    rect(c, inset, y, W - inset * 2, 1, y === 0 ? O : y % 3 === 0 ? '#9c4c3a' : '#c4654f')
  }
  rect(c, 0, 8, W, 2, O)
  rect(c, 1, 8, W - 2, 1, '#7a3c2e')
  for (let x = 2; x < W - 2; x += 5) rect(c, x, 2, 1, 6, '#9c4c3a')
  // Crank beam and rope.
  rect(c, 6, 12, 20, 3, O)
  rect(c, 7, 13, 18, 1, OAK.lt)
  rect(c, 15, 15, 1, 6, '#d8c79c')
  box(c, 13, 19, 6, 5, OAK.md)
  rect(c, 14, 20, 4, 1, '#4d7ea8')
  // Stone drum.
  oval(c, 16, 28, 14, 5, O)
  rect(c, 2, 28, 28, 10, O)
  oval(c, 16, 38, 14, 4, O)
  rect(c, 3, 28, 26, 10, STONE.md)
  oval(c, 16, 38, 13, 3, STONE.md)
  for (let y = 29; y < 41; y++)
    for (let x = 3; x < 29; x++) {
      const row = Math.floor((y - 29) / 4)
      const seam = (y - 29) % 4 === 3 || (x + row * 3) % 7 === 0
      if (seam && y < 41) px(c, x, y, STONE.dk)
      else if (h01(x, y, 3) < 0.1) px(c, x, y, STONE.lt)
    }
  oval(c, 16, 28, 13, 4, STONE.lt)
  oval(c, 16, 28, 10, 3, '#2b3d52')
  oval(c, 16, 28, 7, 2, '#3f6b8c')
  px(c, 13, 27, '#8fb8d8')
  // Moss on the rim.
  for (const [x, y] of [[4, 29], [5, 30], [26, 31], [27, 30], [10, 38], [11, 39]]) px(c, x, y, LEAF.md)
}

function drawNoticeBoard(c: C): void {
  box(c, 2, 8, 4, 22, OAK.md)
  box(c, 18, 8, 4, 22, OAK.md)
  box(c, 0, 4, 24, 16, '#b08a5e')
  rect(c, 1, 5, 22, 1, '#c4a074')
  // Cap.
  box(c, 0, 1, 24, 4, OAK.md)
  rect(c, 1, 2, 22, 1, OAK.hi)
  // Notices: the Turning, Carting Day, a plot plan, Silas's price list.
  box(c, 2, 6, 7, 8, CREAM)
  for (let y = 8; y < 13; y += 2) rect(c, 3, y, 5, 1, '#8a7458')
  box(c, 10, 7, 6, 6, '#fffbef')
  px(c, 12, 9, '#b25a3c')
  px(c, 13, 9, '#b25a3c')
  rect(c, 11, 11, 4, 1, '#8a7458')
  box(c, 16, 6, 6, 9, '#e8dcc0')
  rect(c, 17, 8, 4, 1, '#8a7458')
  rect(c, 17, 10, 3, 1, '#8a7458')
  rect(c, 17, 12, 4, 1, '#8a7458')
  px(c, 5, 6, '#c4523a')
  px(c, 18, 6, '#4a6f9c')
}

// ---------------------------------------------------------------- Silas's yard & the meadow

function drawFirebox(c: C): void {
  // A squat stone firebox with a glowing mouth and a tin pipe.
  box(c, 10, 0, 4, 9, '#7a7680')
  rect(c, 11, 1, 1, 7, '#a09aa8')
  box(c, 0, 6, 16, 12, STONE.md)
  rect(c, 1, 7, 14, 1, STONE.lt)
  for (const [x, y] of [[3, 10], [9, 9], [12, 13], [4, 15]]) rect(c, x, y, 3, 1, STONE.dk)
  box(c, 4, 10, 8, 6, '#2a1c18')
  rect(c, 5, 13, 6, 2, FLAME.md)
  rect(c, 6, 12, 4, 1, FLAME.hi)
  px(c, 7, 11, FLAME.core)
}

function drawSawhorse(c: C): void {
  for (const x of [2, 13]) {
    for (let i = 0; i < 8; i++) {
      px(c, x + Math.floor(i / 3), 4 + i, O)
      px(c, x + 3 - Math.floor(i / 3), 4 + i, O)
    }
  }
  box(c, 0, 2, 18, 4, WOOD.md)
  rect(c, 1, 3, 16, 1, WOOD.hi)
  // A board on it, and the saw.
  box(c, 3, 0, 14, 3, OAK.lt)
  rect(c, 8, 0, 1, 3, OAK.dk)
  for (let x = 12; x < 17; x++) px(c, x, 6 + (x % 2), '#b8b8c0')
}

function drawTimber(c: C): void {
  // Squared iron-oak beams, end grain out.
  for (const [x, y] of [[0, 8], [10, 8], [20, 8], [5, 1], [15, 1]]) {
    box(c, x, y, 11, 10, OAK.md)
    rect(c, x + 1, y + 1, 9, 2, OAK.lt)
    disc(c, x + 5, y + 5, 2, OAK.dk)
    px(c, x + 5, y + 5, OAK.lt)
  }
  rect(c, 0, 18, 31, 2, O)
}

function drawSkids(c: C): void {
  // Four iron-oak skids laid straight on the levelled dirt, pegs ready.
  for (let i = 0; i < 4; i++) {
    const y = 2 + i * 10
    box(c, 0, y, 86, 6, OAK.md)
    rect(c, 1, y + 1, 84, 1, OAK.lt)
    rect(c, 1, y + 4, 84, 1, OAK.dk)
    for (let x = 10; x < 80; x += 18) rect(c, x, y + 2, 2, 2, OAK.xd)
  }
  // Chalk marks: measured in fingers.
  for (const x of [20, 44, 68]) rect(c, x, 0, 1, 2, '#efe8d8')
}

function drawWoodpile(c: C): void {
  for (const [x, y] of [[0, 7], [5, 7], [10, 7], [2, 3], [7, 3], [5, 0]]) {
    disc(c, x + 3, y + 3, 3, O)
    disc(c, x + 3, y + 3, 2, OAK.lt)
    px(c, x + 3, y + 3, OAK.dk)
  }
}

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
    const lean = h01(x, hgt) < 0.5 ? -1 : 1
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

function drawSign(c: C, reserved: boolean): void {
  box(c, 18, 12, 4, 10, OAK.md)
  box(c, 0, 0, 40, 14, reserved ? '#d8c79c' : '#c49a62')
  rect(c, 1, 1, 38, 1, reserved ? '#efe2c0' : '#e0bb8c')
  rect(c, 1, 12, 38, 1, reserved ? '#b8a77c' : '#8a6642')
  px(c, 2, 2, OAK.dk)
  px(c, 37, 2, OAK.dk)
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

// ---------------------------------------------------------------- cottage

export const COTTAGE_W = 96
export const COTTAGE_H = 92

interface CottageStyle {
  roof: string[]
  /** Silas's has a workshop board and a lean-to. */
  silas: boolean
  /** Tier 2: deep eaves over a heavy bench and a rack of clean tools. */
  workshop?: boolean
}

function drawCottage(c: C, style: CottageStyle): void {
  const W = COTTAGE_W
  const base = COTTAGE_H
  const [r0, r1, r2, r3] = style.roof
  // Chimney (stone), behind the ridge.
  box(c, 68, 0, 12, 22, STONE.md)
  rect(c, 69, 1, 10, 2, STONE.lt)
  for (const y of [6, 11, 16]) rect(c, 69, y, 10, 1, STONE.dk)
  box(c, 66, 0, 16, 4, STONE.dk)
  // Roof: slates in courses, overhanging the wall.
  const roofTop = 8
  const roofBot = 52
  rect(c, 1, roofTop, W - 2, roofBot - roofTop, O)
  for (let y = roofTop + 1; y < roofBot - 1; y++) {
    const course = Math.floor((y - roofTop - 1) / 5)
    const inCourse = (y - roofTop - 1) % 5
    for (let x = 2; x < W - 2; x++) {
      const shift = course % 2 === 0 ? 0 : 4
      const seam = (x + shift) % 8 === 0
      let col = inCourse === 4 ? r3 : seam ? r2 : inCourse === 0 ? r0 : r1
      if (h01(x >> 2, course, 5) < 0.08 && inCourse > 0 && !seam) col = r0
      px(c, x, y, col)
    }
  }
  // Ridge cap, eave shadow and the gable edges.
  rect(c, 1, roofTop - 3, W - 2, 4, O)
  rect(c, 2, roofTop - 2, W - 4, 2, r0)
  rect(c, 2, roofBot - 2, W - 4, 1, r3)
  for (let y = roofTop; y < roofBot; y++) {
    px(c, 2, y, r3)
    px(c, W - 3, y, r3)
  }
  // Moss on the slates.
  for (const [x, y] of [[12, 30], [13, 30], [12, 31], [80, 18], [81, 19], [40, 44], [41, 44]]) px(c, x, y, LEAF.md)
  // Front wall: vertical planks under a top beam.
  const wallTop = roofBot
  box(c, 6, wallTop - 1, W - 12, base - wallTop - 5, WOOD.md)
  for (let x = 7; x < W - 7; x++) {
    const plank = Math.floor((x - 7) / 6)
    const seam = (x - 7) % 6 === 5
    for (let y = wallTop + 3; y < base - 7; y++) px(c, x, y, seam ? WOOD.dk : plank % 2 ? WOOD.md : WOOD.lt)
  }
  rect(c, 6, wallTop - 1, W - 12, 4, O)
  rect(c, 7, wallTop, W - 14, 2, OAK.md)
  rect(c, 7, wallTop + 2, W - 14, 1, OAK.dk)
  // Eave shadow on the wall.
  rect(c, 7, wallTop + 3, W - 14, 2, 'rgba(40,24,20,0.35)')
  // Sill beam and the four iron-oak skid ends: it sits on the land like a barge.
  rect(c, 3, base - 8, W - 6, 4, O)
  rect(c, 4, base - 7, W - 8, 2, OAK.md)
  for (const x of [8, 32, 58, 82]) {
    box(c, x, base - 7, 7, 7, OAK.md)
    disc(c, x + 3, base - 4, 1, OAK.xd)
  }
  // Door with its fox over the lintel (long ear on the left: Silas's hand).
  const dx = W / 2 - 8
  box(c, dx - 1, wallTop + 7, 18, base - wallTop - 14, OAK.dk)
  box(c, dx + 1, wallTop + 9, 14, base - wallTop - 17, OAK.md)
  for (let x = dx + 2; x < dx + 14; x += 4) rect(c, x, wallTop + 10, 1, base - wallTop - 19, OAK.dk)
  rect(c, dx + 1, wallTop + 18, 14, 1, OAK.xd)
  disc(c, dx + 12, wallTop + 22, 1, '#c9922e')
  rect(c, dx - 1, base - 8, 18, 1, OAK.xd)
  paint(c, ['.o...o..', 'ooo.oo..', '.ooooo.o', '..oooooo', '..oo.o..'], { o: '#e8d2a6' }, dx + 4, wallTop + 1)
  px(c, dx + 4, wallTop + 1, '#e8d2a6')
  // Windows: four warm panes, a sill box.
  for (const wx of [14, W - 30]) {
    box(c, wx, wallTop + 9, 16, 14, OAK.dk)
    rect(c, wx + 2, wallTop + 11, 12, 10, GLOW)
    rect(c, wx + 2, wallTop + 11, 12, 3, '#fff3c4')
    rect(c, wx + 7, wallTop + 11, 2, 10, OAK.dk)
    rect(c, wx + 2, wallTop + 15, 12, 1, OAK.dk)
    box(c, wx - 1, wallTop + 22, 18, 4, OAK.md)
    for (let i = 0; i < 5; i++) px(c, wx + 2 + i * 3, wallTop + 21, i % 2 ? '#e891ac' : '#fff3d6')
  }
  if (style.workshop) {
    // The right window gives way to the workshop: a deep plank eave on
    // brackets, a heavy bench under it, clean tools racked on the wall.
    const ex = W - 36
    box(c, ex, wallTop + 4, 34, 30, WOOD.md)
    for (let x = ex + 1; x < ex + 33; x++) for (let y = wallTop + 5; y < wallTop + 33; y++) px(c, x, y, (x - ex) % 6 === 5 ? WOOD.dk : WOOD.lt)
    // Tools: saw, mallet, chisels, a coil of twine.
    rect(c, ex + 4, wallTop + 9, 2, 12, '#b8b8c0')
    rect(c, ex + 3, wallTop + 8, 4, 3, OAK.dk)
    box(c, ex + 10, wallTop + 9, 7, 5, OAK.md)
    rect(c, ex + 13, wallTop + 14, 1, 8, OAK.dk)
    for (const x of [ex + 21, ex + 24, ex + 27]) rect(c, x, wallTop + 9, 1, 9, '#b8b8c0')
    disc(c, ex + 30, wallTop + 12, 2, '#c4b48a')
    // The bench: thick iron-oak top, square legs, shavings beneath.
    box(c, ex - 2, base - 26, 38, 6, OAK.lt)
    rect(c, ex - 1, base - 25, 36, 1, OAK.hi)
    for (const x of [ex, ex + 30]) box(c, x, base - 21, 4, 13, OAK.md)
    box(c, ex + 12, base - 30, 9, 4, OAK.md)
    for (const [x, y] of [[ex + 8, base - 9], [ex + 18, base - 10], [ex + 24, base - 9]]) px(c, x, y, '#e8d2a6')
    // The eave, deep and dark, on two brackets.
    for (let i = 0; i < 6; i++) rect(c, ex - 4 + i, wallTop - 1 + i, 42 - i * 2 + 4, 1, i === 0 ? O : i % 2 ? '#5c4128' : '#6b4c2e')
    rect(c, ex - 4, wallTop + 5, 46, 1, O)
    for (const x of [ex - 2, ex + 36]) {
      rect(c, x, wallTop + 5, 2, 8, OAK.dk)
      px(c, x + (x < ex ? 2 : -1), wallTop + 6, OAK.dk)
    }
  }
  if (style.silas) {
    // A workshop board by the door: a saw and a plane, painted.
    box(c, W - 13, wallTop + 6, 6, 12, '#d8c79c')
    rect(c, W - 12, wallTop + 9, 4, 1, '#6b4c2e')
    rect(c, W - 12, wallTop + 13, 4, 2, '#6b4c2e')
  }
}

// ---------------------------------------------------------------- the campsite

function drawWindbreak(c: C): void {
  // Canvas on two poles, pegged against the wind.
  box(c, 2, 2, 3, 20, WOOD.md)
  box(c, 35, 2, 3, 20, WOOD.md)
  for (let y = 4; y < 18; y++) {
    const sag = Math.round(Math.sin(((y - 4) / 14) * Math.PI) * 1)
    rect(c, 5 + sag, y, 30 - sag * 2, 1, y < 6 ? '#e8dcc0' : y > 15 ? '#b8a77c' : '#d8c9a2')
  }
  rect(c, 5, 4, 30, 1, O)
  rect(c, 5, 17, 30, 1, O)
  for (const x of [12, 20, 28]) rect(c, x, 5, 1, 12, '#c4b48a')
  px(c, 1, 22, O)
  px(c, 39, 22, O)
}

function drawCot(c: C): void {
  // A canvas cot up on blocks: never sleep on bare ground.
  box(c, 1, 9, 5, 5, STONE.md)
  box(c, 25, 9, 5, 5, STONE.md)
  box(c, 0, 4, 31, 7, WOOD.md)
  rect(c, 1, 5, 29, 4, '#d8c9a2')
  rect(c, 1, 5, 29, 1, '#efe2c0')
  // Blanket and a rolled pillow.
  rect(c, 10, 5, 20, 4, '#4a6f9c')
  rect(c, 10, 5, 20, 1, '#6c93bd')
  for (let x = 12; x < 30; x += 4) px(c, x, 7, '#e8dcc0')
  box(c, 2, 3, 7, 5, '#efe2c0')
}

function drawFireRing(c: C): void {
  // Stones in a ring, a few logs, embers.
  oval(c, 11, 8, 10, 5, O)
  oval(c, 11, 8, 9, 4, '#4a3a30')
  oval(c, 11, 8, 6, 2, '#2a1c18')
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2
    const x = Math.round(11 + Math.cos(a) * 9)
    const y = Math.round(8 + Math.sin(a) * 4.4)
    disc(c, x, y, 1, i % 3 === 0 ? STONE.lt : STONE.md)
    px(c, x - 1, y - 1, O)
  }
  rect(c, 6, 7, 10, 2, OAK.dk)
  rect(c, 9, 6, 2, 4, OAK.md)
  px(c, 10, 8, FLAME.md)
  px(c, 8, 8, FLAME.dk)
  px(c, 13, 8, FLAME.dk)
}

const FLAME_A = ['...o....', '..oyo...', '..oyyo..', '.oyhyo..', '.oyhhyo.', 'oyyhcyyo', 'oyhccyyo', '.oyccyo.', '..oooo..']
const FLAME_B = ['....o...', '...oyo..', '..oyyo..', '..oyhyo.', '.oyhhyo.', 'oyyhchyo', 'oyhccyyo', '.oyccyo.', '..oooo..']
const flamePal = { o: FLAME.dk, y: FLAME.md, h: FLAME.hi, c: FLAME.core }

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
      const n = h01(x >> 1, y >> 1, 21)
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
      for (let y = 4; y < 29; y += 2) for (let x = 2; x < 30; x += 3) if (h01(x, y, 2) < 0.2) px(c, x, y, 'rgba(255,255,255,0.18)')
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

/** Pixels a decoration's art rises above its footprint (anchor bottom-left). */
export function decoRise(itemDef: string): number {
  return Math.max(0, DECO[itemDef]?.rise ?? 0)
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
  for (let y = 2; y < 46; y++) for (let x = 0; x < W; x++) if (h01(x >> 1, y >> 1, 12) < 0.07) px(c, x, y, '#d8c9a2')
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
  // Shelf (right) with crocks and a folded blanket.
  box(c, 162, 20, 34, 4, OAK.md)
  box(c, 166, 12, 7, 8, '#c4a074')
  box(c, 176, 14, 6, 6, '#8c3f3a')
  box(c, 185, 11, 8, 9, '#6b8a3a')
  // The hearth: quarried stone, never drift-stone.
  const hx = 88
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

function drawRoomFire(c: C, frame: number): void {
  const rows = frame ? FLAME_B : FLAME_A
  paint(c, rows, flamePal, 4, 2)
  paint(c, frame ? FLAME_A : FLAME_B, flamePal, 12, 3)
  rect(c, 0, 11, 24, 3, OAK.dk)
  rect(c, 2, 10, 20, 1, OAK.md)
}

// ---------------------------------------------------------------- boot

/** Register every fixed Commons/homestead texture (BootScene, after the game's own). */
// ---------------------------------------------------------------- phase 5: village life

function drawMailbox(c: C, flag: boolean): void {
  // A carter's post box on a stake: a little slate roof, a slot, a flag.
  box(c, 6, 10, 3, 12, OAK.md)
  box(c, 1, 3, 13, 9, '#5f7f8f')
  rect(c, 2, 4, 11, 2, '#7f9fae')
  rect(c, 4, 8, 7, 1, '#2f3f48')
  for (let i = 0; i < 3; i++) rect(c, i, 3 - i, 15 - i * 2, 1, i === 0 ? '#4a5560' : '#55606e')
  if (flag) {
    rect(c, 14, 1, 1, 8, O)
    box(c, 14, 0, 5, 4, '#c4523a')
  } else {
    rect(c, 14, 6, 4, 1, '#8a3f30')
  }
}

function drawChest(c: C): void {
  // Oak, iron-bound, waxed against the damp. A chest that doesn't drink it.
  box(c, 0, 6, 28, 16, OAK.md)
  for (let x = 1; x < 27; x++) for (let y = 7; y < 21; y++) if ((x + 1) % 7 === 0) px(c, x, y, OAK.dk)
  box(c, 0, 0, 28, 8, OAK.lt)
  rect(c, 1, 1, 26, 2, OAK.hi)
  for (const x of [3, 23]) rect(c, x, 0, 2, 22, '#4a4452')
  box(c, 11, 8, 6, 6, '#c9922e')
  px(c, 14, 11, O)
}

function drawBench(c: C): void {
  // The crafting bench: vise, mallet, a pot of pegs, curls of shavings.
  box(c, 0, 8, 44, 6, OAK.lt)
  rect(c, 1, 9, 42, 1, OAK.hi)
  for (const x of [2, 38]) box(c, x, 13, 4, 11, OAK.md)
  rect(c, 6, 18, 32, 2, OAK.dk)
  box(c, 4, 2, 8, 7, '#4a4452')
  rect(c, 6, 4, 4, 1, '#8a8a96')
  box(c, 18, 3, 8, 5, OAK.md)
  rect(c, 21, 8, 2, 1, OAK.dk)
  box(c, 32, 3, 6, 6, '#b25a3c')
  for (const [x, y] of [[33, 2], [35, 1], [36, 2]]) px(c, x, y, '#e8d2a6')
  for (const [x, y] of [[10, 25], [20, 26], [28, 25]]) px(c, x, y, '#e8d2a6')
}

function drawStall(c: C, awning: [string, string]): void {
  // A Carting Day stall: striped awning on poles, a counter of goods.
  const W = 40
  for (const x of [2, W - 5]) box(c, x, 6, 3, 30, OAK.md)
  for (let y = 0; y < 10; y++) {
    const inset = Math.max(0, 3 - y)
    for (let x = inset; x < W - inset; x++) px(c, x, y, y === 0 ? O : Math.floor(x / 5) % 2 ? awning[0] : awning[1])
  }
  rect(c, 0, 10, W, 1, O)
  for (let x = 0; x < W; x += 5) rect(c, x, 10, 4, 2, Math.floor(x / 5) % 2 ? awning[0] : awning[1])
  box(c, 0, 22, W, 14, '#b08a5e')
  rect(c, 1, 23, W - 2, 2, '#c4a074')
  // Goods: twists, crocks, a ribbon of bunting.
  for (let i = 0; i < 5; i++) {
    box(c, 3 + i * 7, 17, 6, 6, i % 2 ? '#d9a678' : '#b25a3c')
    px(c, 5 + i * 7, 18, '#fff3c4')
  }
}

function drawBunting(c: C, w: number): void {
  // A string of little flags in Carting colours, sagging between posts.
  const cols = ['#c9922e', '#2f7f7a', '#b25a3c', '#efe2c0']
  for (let x = 0; x < w; x++) {
    const y = Math.round(Math.sin((x / (w - 1)) * Math.PI) * 4)
    px(c, x, y, '#6b4c2e')
    if (x % 6 === 2) {
      const col = cols[(x / 6) % cols.length | 0]
      for (let i = 0; i < 4; i++) rect(c, x - 1 + Math.floor(i / 2), y + 1 + i, 3 - Math.floor(i / 1.5), 1, col)
    }
  }
}

function drawCandleHull(c: C): void {
  // A walnut-shell boat with a leaf sail and a stub of candle.
  oval(c, 5, 7, 5, 2, '#6b4423')
  oval(c, 5, 6, 4, 1, '#8a5a34')
  rect(c, 5, 1, 1, 5, '#efe2c0')
  px(c, 5, 0, '#ffd24a')
  for (let y = 2; y < 5; y++) rect(c, 6, y, 3 - (y - 2), 1, '#7fb35c')
}

function drawWellCanopy(c: C): void {
  // A slate canopy over the village well: Orrin cut a mark on the lintel.
  for (const x of [2, 25]) box(c, x, 9, 3, 19, OAK.md)
  for (let y = 0; y < 10; y++) {
    const inset = Math.max(0, 5 - y)
    rect(c, inset, y, 30 - inset * 2, 1, y === 0 ? O : y % 3 === 0 ? '#55606e' : '#7f8f9e')
  }
  rect(c, 0, 9, 30, 2, O)
  rect(c, 1, 9, 28, 1, OAK.lt)
  px(c, 15, 9, O)
}

function drawBridge(c: C): void {
  // The mended bridge: new iron-oak planks, rails both sides, a lamp hook.
  const W = 48
  rect(c, 0, 6, W, 16, O)
  for (let x = 1; x < W - 1; x++) for (let y = 7; y < 21; y++) px(c, x, y, x % 6 === 0 ? OAK.dk : y < 9 ? OAK.hi : OAK.lt)
  for (const y of [3, 21]) {
    rect(c, 0, y, W, 3, O)
    rect(c, 1, y + 1, W - 2, 1, OAK.md)
    for (let x = 1; x < W; x += 8) box(c, x, y - 3, 3, 6, OAK.md)
  }
}

export function generateCommonsArt(scene: Phaser.Scene): void {
  makeTexture(scene, 'mailbox', 19, 22, (c) => drawMailbox(c, false))
  makeTexture(scene, 'mailbox-flag', 19, 22, (c) => drawMailbox(c, true))
  makeTexture(scene, 'workshop-chest', 28, 22, drawChest)
  makeTexture(scene, 'workshop-bench', 44, 26, drawBench)
  makeTexture(scene, 'stall-a', 40, 36, (c) => drawStall(c, ['#c4523a', '#efe2c0']))
  makeTexture(scene, 'stall-b', 40, 36, (c) => drawStall(c, ['#2f7f7a', '#efe2c0']))
  makeTexture(scene, 'stall-c', 40, 36, (c) => drawStall(c, ['#c9922e', '#efe2c0']))
  makeTexture(scene, 'bunting-64', 64, 10, (c) => drawBunting(c, 64))
  makeTexture(scene, 'bunting-96', 96, 10, (c) => drawBunting(c, 96))
  makeTexture(scene, 'candle-hull', 11, 10, drawCandleHull)
  makeTexture(scene, 'well-canopy', 30, 28, drawWellCanopy)
  makeTexture(scene, 'mended-bridge', 48, 26, drawBridge)
  makeTexture(scene, 'cottage-workshop', COTTAGE_W, COTTAGE_H, (c) => drawCottage(c, { roof: ['#8a9aa8', '#6f7f8f', '#55606e', '#3f4854'], silas: false, workshop: true }))
  makeTexture(scene, 'silas', 16, 16, (c) => paint(c, SILAS, silasPal))
  makeTexture(scene, 'silas-idle-0', 16, 16, (c) => paint(c, SILAS, silasPal))
  makeTexture(scene, 'silas-idle-1', 16, 16, (c) => paint(c, SILAS_B, silasPal, 0, 0))
  makeTexture(scene, 'gatepost', 14, 44, drawGatepost)
  makeTexture(scene, 'gate-leaf', 42, 16, drawGateLeaf)
  makeTexture(scene, 'hame', 17, 22, drawHame)
  makeTexture(scene, 'commons-well', 32, 42, drawWell)
  makeTexture(scene, 'notice-board', 24, 30, drawNoticeBoard)
  makeTexture(scene, 'firebox', 16, 18, drawFirebox)
  makeTexture(scene, 'sawhorse', 18, 12, drawSawhorse)
  makeTexture(scene, 'timber-stack', 31, 20, drawTimber)
  makeTexture(scene, 'skids', 86, 40, drawSkids)
  makeTexture(scene, 'woodpile', 16, 14, drawWoodpile)
  makeTexture(scene, 'stump', 15, 12, drawStump)
  makeTexture(scene, 'tall-grass-a', 10, 13, (c) => drawTallGrass(c, false))
  makeTexture(scene, 'tall-grass-b', 11, 13, (c) => drawTallGrass(c, true))
  makeTexture(scene, 'wildflowers', 10, 8, drawWildflowers)
  makeTexture(scene, 'stake', 8, 14, drawStake)
  makeTexture(scene, 'plot-sign', 40, 22, (c) => drawSign(c, false))
  makeTexture(scene, 'plot-sign-reserved', 40, 22, (c) => drawSign(c, true))
  makeTexture(scene, 'gatepost-small', 8, 18, drawSmallPost)
  makeTexture(scene, 'commons-board', 24, 17, drawCommonsBoard)
  makeTexture(scene, 'cottage', COTTAGE_W, COTTAGE_H, (c) => drawCottage(c, { roof: ['#8a9aa8', '#6f7f8f', '#55606e', '#3f4854'], silas: false }))
  makeTexture(scene, 'cottage-silas', COTTAGE_W, COTTAGE_H, (c) => drawCottage(c, { roof: ['#b07a48', '#8a5a34', '#6b4423', '#4a3220'], silas: true }))
  makeTexture(scene, 'camp-windbreak', 40, 23, drawWindbreak)
  makeTexture(scene, 'camp-cot', 31, 14, drawCot)
  makeTexture(scene, 'camp-ring', 22, 14, drawFireRing)
  makeTexture(scene, 'camp-flame-0', 8, 9, (c) => paint(c, FLAME_A, flamePal))
  makeTexture(scene, 'camp-flame-1', 8, 9, (c) => paint(c, FLAME_B, flamePal))
  makeTexture(scene, 'camp-logseat', 14, 8, drawLogSeat)
  makeTexture(scene, 'camp-patch', 120, 76, drawCampPatch)
  makeTexture(scene, 'room-walls', ROOM_W * 16, ROOM_H * 16, drawRoomWalls)
  makeTexture(scene, 'room-fire-0', 24, 14, (c) => drawRoomFire(c, 0))
  makeTexture(scene, 'room-fire-1', 24, 14, (c) => drawRoomFire(c, 1))
}

/** Decoration textures, from the shared item definitions (footprints in tiles). */
export function generateDecorationArt(scene: Phaser.Scene, items: readonly { id: string; footprint: [number, number] }[]): void {
  for (const it of items) makeDeco(scene, it.id, it.footprint[0], it.footprint[1])
}
