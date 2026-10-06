import type Phaser from 'phaser'
import { artKey, blitFrame, commonsFrame, type CommonsPassFrame } from './commons-pass.ts'
import { decorationLayout } from './atlas-plan.ts'
import { addArtCanvas, artCanvas, artDensity, artSource, drawArt, resampleFor } from './density.ts'

export { decorationLayout }
import { ROOM_H, ROOM_W } from './commons-art.ts'

/**
 * Boot-time swap: copy the delivered Commons-pass frames onto the
 * placeholder texture keys the scenes already draw with, and build the few
 * composites a single frame can't fill (bunting runs, the cottage room, the
 * decoration views, the flag-down mailbox). Call once in BootScene after the
 * placeholders exist and before any world sprite or animation that names
 * these keys is created. Keys whose frame didn't load keep their
 * placeholder. Everything here is built at the delivered art's density
 * (./density.ts): drawing code works in world px on a scaled context, and
 * the few pixel passes (the mailbox flag, the plot sign's board) work in
 * texels, `k` to a world px. Collision bodies, interaction spots and depths are the
 * scenes' and don't change here.
 */

/** Placeholder key → delivered frame, at the frame's native size. */
export const COMMONS_PLACEHOLDER_FRAMES: Readonly<Record<string, string>> = {
  silas: 'silas-idle-0',
  'silas-idle-0': 'silas-idle-0',
  'silas-idle-1': 'silas-idle-1',
  cottage: 'cottage',
  'cottage-silas': 'cottage-silas',
  'cottage-workshop': 'cottage-workshop',
  'camp-windbreak': 'camp-windbreak',
  'camp-cot': 'camp-cot',
  'camp-ring': 'camp-ring',
  'camp-flame-0': 'camp-flame-0',
  'camp-flame-1': 'camp-flame-1',
  'room-fire-0': 'hearth-fire-0',
  'room-fire-1': 'hearth-fire-1',
  'workshop-chest': 'workshop-chest',
  'workshop-bench': 'workshop-bench',
  'mailbox-flag': 'mailbox',
  gatepost: 'gatepost',
  'gate-leaf': 'gate-leaf',
  hame: 'hame',
  'commons-well': 'commons-well',
  'notice-board': 'notice-board',
  firebox: 'firebox',
  sawhorse: 'sawhorse',
  'timber-stack': 'timber-stack',
  skids: 'skids',
  woodpile: 'woodpile',
  'stall-a': 'stall-a',
  'stall-b': 'stall-b',
  'stall-c': 'stall-c',
  'well-canopy': 'well-canopy',
  'mended-bridge': 'mended-bridge',
  'candle-hull': 'candle-hull-0',
  'library-sign': 'library-sign',
  'paper-folded': 'paper-folded-0',
  'paper-scroll': 'paper-scroll-0',
  'paper-slate': 'paper-slate-0',
}

/** A copy of a delivered frame's native texture, and its texels per world px. */
function nativeCopy(scene: Phaser.Scene, frame: CommonsPassFrame): [HTMLCanvasElement, number] {
  const src = artSource(scene, artKey(frame.key))!
  const [c, ctx] = artCanvas(frame.width, frame.height, src.density)
  drawArt(ctx, src, 0, 0)
  return [c, src.density]
}

export function installCommonsPass(scene: Phaser.Scene, items: readonly { id: string; footprint: [number, number] }[]): void {
  for (const [key, name] of Object.entries(COMMONS_PLACEHOLDER_FRAMES)) {
    const frame = commonsFrame(name)
    if (frame) addArtCanvas(scene, key, ...nativeCopy(scene, frame))
  }
  installMailbox(scene)
  installPlotSign(scene)
  for (const w of [64, 96]) installBunting(scene, w)
  installRoom(scene)
  for (const it of items) installDecoration(scene, it.id, it.footprint)
  installPropDecorations(scene)
}

/**
 * Decorations the Commons pass has no frame for, drawn from the props atlas
 * instead (the same lantern post that stands along the Commons lane). The
 * code-drawn placeholder stays when the atlas is missing.
 */
