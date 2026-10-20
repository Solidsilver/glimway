/**
 * The world lab's camera and what to ask the server for (dev builds only;
 * WorldLab.svelte, server/internal/worldlab). Pure, for Node tests.
 *
 * The camera is in world tiles: (x, y) is the tile at the middle of the
 * pane, zoom is CSS pixels per tile. Renders are in inclusive chunk
 * rectangles, as the server takes them.
 */

export type LabView = 'atlas' | 'region' | 'chunk'
export type LabMode = 'auto' | LabView

export interface Camera {
  x: number
  y: number
  zoom: number
}

/** A rectangle of chunks, both ends included: x0, y0, x1, y1. */
export type Rect = [number, number, number, number]

export interface Plan {
  view: LabView
  rect: Rect
  scale: number
}

export interface Limits {
  atlasChunks: number
  tiles: number
  pixels: number
  scale: number
  coordinate: number
}

/** The zoom range, CSS px per tile: from a thousand chunks across a screen to a tile's details. */
export const ZOOM_MIN = 1 / 48
export const ZOOM_MAX = 40
/** Below a pixel a tile the atlas is enough; the region view from there on. */
export const REGION_ZOOM = 1
/** The zoom each view's button jumps to. */
export const VIEW_ZOOM: Record<LabView, number> = { atlas: 0.25, region: 3, chunk: 16 }

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom))
}

/** The view the camera shows in a mode. */
export function viewOf(mode: LabMode, zoom: number): LabView {
  if (mode !== 'auto') return mode
  return zoom < REGION_ZOOM ? 'atlas' : 'region'
}

/** The world tile under a pane point (CSS px from the pane's top left). */
export function tileAt(cam: Camera, pane: { w: number; h: number }, px: number, py: number): { tx: number; ty: number } {
  return { tx: Math.floor(cam.x + (px - pane.w / 2) / cam.zoom), ty: Math.floor(cam.y + (py - pane.h / 2) / cam.zoom) }
}

/** Zoom by `factor` keeping the tile under (px, py) where it is. */
export function zoomAround(cam: Camera, pane: { w: number; h: number }, px: number, py: number, factor: number): Camera {
  const zoom = clampZoom(cam.zoom * factor)
  const wx = cam.x + (px - pane.w / 2) / cam.zoom
  const wy = cam.y + (py - pane.h / 2) / cam.zoom
  return { zoom, x: wx - (px - pane.w / 2) / zoom, y: wy - (py - pane.h / 2) / zoom }
}

/** The chunks a pane shows, both ends included. */
export function visibleChunks(cam: Camera, pane: { w: number; h: number }, chunkSize: number): Rect {
  const hw = pane.w / 2 / cam.zoom
  const hh = pane.h / 2 / cam.zoom
  return [
    Math.floor((cam.x - hw) / chunkSize),
    Math.floor((cam.y - hh) / chunkSize),
    Math.floor((cam.x + hw) / chunkSize),
    Math.floor((cam.y + hh) / chunkSize)
  ]
}

const floorTo = (v: number, n: number) => Math.floor(v / n) * n
const clampC = (v: number, lim: number) => Math.max(-lim, Math.min(lim, v))

/**
 * Grow a visible rectangle by a margin and snap it to a grid, so a small
 * pan needs no new render; then crop it around its middle to at most
 * `max` chunks.
 */
function padded(vis: Rect, snap: number, max: number, lim: number): Rect {
  const w = vis[2] - vis[0] + 1
  const h = vis[3] - vis[1] + 1
  const mx = Math.ceil(w / 4)
  const my = Math.ceil(h / 4)
  let r: Rect = [floorTo(vis[0] - mx, snap), floorTo(vis[1] - my, snap), floorTo(vis[2] + mx, snap) + snap - 1, floorTo(vis[3] + my, snap) + snap - 1]
  r = shrinkTo(r, vis, max)
  return [clampC(r[0], lim), clampC(r[1], lim), clampC(r[2], lim), clampC(r[3], lim)]
}

