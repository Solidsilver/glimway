/**
 * Draws the world map's terrain into a viewport-sized canvas
 * (docs/design/world-map.md 4). The canvas never grows with the world: only
 * what's in view is drawn, however far you've walked.
 *
 * - Close in ("detailed"), each walked chunk in view is its own raster at a
 *   tile a pixel, cached by chunk and revision in a bounded LRU
 *   (MAP_RASTER_CACHE entries, about 2.25 MiB of pixels).
 * - Further out, one overview of the walked land, a few pixels a chunk (or a
 *   chunk a pixel, or several chunks a pixel for a very wide map), built when
 *   the map's input changes and never per drag.
 * - Parchment, the chunk grid, the glimpse past the drift and the frontier's
 *   edge are drawn straight into the viewport: nothing is allocated for the
 *   blank land between walked chunks.
 * - Ways and places are marks over it, kept in buckets so a pan looks only
 *   at the ones near the view. You (the dot) and the labels are DOM on their
 *   own layer (src/ui/WorldMap.svelte), so moving them never redraws terrain.
 *
 * No network and no Svelte: the input comes from src/game/wilds/map-data.ts,
 * the view from src/lib/wilds/map-view.ts. `makeImage` turns pixels into
 * something drawImage takes (a canvas in the browser; anything in tests).
 */
import { loadWilds } from '../lib/wilds/data.ts'
import {
  GLIMPSE_ALPHA,
  MAP_COLOURS,
  PLACE_MARK,
  chunkRaster,
  fitLabels,
  frameTiles,
  glimpseColour,
  glimpseRaster,
  mapBounds,
  mapFrame,
  mapMarks,
  onMapGrid,
  mapEdges,
  shrinkRaster,
  type MapChunk,
  type MapInput,
  type MapLabel,
  type MapMarks
} from '../lib/wilds/map-model.ts'
import { toScreen, visibleTiles, type MapView, type MapViewport, type TileRect } from '../lib/wilds/map-view.ts'

/** Turns RGBA pixels into something the canvas can draw. */
export type MakeImage = (rgba: Uint8ClampedArray, w: number, h: number) => CanvasImageSource

/** The canvas calls the renderer makes (a CanvasRenderingContext2D, or a test's recorder). */
export type MapCtx = Pick<
  CanvasRenderingContext2D,
  'beginPath' | 'moveTo' | 'lineTo' | 'stroke' | 'setTransform' | 'clearRect' | 'fillRect' | 'drawImage' | 'strokeRect' | 'setLineDash' | 'fillStyle' | 'strokeStyle' | 'lineWidth' | 'globalAlpha' | 'imageSmoothingEnabled'
>

/** Chunk rasters kept at most (24×24 RGBA each: about 2.25 MiB of pixels in all). */
export const MAP_RASTER_CACHE = 1024
/** Hatch the glimpse's river (a raster a chunk) only while this many chunk slots fit in the viewport. */
export const DETAIL_SLOTS = 512
/** Draw walked chunks from their own rasters while at most this many are in view (half the cache, so it never thrashes). */
export const DETAIL_CHUNKS = 512
/** …and while a chunk is at least this many device pixels across (smaller, its raster is only noise). */
const DETAIL_MIN_PX = 6
/** The overview's longest side, in pixels (at most 4 MiB of pixels). */
export const OVERVIEW_MAX_PX = 1024
/** The overview's pixels a chunk when the frame is small enough (one summary pixel for 4×4 tiles). */
const OVERVIEW_FINE = 6
/** Marks are bucketed by this many tiles a side. */
const BUCKET = 96

/** The canvas's backing size for a viewport: device pixels, at most 2× (the plan's memory bound). */
export function backingSize(vp: MapViewport, dpr: number): { w: number; h: number; r: number } {
  const r = Math.min(2, dpr > 0 ? dpr : 1)
  return { w: Math.max(1, Math.round(vp.w * r)), h: Math.max(1, Math.round(vp.h * r)), r }
}

const css = (c: ArrayLike<number>, a = 1) => (a >= 1 ? `rgb(${c[0]},${c[1]},${c[2]})` : `rgba(${c[0]},${c[1]},${c[2]},${a})`)