export const PROP_DECORATIONS: Record<string, string> = { 'lantern-post': 'lantern-post' }

function installPropDecorations(scene: Phaser.Scene): void {
  if (!scene.textures.exists('fingersnap-props')) return
  const props = scene.textures.get('fingersnap-props')
  const k = artDensity(scene)
  for (const [id, name] of Object.entries(PROP_DECORATIONS)) {
    if (!props.has(name) || !scene.textures.exists(`deco-${id}`)) continue
    const f = props.get(name)
    const src = f.source.image as HTMLImageElement | HTMLCanvasElement
    for (const key of [`deco-${id}`, `deco-${id}-q`]) {
      const old = artSource(scene, key)!
      const [c, ctx] = artCanvas(old.w, old.h, k)
      const scale = Math.min((old.h - 1) / f.cutHeight, old.w / f.cutWidth)
      const w = Math.round(f.cutWidth * scale)
      const h = Math.round(f.cutHeight * scale)
      resampleFor(ctx, f.cutWidth / w, k)
      ctx.drawImage(src, f.cutX, f.cutY, f.cutWidth, f.cutHeight, Math.round((old.w - w) / 2), old.h - h, w, h)
      addArtCanvas(scene, key, c, k)
    }
  }
}

/** No post waiting: the same box with its red flag taken down. */
function installMailbox(scene: Phaser.Scene): void {
  const frame = commonsFrame('mailbox')
  if (!frame) return
  const [c, k] = nativeCopy(scene, frame)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  const img = ctx.getImageData(0, 0, c.width, c.height)
  const d = img.data
  const at = (x: number, y: number) => (y * c.width + x) * 4
  // In texels: the top 5 world px, right of x 12.
  for (let y = 0; y < 5 * k; y++) {
    for (let x = 12 * k; x < c.width; x++) {
      const i = at(x, y)
      if (d[i + 3] === 0) continue
      const red = d[i] > 120 && d[i] > d[i + 1] * 2
      // The raised flag (and its outline) above the box goes; on the box
      // face the red becomes the wood beside it.
      if (y < 2 * k) d[i + 3] = 0
      else if (red) for (let n = 0; n < 4; n++) d[i + n] = d[at(x - 1, y) + n]
    }
  }
  ctx.putImageData(img, 0, 0)
  addArtCanvas(scene, 'mailbox', c, k)
}

/**
 * Plot signs carry a name in 5-px type, laid out for the placeholder's
 * 40-px board: the delivered board (a third of that) is widened by
 * repeating its middle, ends and post kept as drawn.
 */
function installPlotSign(scene: Phaser.Scene): void {
  const frame = commonsFrame('plot-sign')
  if (!frame) return
  const [src, k] = nativeCopy(scene, frame)
  const sctx = src.getContext('2d', { willReadFrequently: true })!
  const alpha = sctx.getImageData(0, 0, src.width, src.height).data
  const span = (y: number) => {
    let n = 0
    for (let x = 0; x < src.width; x++) if (alpha[(y * src.width + x) * 4 + 3] > 0) n++
    return n
  }
  // In texels from here. Board rows: nearly the art's full width (the post
  // and its cap are narrow).
  const d = { x: frame.destinationRect.x * k, w: frame.destinationRect.w * k }
  const W = frame.width * k
  const rows: number[] = []
  for (let y = 0; y < src.height; y++) if (span(y) >= d.w * 0.7) rows.push(y)
  const c = document.createElement('canvas')
  c.width = src.width
  c.height = src.height
  const ctx = c.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(src, 0, 0)
  if (rows.length > 0) {
    const y0 = rows[0]
    const h = rows[rows.length - 1] - y0 + 1
    const edge = 3 * k
    const x0 = k
    const x1 = W - k
    ctx.clearRect(0, y0, W, h)
    ctx.drawImage(src, d.x, y0, edge, h, x0, y0, edge, h)
    const mid = d.w - edge * 2
    for (let x = x0 + edge; x < x1 - edge; x += mid) ctx.drawImage(src, d.x + edge, y0, Math.min(mid, x1 - edge - x), h, x, y0, Math.min(mid, x1 - edge - x), h)
    ctx.drawImage(src, d.x + d.w - edge, y0, edge, h, x1 - edge, y0, edge, h)
  }
  addArtCanvas(scene, 'plot-sign', c, k)
  const r = document.createElement('canvas')
  r.width = c.width
  r.height = c.height
  r.getContext('2d')!.drawImage(c, 0, 0)
  addArtCanvas(scene, 'plot-sign-reserved', r, k)
}