/** Crop r (keeping as much of vis as fits) until it holds at most max chunks. */
function shrinkTo(r: Rect, vis: Rect, max: number): Rect {
  let [x0, y0, x1, y1] = r
  while ((x1 - x0 + 1) * (y1 - y0 + 1) > max) {
    // Drop the margin first, then the visible edges, the longer side first.
    const w = x1 - x0 + 1
    const h = y1 - y0 + 1
    if (w >= h) {
      if (x0 < vis[0]) x0 = Math.min(vis[0], x0 + Math.ceil(w / 8))
      else if (x1 > vis[2]) x1 = Math.max(vis[2], x1 - Math.ceil(w / 8))
      else {
        const cut = Math.max(1, Math.ceil((w - Math.floor(max / h)) / 2))
        x0 += cut
        x1 -= cut
      }
    } else {
      if (y0 < vis[1]) y0 = Math.min(vis[1], y0 + Math.ceil(h / 8))
      else if (y1 > vis[3]) y1 = Math.max(vis[3], y1 - Math.ceil(h / 8))
      else {
        const cut = Math.max(1, Math.ceil((h - Math.floor(max / w)) / 2))
        y0 += cut
        y1 -= cut
      }
    }
    if (x1 < x0) x1 = x0
    if (y1 < y0) y1 = y0
  }
  return [x0, y0, x1, y1]
}

export const rectChunks = (r: Rect): number => (r[2] - r[0] + 1) * (r[3] - r[1] + 1)

/**
 * The render to ask for: the view the mode and zoom call for, over the
 * visible chunks and a margin, at the scale the zoom needs, inside the
 * server's limits. A dense region that wouldn't fit falls back to the
 * atlas in auto mode, or is cropped around the middle.
 */
export function plan(cam: Camera, pane: { w: number; h: number }, chunkSize: number, mode: LabMode, limits: Limits): Plan {
  const vis = visibleChunks(cam, pane, chunkSize)
  let view = viewOf(mode, cam.zoom)
  const perChunk = chunkSize * chunkSize
  if (view === 'chunk') {
    const cx = Math.floor(cam.x / chunkSize)
    const cy = Math.floor(cam.y / chunkSize)
    return { view, rect: [cx, cy, cx, cy], scale: Math.min(limits.scale, 8) }
  }
  if (view === 'region' && mode === 'auto' && rectChunks(vis) * perChunk > limits.tiles) view = 'atlas'
  if (view === 'atlas') {
    let scale = Math.max(1, Math.min(limits.scale, Math.round(cam.zoom * chunkSize)))
    const rect = padded(vis, 8, limits.atlasChunks, limits.coordinate)
    while (scale > 1 && rectChunks(rect) * scale * scale > limits.pixels) scale -= 1
    return { view, rect: fitPixels(rect, vis, scale * scale, limits.pixels), scale }
  }
  let scale = Math.max(1, Math.min(4, limits.scale, Math.floor(cam.zoom)))
  let rect = padded(vis, 2, Math.floor(limits.tiles / perChunk), limits.coordinate)
  while (scale > 1 && rectChunks(rect) * perChunk * scale * scale > limits.pixels) scale -= 1
  rect = fitPixels(rect, vis, perChunk * scale * scale, limits.pixels)
  return { view, rect, scale }
}

function fitPixels(rect: Rect, vis: Rect, pxPerChunk: number, pixels: number): Rect {
  return shrinkTo(rect, vis, Math.max(1, Math.floor(pixels / pxPerChunk)))
}

/** An image already drawn covers what the camera shows now, at the planned view and scale. */
export function covers(have: Plan, want: Plan, vis: Rect): boolean {
  if (have.view !== want.view || have.scale !== want.scale) return false
  if (want.view === 'chunk') return have.rect[0] === want.rect[0] && have.rect[1] === want.rect[1]
  const [x0, y0, x1, y1] = have.rect
  const need = [Math.max(vis[0], want.rect[0]), Math.max(vis[1], want.rect[1]), Math.min(vis[2], want.rect[2]), Math.min(vis[3], want.rect[3])]
  return x0 <= need[0] && y0 <= need[1] && x1 >= need[2] && y1 >= need[3]
}