/** A chunk's revision when map-data didn't name one: a hash of its ground. */
function hashChunk(c: MapChunk): string {
  let h = 2166136261
  for (const row of c.ground) for (const t of row) h = Math.imul(h ^ t, 16777619)
  for (const row of c.solid) for (const s of row) h = Math.imul(h ^ (s ? 1 : 0), 16777619)
  return (h >>> 0).toString(36)
}

interface Overview {
  img: CanvasImageSource
  /** Chunks a pixel along each side (1/6 when six pixels a chunk). */
  chunksPerPx: number
  minCx: number
  minCy: number
  w: number
  h: number
}

export interface MapDrawStats {
  /**
   * How the walked land was drawn: each chunk's raster (`detail`), the
   * overview image (`overview`, only where its pixel covers at most one chunk
   * or less than a device pixel), or each chunk in its mean colour (`chunks`,
   * where the overview's pixel would cover several chunks and show on
   * screen: it would paint land nobody walked).
   */
  level: 'detail' | 'overview' | 'chunks' | 'none'
  /** Chunk rasters drawn this frame. */
  chunks: number
}

export class MapRenderer {
  private input: MapInput | null = null
  private scope = ''
  /** Walked chunks inside the frontier, by key. */
  private byKey = new Map<string, MapChunk & { rev: string }>()
  /** The revision each chunk's cached raster was made from. */
  private revAt = new Map<string, string>()
  /** Chunk images, least recently drawn first. */
  private rasters = new Map<string, CanvasImageSource>()
  /** Per-chunk summaries for the overview, by key: kept while the revision holds. */
  private summaries = new Map<string, { rev: string; fine: Uint8ClampedArray; mean: Uint8ClampedArray }>()
  private glimpses = new Map<string, CanvasImageSource>()
  private overview: Overview | null = null
  private overviewDirty = true
  private marks: MapMarks = { wayTiles: [], places: [], labels: [] }
  private wayBuckets = new Map<string, { x: number; y: number }[]>()
  private placeBuckets = new Map<string, MapMarks['places']>()
  private frameChunks = { minCx: 0, minCy: 0, maxCx: 0, maxCy: 0 }
  /** What the overview was built from (the frame and every chunk's revision): unchanged land keeps it. */
  private overviewSig = ''

  /** Work done, for tests and the performance check. */
  readonly stats = { rasters: 0, images: 0, overviews: 0, summaries: 0 }

  private readonly makeImage: MakeImage

  constructor(makeImage: MakeImage) {
    this.makeImage = makeImage
  }

  /**
   * New input (a read, a path, a find): index it and drop only what changed.
   * Another world or wick (`scope`) forgets every raster.
   */
  setInput(input: MapInput, scope: string): void {
    if (scope !== this.scope) {
      this.rasters.clear()
      this.revAt.clear()
      this.summaries.clear()
      this.scope = scope
    }
    this.input = input
    const f = input.frontier
    this.byKey.clear()
    for (const c of [...input.chunks, ...(input.fixed ?? [])]) {
      if (!onMapGrid(f, c.cx, c.cy)) continue
      const key = `${c.cx},${c.cy}`
      const rev = c.rev ?? hashChunk(c)
      this.byKey.set(key, { ...c, rev })
      const had = this.revAt.get(key)
      if (had !== undefined && had !== rev) {
        this.rasters.delete(key)
        this.revAt.delete(key)
      }
    }
    // Chunks no longer on the map (a turning within the scope) go too.
    for (const key of [...this.revAt.keys()])
      if (!this.byKey.has(key)) {
        this.revAt.delete(key)
        this.rasters.delete(key)
      }
    for (const key of [...this.summaries.keys()]) if (this.byKey.get(key)?.rev !== this.summaries.get(key)!.rev) this.summaries.delete(key)
    this.marks = mapMarks(input)
    this.wayBuckets.clear()
    this.placeBuckets.clear()
    const bucket = <T>(m: Map<string, T[]>, x: number, y: number, v: T) => {
      const k = `${Math.floor(x / BUCKET)},${Math.floor(y / BUCKET)}`
      let list = m.get(k)
      if (!list) m.set(k, (list = []))
      list.push(v)
    }
    for (const t of this.marks.wayTiles) bucket(this.wayBuckets, t.x, t.y, t)
    for (const p of this.marks.places) bucket(this.placeBuckets, p.tx, p.ty, p)
    this.frameChunks = mapFrame(input)
    // The overview is rebuilt only when the land it shows changed (not on every read's news).
    let h = 0
    for (const [key, c] of this.byKey) {
      let x = 2166136261
      for (const ch of key + c.rev) x = Math.imul(x ^ ch.charCodeAt(0), 16777619)
      h = (h + (x >>> 0)) >>> 0
    }
    const fr = this.frameChunks
    const sig = `${fr.minCx},${fr.minCy},${fr.maxCx},${fr.maxCy}|${this.byKey.size}|${h}|${scope}`
    if (sig !== this.overviewSig) {
      this.overviewSig = sig
      this.overviewDirty = true
    }
  }

