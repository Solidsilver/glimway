/** Coarse dev height map: separate from the explored-land renderer and SL2. */
import { onMapGrid } from '../../lib/wilds/map-model.ts'
import { visibleTiles, toScreen, type MapView, type MapViewport } from '../../lib/wilds/map-view.ts'

export interface HeightChunk { cx: number; cy: number; height: number[]; kind: number[]; dx: number[]; dy: number[] }
export interface HeightMark { kind: 'pass' | 'spire'; x: number; y: number }
export interface HeightReply { recipe: string; step: number; chunks: HeightChunk[]; marks: HeightMark[] }
export const HEIGHT_CACHE = 1024
export const HEIGHT_BATCH = 256
const key = (x: number, y: number) => `${x},${y}`

/** View requests stay bounded even at "show all" on a very widely explored world. */
export function heightChunks(view: MapView, vp: MapViewport): [number, number][] {
  const v = visibleTiles(view, vp)
  const cx = Math.floor(view.cx / 24), cy = Math.floor(view.cy / 24)
  const out: [number, number][] = []
  // At most 65² candidates, then the closest 1024 visible chunks. At normal
  // zooms (including 18%) this includes the entire viewport.
  for (let y = Math.max(cy - 32, Math.floor(v.minTy / 24)); y <= Math.min(cy + 32, Math.floor(v.maxTy / 24)); y++) {
    for (let x = Math.max(cx - 32, Math.floor(v.minTx / 24)); x <= Math.min(cx + 32, Math.floor(v.maxTx / 24)); x++) if (onMapGrid(x, y)) out.push([x, y])
  }
  return out.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy)).slice(0, HEIGHT_CACHE)
}

export function heightColour(height: number, kind: number, dx: number, dy: number): string {
  const z = Math.max(0, Math.min(15, height / 256))
  const shade = Math.max(0.55, Math.min(1.3, 1 + (dx - dy) / 256 * 0.85))
  const stops = kind === 3 ? [91, 65, 49] : kind === 2 ? [104, 103, 99] : [164 + z * 4.5, 181 - z * 2.5, 119 + z * 5.5]
  return `rgba(${stops.map((v) => Math.round(Math.max(0, Math.min(255, v * shade)))).join(',')},0.88)`
}

/** One map opening owns the cache; it cannot leak another world's heights. */
export class HeightMap {
  chunks = new Map<string, HeightChunk>()
  marks = new Map<string, HeightMark>()
  requests = 0
  async load(wanted: [number, number][], signal: AbortSignal, changed: () => void, fetcher: typeof fetch = fetch): Promise<void> {
    const missing = wanted.filter(([x, y]) => !this.chunks.has(key(x, y)))
    for (let i = 0; i < missing.length; i += HEIGHT_BATCH) {
      if (signal.aborted) return
      const q = missing.slice(i, i + HEIGHT_BATCH).map(([x, y]) => `c=${x},${y}`).join('&')
      this.requests++
      const res = await fetcher(`/api/dev/terrain/map?${q}`, { credentials: 'same-origin', signal })
      if (!res.ok) throw new Error(`Height map unavailable (${res.status}).`)
      const got = await res.json() as HeightReply
      if (signal.aborted) return
      for (const c of got.chunks) {
        const k = key(c.cx, c.cy)
        this.chunks.delete(k)
        this.chunks.set(k, c)
        while (this.chunks.size > HEIGHT_CACHE) this.chunks.delete(this.chunks.keys().next().value!)
      }
      for (const m of got.marks) this.marks.set(`${m.kind}:${m.x},${m.y}`, m)
      while (this.marks.size > 128) this.marks.delete(this.marks.keys().next().value!)
      changed()
    }
  }

  draw(ctx: CanvasRenderingContext2D, view: MapView, vp: MapViewport, ratio: number): void {
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0)
    ctx.clearRect(0, 0, vp.w, vp.h)
    for (const [cx, cy] of heightChunks(view, vp)) {
      const c = this.chunks.get(key(cx, cy))
      if (!c) continue
      for (let y = 0; y < 6; y++) for (let x = 0; x < 6; x++) {
        const i = y * 6 + x
        const p = toScreen(view, vp, cx * 24 + x * 4, cy * 24 + y * 4)
        ctx.fillStyle = heightColour(c.height[i]!, c.kind[i]!, c.dx[i]!, c.dy[i]!)
        ctx.fillRect(p.x, p.y, 4 * view.scale + 0.25, 4 * view.scale + 0.25)
        if (c.kind[i] === 2 || c.kind[i] === 3) {
          ctx.fillStyle = c.kind[i] === 3 ? '#503c2e' : '#63615e'
          ctx.fillRect(p.x, p.y, 4 * view.scale, Math.max(1, view.scale / 2))
        }
      }
    }
    ctx.font = 'bold 13px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (const m of this.marks.values()) {
      const p = toScreen(view, vp, m.x + 0.5, m.y + 0.5)
      if (p.x < -10 || p.y < -10 || p.x > vp.w + 10 || p.y > vp.h + 10) continue
      ctx.lineWidth = 3
      ctx.strokeStyle = '#fff6da'
      const icon = m.kind === 'spire' ? '▲' : '◇'
      ctx.strokeText(icon, p.x, p.y)
      ctx.fillStyle = m.kind === 'spire' ? '#53435d' : '#88491d'
      ctx.fillText(icon, p.x, p.y)
    }
  }
}