/** Where a render's image lies in world tiles: its top-left tile and size. */
export function placement(p: Plan, chunkSize: number): { x: number; y: number; w: number; h: number } {
  return { x: p.rect[0] * chunkSize, y: p.rect[1] * chunkSize, w: (p.rect[2] - p.rect[0] + 1) * chunkSize, h: (p.rect[3] - p.rect[1] + 1) * chunkSize }
}

/** A share as a percentage for the stats panel: 12.3%. */
export function percent(v: number): string {
  if (v > 0 && v < 0.001) return '<0.1%'
  return `${(v * 100).toFixed(1)}%`
}

/** A map's entries by value, largest first. */
export function ranked(m: Record<string, number> | undefined): [string, number][] {
  return Object.entries(m ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/**
 * JSON.parse's complaint, with the line and column where the text stops
 * being JSON (engines don't always say where), or null for good JSON.
 */
export function jsonProblem(text: string): string | null {
  try {
    JSON.parse(text)
    return null
  } catch (e) {
    const msg = e instanceof Error ? e.message.split('\n')[0] : String(e)
    const pos = jsonBreak(text)
    const before = text.slice(0, pos)
    const line = before.split('\n').length
    const col = pos - before.lastIndexOf('\n')
    return `Line ${line}, column ${col}: ${msg.length > 120 ? msg.slice(0, 120) + '…' : msg}`
  }
}

/** Where a text stops being JSON: the offset of the first character that can't continue it. */
export function jsonBreak(t: string): number {
  let i = 0
  const ws = () => {
    while (i < t.length && ' \t\n\r'.includes(t[i])) i++
  }
  const fail = (): never => {
    throw i
  }
  const lit = (word: string) => {
    for (const ch of word) {
      if (t[i] !== ch) fail()
      i++
    }
  }
  const str = () => {
    i++
    while (i < t.length && t[i] !== '"') {
      if (t.charCodeAt(i) < 0x20) fail()
      if (t[i] === '\\') {
        i++
        if (t[i] === 'u') {
          for (let k = 1; k <= 4; k++) {
            if (!/[0-9a-fA-F]/.test(t[i + k] ?? '')) {
              i += k
              fail()
            }
          }
          i += 4
        } else if (!'"\\/bfnrt'.includes(t[i] ?? 'x')) fail()
      }
      i++
    }
    if (t[i] !== '"') fail()
    i++
  }
  const num = () => {
    const m = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(t.slice(i, i + 400))
    if (!m || !m[0] || m[0] === '-') fail()
    i += m![0].length
  }
  const value = (): void => {
    ws()
    const c = t[i]
    if (c === '{') {
      i++
      ws()
      if (t[i] === '}') return void i++
      for (;;) {
        ws()
        if (t[i] !== '"') fail()
        str()
        ws()
        if (t[i] !== ':') fail()
        i++
        value()
        ws()
        if (t[i] === ',') i++
        else if (t[i] === '}') return void i++
        else fail()
      }
    }
    if (c === '[') {
      i++
      ws()
      if (t[i] === ']') return void i++
      for (;;) {
        value()
        ws()
        if (t[i] === ',') i++
        else if (t[i] === ']') return void i++
        else fail()
      }
    }
    if (c === '"') return str()
    if (c === 't') return lit('true')
    if (c === 'f') return lit('false')
    if (c === 'n') return lit('null')
    if (c === '-' || (c >= '0' && c <= '9')) return num()
    fail()
  }
  try {
    value()
    ws()
    return i < t.length ? i : t.length
  } catch (at) {
    return typeof at === 'number' ? Math.min(at, t.length) : 0
  }
}