  /** The displayed frame in tiles (the view's clamp; all known land, wherever the view is). */
  frame(): TileRect | null {
    return this.input ? frameTiles(this.frameChunks) : null
  }

  /** Cached chunk rasters (at most MAP_RASTER_CACHE). */
  get cached(): number {
    return this.rasters.size
  }

  /** Draw the view into a canvas of backingSize(vp, dpr). */
  draw(ctx: MapCtx, view: MapView, vp: MapViewport, dpr: number): MapDrawStats {
    const { w: W, h: H, r } = backingSize(vp, dpr)
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.globalAlpha = 1
    ctx.clearRect(0, 0, W, H)
    const input = this.input
    if (!input) return { level: 'none', chunks: 0 }
    const S = loadWilds().chunkSize
    const k = view.scale * r
    // The world's origin, on a whole device pixel: every edge below is rounded from it, so chunks meet without seams.
    const ox = Math.round((vp.w / 2 - view.scale * view.cx) * r)
    const oy = Math.round((vp.h / 2 - view.scale * view.cy) * r)
    const X = (tx: number) => Math.round(ox + tx * k)
    const Y = (ty: number) => Math.round(oy + ty * k)
    const vis = visibleTiles(view, vp)
    const vc = { minCx: Math.floor(vis.minTx / S), minCy: Math.floor(vis.minTy / S), maxCx: Math.floor(vis.maxTx / S), maxCy: Math.floor(vis.maxTy / S) }
    const f = input.frontier
    const chunkCss = S * view.scale
    const slots = (Math.ceil(vp.w / chunkCss) + 1) * (Math.ceil(vp.h / chunkCss) + 1)
    const hatch = slots <= DETAIL_SLOTS
    ctx.imageSmoothingEnabled = false

    // Past the drift: the glimpse's wash (hatched for the Wend, close in).
    for (const g of input.glimpse) {
      if (g.cx < vc.minCx || g.cx > vc.maxCx || g.cy < vc.minCy || g.cy > vc.maxCy) continue
      if (onMapGrid(f, g.cx, g.cy)) continue
      const x0 = X(g.cx * S)
      const y0 = Y(g.cy * S)
      const w = X((g.cx + 1) * S) - x0
      const h = Y((g.cy + 1) * S) - y0
      if (hatch && g.river) {
        ctx.drawImage(this.glimpse(g.land, g.cx, g.cy), x0, y0, w, h)
      } else {
        ctx.fillStyle = css(glimpseColour(g.land), GLIMPSE_ALPHA / 255)
        ctx.fillRect(x0, y0, w, h)
      }
    }

    // The frontier: parchment, and a faint chunk grid where the cells are big enough to read.
    const fx0 = Math.max(f.minCx, vc.minCx)
    const fx1 = Math.min(f.maxCx, vc.maxCx)
    const fy0 = Math.max(f.minCy, vc.minCy)
    const fy1 = Math.min(f.maxCy, vc.maxCy)
    ctx.fillStyle = css(MAP_COLOURS.parchment)
    for (let cy = fy0; cy <= fy1; cy++) for (let cx = fx0; cx <= fx1; cx++) {
      if (!onMapGrid(f, cx, cy)) continue
      const x = X(cx * S), y = Y(cy * S), w = X((cx + 1) * S) - x, h = Y((cy + 1) * S) - y
      ctx.fillStyle = css(MAP_COLOURS.parchment)
      ctx.fillRect(x, y, w, h)
      if (chunkCss >= 12) {
        ctx.fillStyle = css(MAP_COLOURS.grid)
        const line = Math.max(1, Math.round(r))
        ctx.fillRect(x, y, line, h)
        ctx.fillRect(x, y, w, line)
      }
    }

    // Walked land (and the fixed footprints'), at a resolution chosen from how big it lands on screen.
    let drawn = 0
    let level: MapDrawStats['level'] = 'none'
    const g = mapBounds(input)
    const gx0 = Math.max(g.minCx, vc.minCx)
    const gx1 = Math.min(g.maxCx, vc.maxCx)
    const gy0 = Math.max(g.minCy, vc.minCy)
    const gy1 = Math.min(g.maxCy, vc.maxCy)
    if (gx0 <= gx1 && gy0 <= gy1) {
      const walked = this.walkedIn(gx0, gy0, gx1, gy1)
      const chunkPx = S * k
      const o = walked.length > DETAIL_CHUNKS || chunkPx < DETAIL_MIN_PX ? this.overviewImage() : null
      if (!o) {
        // Few enough in view, big enough to read: each chunk's own raster.
        level = 'detail'
        for (const c of walked) {
          const x0 = X(c.cx * S)
          const y0 = Y(c.cy * S)
          ctx.drawImage(this.raster(c), x0, y0, X((c.cx + 1) * S) - x0, Y((c.cy + 1) * S) - y0)
          drawn++
        }
      } else if (o.chunksPerPx <= 1 || chunkPx * o.chunksPerPx <= 1) {
        // The overview, where each of its pixels is one chunk's (or a few tiles'), or smaller than a device pixel.
        level = 'overview'
        const per = o.chunksPerPx
        const sx = Math.max(0, Math.floor((gx0 - o.minCx) / per))
        const sy = Math.max(0, Math.floor((gy0 - o.minCy) / per))
        const ex = Math.min(o.w, Math.ceil((gx1 + 1 - o.minCx) / per))
        const ey = Math.min(o.h, Math.ceil((gy1 + 1 - o.minCy) / per))
        if (ex > sx && ey > sy) {
          ctx.imageSmoothingEnabled = chunkPx * per < 1
          const dx = X((o.minCx + sx * per) * S)
          const dy = Y((o.minCy + sy * per) * S)
          ctx.drawImage(o.img, sx, sy, ex - sx, ey - sy, dx, dy, X((o.minCx + ex * per) * S) - dx, Y((o.minCy + ey * per) * S) - dy)
          ctx.imageSmoothingEnabled = false
        }
      } else {
        // The overview's pixel would cover several chunks and show: each walked chunk in its own mean colour instead.
        level = 'chunks'
        for (const c of walked) {
          const m = this.summary(c).mean
          ctx.fillStyle = css(m)
          const x0 = X(c.cx * S)
          const y0 = Y(c.cy * S)
          ctx.fillRect(x0, y0, Math.max(1, X((c.cx + 1) * S) - x0), Math.max(1, Y((c.cy + 1) * S) - y0))
          drawn++
        }
      }
    }

    // The frontier's edge, dashed in the drift's colour.
    ctx.strokeStyle = css(MAP_COLOURS.drift)
    ctx.lineWidth = Math.max(1, Math.round(2 * r))
    ctx.setLineDash([6 * r, 6 * r])
    ctx.beginPath()
    for (const e of mapEdges(f)) {
      ctx.moveTo(X(e.x0), Y(e.y0))
      ctx.lineTo(X(e.x1), Y(e.y1))
    }
    ctx.stroke()
    ctx.setLineDash([])

    // Ways along their tiles, then the places' crosses, never smaller than a pixel or two.
    const near = <T>(m: Map<string, T[]>, each: (v: T) => void) => {
      const b = { x0: Math.floor(vis.minTx / BUCKET), y0: Math.floor(vis.minTy / BUCKET), x1: Math.floor(vis.maxTx / BUCKET), y1: Math.floor(vis.maxTy / BUCKET) }
      // Look up the buckets in view, or, zoomed far out, walk the buckets there are.
      if ((b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1) <= m.size) {
        for (let by = b.y0; by <= b.y1; by++) for (let bx = b.x0; bx <= b.x1; bx++) for (const v of m.get(`${bx},${by}`) ?? []) each(v)
        return
      }
      for (const [key, list] of m) {
        const [bx, by] = key.split(',').map(Number) as [number, number]
        if (bx >= b.x0 && bx <= b.x1 && by >= b.y0 && by <= b.y1) for (const v of list) each(v)
      }
    }
    const way = Math.max(k, 1.5 * r)
    ctx.fillStyle = css(MAP_COLOURS.way)
    near(this.wayBuckets, (t) => ctx.fillRect(Math.round(ox + (t.x + 0.5) * k - way / 2), Math.round(oy + (t.y + 0.5) * k - way / 2), Math.ceil(way), Math.ceil(way)))
    const u = Math.max(k, 2 * r)
    near(this.placeBuckets, (p) => {
      ctx.fillStyle = css(p.found ? MAP_COLOURS.found : MAP_COLOURS.landmark)
      const cx = ox + (p.tx + 0.5) * k
      const cy = oy + (p.ty + 0.5) * k
      for (const [dx, dy] of PLACE_MARK) ctx.fillRect(Math.round(cx + (dx - 0.5) * u), Math.round(cy + (dy - 0.5) * u), Math.ceil(u), Math.ceil(u))
    })
    return { level, chunks: drawn }
  }