/** Bunting runs: the delivered swag repeated along the line, ends meeting. */
function installBunting(scene: Phaser.Scene, width: number): void {
  const frame = commonsFrame('bunting')
  if (!frame) return
  const d = frame.destinationRect
  const count = Math.max(1, Math.ceil((width - d.w) / (d.w - 2)) + 1)
  const step = count > 1 ? (width - d.w) / (count - 1) : 0
  const k = artDensity(scene)
  const [c, ctx] = artCanvas(width, frame.height, k)
  for (let i = 0; i < count; i++) blitFrame(scene, frame, ctx, { x: Math.round(i * step), y: d.y, w: d.w, h: d.h })
  addArtCanvas(scene, `bunting-${width}`, c, k)
}

/**
 * The cottage room: the delivered plank floor under the decoration grid and
 * the doorway (alternating flips so repeated edges meet), the code-drawn
 * side and near walls over it, and the delivered back wall across the top.
 */
function installRoom(scene: Phaser.Scene): void {
  const wall = commonsFrame('interior-back-wall')
  const floor = commonsFrame('interior-floor')
  if (!wall && !floor) return
  const W = ROOM_W * 16
  const H = ROOM_H * 16
  const k = artDensity(scene)
  const [c, ctx] = artCanvas(W, H, k)
  const tile = floor ? artSource(scene, artKey(floor.key)) : null
  if (tile) {
    const cells: [number, number][] = []
    for (let ty = 3; ty < ROOM_H - 1; ty++) for (let tx = 1; tx < ROOM_W - 1; tx++) cells.push([tx, ty])
    cells.push([6, ROOM_H - 1], [7, ROOM_H - 1])
    for (const [tx, ty] of cells) {
      const { flipX, flipY } = floorTileOrientation(tx, ty)
      ctx.save()
      ctx.translate(tx * 16 + (flipX ? 16 : 0), ty * 16 + (flipY ? 16 : 0))
      ctx.scale(flipX ? -1 : 1, flipY ? -1 : 1)
      drawArt(ctx, tile, 0, 0)
      ctx.restore()
    }
  }
  const walls = artSource(scene, 'room-walls')
  if (walls) drawArt(ctx, walls, 0, 0)
  const back = wall ? artSource(scene, artKey(wall.key)) : null
  if (wall && back) {
    const d = wall.destinationRect
    ctx.clearRect(d.x, 0, d.w, wall.height)
    drawArt(ctx, back, 0, 0)
  }
  addArtCanvas(scene, 'room-walls', c, k)
}

/**
 * Alternate reflected floor cells in a 2×2 arrangement so repeated plank
 * edges meet (the pack's `floorTileOrientation`).
 */
export function floorTileOrientation(column: number, row: number): { flipX: boolean; flipY: boolean } {
  return { flipX: (column & 1) === 1, flipY: (row & 1) === 1 }
}

function installDecoration(scene: Phaser.Scene, id: string, footprint: [number, number]): void {
  const frame = commonsFrame(id)
  if (!frame) return
  const k = artDensity(scene)
  for (const quarter of [false, true]) {
    const { width, height, dest } = decorationLayout(id, frame, footprint, quarter)
    const [c, ctx] = artCanvas(width, height, k)
    blitFrame(scene, frame, ctx, dest)
    addArtCanvas(scene, quarter ? `deco-${id}-q` : `deco-${id}`, c, k)
  }
}