  /**
   * The labels to show for this view, in viewport CSS px: those near the
   * view (a label's width past each edge), you among them, then fitted so
   * none overlap.
   */
  labels(view: MapView, vp: MapViewport, you: { x: number; y: number; text: string } | null): MapLabel[] {
    const vis = visibleTiles(view, vp, 160)
    const out: MapLabel[] = []
    for (const l of this.marks.labels) {
      if (l.x < vis.minTx || l.x > vis.maxTx || l.y < vis.minTy || l.y > vis.maxTy) continue
      out.push({ ...l, ...toScreen(view, vp, l.x + 0.5, l.y + 0.5) })
    }
    if (you) out.push({ kind: 'you', text: you.text, ...toScreen(view, vp, you.x, you.y) })
    // Boxes wholly off screen (yours too) are dropped before fitting: they can't push out one that shows.
    return fitLabels(out, 1, vp)
  }

  /** The walked chunks in a chunk rectangle: looked up cell by cell, or, for a wide view, from the chunks there are. */
  private walkedIn(x0: number, y0: number, x1: number, y1: number): (MapChunk & { rev: string })[] {
    const out: (MapChunk & { rev: string })[] = []
    if ((x1 - x0 + 1) * (y1 - y0 + 1) <= this.byKey.size) {
      for (let cy = y0; cy <= y1; cy++)
        for (let cx = x0; cx <= x1; cx++) {
          const c = this.byKey.get(`${cx},${cy}`)
          if (c) out.push(c)
        }
      return out
    }
    for (const c of this.byKey.values()) if (c.cx >= x0 && c.cx <= x1 && c.cy >= y0 && c.cy <= y1) out.push(c)
    return out
  }

  private raster(c: MapChunk & { rev: string }): CanvasImageSource {
    const key = `${c.cx},${c.cy}`
    const had = this.rasters.get(key)
    if (had && this.revAt.get(key) === c.rev) {
      // Most recently used goes last.
      this.rasters.delete(key)
      this.rasters.set(key, had)
      return had
    }
    const S = loadWilds().chunkSize
    this.stats.rasters++
    this.stats.images++
    const img = this.makeImage(chunkRaster(c), S, S)
    this.rasters.set(key, img)
    this.revAt.set(key, c.rev)
    while (this.rasters.size > MAP_RASTER_CACHE) {
      const oldest = this.rasters.keys().next().value!
      this.rasters.delete(oldest)
      this.revAt.delete(oldest)
    }
    return img
  }

  private glimpse(land: string, cx: number, cy: number): CanvasImageSource {
    const S = loadWilds().chunkSize
    // The hatching repeats every five tiles: five phases a land.
    const phase = (((cx * S + cy * S) % 5) + 5) % 5
    const key = `${land}:${phase}`
    let img = this.glimpses.get(key)
    if (!img) {
      this.stats.images++
      img = this.makeImage(glimpseRaster(land, true, cx, cy), S, S)
      this.glimpses.set(key, img)
    }
    return img
  }

  private summary(c: MapChunk & { rev: string }): { fine: Uint8ClampedArray; mean: Uint8ClampedArray } {
    const key = `${c.cx},${c.cy}`
    const had = this.summaries.get(key)
    if (had && had.rev === c.rev) return had
    const S = loadWilds().chunkSize
    const full = chunkRaster(c)
    this.stats.summaries++
    const s = { rev: c.rev, fine: shrinkRaster(full, S, S / OVERVIEW_FINE), mean: shrinkRaster(full, S, S) }
    this.summaries.set(key, s)
    return s
  }

  /** The overview of the walked land, rebuilt after the input changes (not per frame). */
  private overviewImage(): Overview | null {
    if (!this.overviewDirty) return this.overview
    this.overviewDirty = false
    const fr = this.frameChunks
    const fw = fr.maxCx - fr.minCx + 1
    const fh = fr.maxCy - fr.minCy + 1
    const longest = Math.max(fw, fh)
    const fine = longest * OVERVIEW_FINE <= OVERVIEW_MAX_PX
    const per = fine ? 1 / OVERVIEW_FINE : Math.max(1, Math.ceil(longest / OVERVIEW_MAX_PX))
    const w = Math.max(1, Math.ceil(fw / per))
    const h = Math.max(1, Math.ceil(fh / per))
    const rgba = new Uint8ClampedArray(w * h * 4)
    if (fine) {
      const n = OVERVIEW_FINE
      for (const c of this.byKey.values()) {
        const src = this.summary(c).fine
        const x0 = (c.cx - fr.minCx) * n
        const y0 = (c.cy - fr.minCy) * n
        if (x0 < 0 || y0 < 0 || x0 >= w || y0 >= h) continue
        for (let y = 0; y < n; y++) rgba.set(src.subarray(y * n * 4, (y + 1) * n * 4), ((y0 + y) * w + x0) * 4)
      }
    } else {
      // A chunk a pixel, or the mean of several chunks a pixel: only walked chunks count.
      // Sums in 32 bits and counts in 16 (a pixel holds at most a few hundred chunks): 14 bytes a pixel, not 32.
      const sum = new Uint32Array(w * h * 3)
      const count = new Uint16Array(w * h)
      for (const c of this.byKey.values()) {
        const x = Math.floor((c.cx - fr.minCx) / per)
        const y = Math.floor((c.cy - fr.minCy) / per)
        if (x < 0 || y < 0 || x >= w || y >= h) continue
        const m = this.summary(c).mean
        const p = y * w + x
        sum[p * 3] += m[0]!
        sum[p * 3 + 1] += m[1]!
        sum[p * 3 + 2] += m[2]!
        count[p] += 1
      }
      for (let p = 0; p < w * h; p++) {
        const n = count[p]!
        if (!n) continue
        rgba[p * 4] = sum[p * 3]! / n
        rgba[p * 4 + 1] = sum[p * 3 + 1]! / n
        rgba[p * 4 + 2] = sum[p * 3 + 2]! / n
        rgba[p * 4 + 3] = 255
      }
    }
    this.stats.overviews++
    this.stats.images++
    this.overview = { img: this.makeImage(rgba, w, h), chunksPerPx: per, minCx: fr.minCx, minCy: fr.minCy, w, h }
    return this.overview
  }
}

/** In the browser: pixels into a small canvas drawImage can scale. */
export function canvasImage(rgba: Uint8ClampedArray, w: number, h: number): CanvasImageSource {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')?.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0)
  return c
}
