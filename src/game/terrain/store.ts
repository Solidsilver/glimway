/**
 * Height terrain as the game holds it (dev switch on): the decoded surface
 * of each chunk round the hero (the attached 3×3 and a ring), fetched from
 * the dev route (GET /api/dev/terrain, server/internal/api/dev_terrain.go)
 * and looked up by world tile and world px. A chunk not fetched yet is
 * closed to walking (StepRule), but never blocks what the flat Wilds
 * allow elsewhere (closedAt: only known steep, crag or cliff ground).
 */
import { CRAG, CLIFF, DX, DY, SLOPE_UNIT, STEEP, cornersMeet, decodeTerrainBatch, surfaceWalkable, tileCorners, type SlopeSurface } from './surface.ts'
import type { StepRule } from './walk.ts'

export const CHUNK = 24
const TILE = 16

/** A chunk as one number (chunk coordinates stay well inside ±2^20). */
const key = (cx: number, cy: number) => (cx + 1048576) * 2097152 + (cy + 1048576)

export type TerrainFetch = (chunks: [number, number][]) => Promise<{ cx: number; cy: number; surface: SlopeSurface }[]>

/** The dev route, batched (at most 49 chunks a request). */
export const devTerrainFetch: TerrainFetch = async (chunks) => {
  const q = chunks.map(([cx, cy]) => `c=${cx},${cy}`).join('&')
  const res = await fetch(`/api/dev/terrain?${q}`, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`terrain ${res.status}`)
  return decodeTerrainBatch(new Uint8Array(await res.arrayBuffer()))
}

export class TerrainStore implements StepRule {
  private chunks = new Map<number, SlopeSurface>()
  private asked = new Set<number>()
  /** Bumped whenever a chunk arrives or goes. */
  version = 0
  /** Why the last fetch failed ('' when none did): a live server has no route. */
  error = ''
  private listeners = new Set<(cx: number, cy: number) => void>()

  private fetcher: TerrainFetch
  constructor(fetcher: TerrainFetch = devTerrainFetch) {
    this.fetcher = fetcher
  }

  /** A chunk arrived. */
  onChunk(fn: (cx: number, cy: number) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Keep these chunks (fetching what's missing) and let go of the rest. */
  want(chunks: [number, number][]): void {
    const keep = new Set(chunks.map(([cx, cy]) => key(cx, cy)))
    for (const k of [...this.chunks.keys()]) if (!keep.has(k)) { this.chunks.delete(k); this.version++ }
    for (const k of [...this.asked]) if (!keep.has(k)) this.asked.delete(k)
    const missing = chunks.filter(([cx, cy]) => !this.chunks.has(key(cx, cy)) && !this.asked.has(key(cx, cy)))
    for (let i = 0; i < missing.length; i += 49) {
      const batch = missing.slice(i, i + 49)
      for (const [cx, cy] of batch) this.asked.add(key(cx, cy))
      this.fetcher(batch).then(
        (got) => {
          for (const g of got) {
            const k = key(g.cx, g.cy)
            if (!this.asked.has(k)) continue
            this.chunks.set(k, g.surface)
            this.version++
            this.error = ''
            for (const l of this.listeners) l(g.cx, g.cy)
          }
        },
        (e: unknown) => {
          this.error = e instanceof Error ? e.message : String(e)
          for (const [cx, cy] of batch) this.asked.delete(key(cx, cy))
        }
      )
    }
  }

  /** Put a surface in directly (tests). */
  put(cx: number, cy: number, s: SlopeSurface): void {
    this.chunks.set(key(cx, cy), s)
    this.asked.add(key(cx, cy))
    this.version++
  }

  clear(): void {
    this.chunks.clear()
    this.asked.clear()
    this.version++
  }

  surface(cx: number, cy: number): SlopeSurface | undefined {
    return this.chunks.get(key(cx, cy))
  }

  has(cx: number, cy: number): boolean {
    return this.chunks.has(key(cx, cy))
  }

  get size(): number {
    return this.chunks.size
  }

  private tops = new WeakMap<SlopeSurface, number>()
  /** A chunk's highest ground (levels), or NaN when it isn't known. */
  top(cx: number, cy: number): number {
    const s = this.chunks.get(key(cx, cy))
    if (!s) return Number.NaN
    let t = this.tops.get(s)
    if (t === undefined) {
      let most = 0
      for (const c of s.corners) most = Math.max(most, c)
      for (const c of s.overrideCorners) most = Math.max(most, c)
      t = most / SLOPE_UNIT
      this.tops.set(s, t)
    }
    return t
  }

  // A tile's chunk and index, without allocating.
  private s: SlopeSurface | null = null
  private i = 0
  private lastCx = Number.NaN
  private lastCy = Number.NaN
  private lastV = -1
  private lastS: SlopeSurface | null = null
  private locate(tx: number, ty: number): boolean {
    const cx = Math.floor(tx / CHUNK)
    const cy = Math.floor(ty / CHUNK)
    let s: SlopeSurface | undefined
    if (cx === this.lastCx && cy === this.lastCy && this.lastV === this.version) s = this.lastS ?? undefined
    else {
      s = this.chunks.get(key(cx, cy))
      this.lastCx = cx
      this.lastCy = cy
      this.lastV = this.version
      this.lastS = s ?? null
    }
    if (!s) return false
    this.s = s
    this.i = (ty - cy * CHUNK) * s.w + (tx - cx * CHUNK)
    return true
  }

  /** Is the world tile known? */
  known(tx: number, ty: number): boolean {
    return this.locate(tx, ty)
  }

  /** Known and walkable by the four-corner rule. */
  walkable(tx: number, ty: number): boolean {
    return this.locate(tx, ty) && surfaceWalkable(this.s!, this.i)
  }

  /** Known ground nobody walks: too steep, crags, a cliff's face (the flat Wilds' solid tiles are separate). */
  closedAt(tx: number, ty: number): boolean {
    return this.locate(tx, ty) && !surfaceWalkable(this.s!, this.i)
  }

  /** The tile's ground kind (./surface.ts SLOPE…CLIFF), or -1 unknown. */
  kindAt(tx: number, ty: number): number {
    return this.locate(tx, ty) ? this.s!.kind[this.i]! : -1
  }

  private a = [0, 0, 0, 0]
  private b = [0, 0, 0, 0]
  canStep(tx: number, ty: number, d: number): boolean {
    if (!this.locate(tx, ty) || !surfaceWalkable(this.s!, this.i)) return false
    const sa = this.s!
    const ia = this.i
    const nx = tx + DX[d]!
    const ny = ty + DY[d]!
    if (!this.locate(nx, ny) || !surfaceWalkable(this.s!, this.i)) return false
    if (sa.flags[ia]! & (1 << d) || this.s!.flags[this.i]! & (1 << ((d + 2) & 3))) return false
    return cornersMeet(tileCorners(sa, ia, this.a), tileCorners(this.s!, this.i, this.b), d)
  }

  /** A tile's resolved corners in levels (NW, NE, SE, SW), or null when unknown. */
  corners(tx: number, ty: number, out: number[] = [0, 0, 0, 0]): number[] | null {
    if (!this.locate(tx, ty)) return null
    tileCorners(this.s!, this.i, out)
    for (let c = 0; c < 4; c++) out[c] = out[c]! / SLOPE_UNIT
    return out
  }

  private c = [0, 0, 0, 0]
  /** The ground's height (levels) at world px (x, y): its tile's bilinear patch; NaN when unknown. */
  zAt(x: number, y: number): number {
    const tx = Math.floor(x / TILE)
    const ty = Math.floor(y / TILE)
    if (!this.corners(tx, ty, this.c)) return Number.NaN
    const fx = x / TILE - tx
    const fy = y / TILE - ty
    const c = this.c
    const n = c[0]! + (c[1]! - c[0]!) * fx
    const s = c[3]! + (c[2]! - c[3]!) * fx
    return n + (s - n) * fy
  }

  /** The slope (levels a tile, east and south) at world px (x, y); flat when unknown. */
  gradientAt(x: number, y: number): [number, number] {
    const tx = Math.floor(x / TILE)
    const ty = Math.floor(y / TILE)
    if (!this.corners(tx, ty, this.c)) return [0, 0]
    const fx = Math.min(1, Math.max(0, x / TILE - tx))
    const fy = Math.min(1, Math.max(0, y / TILE - ty))
    const c = this.c
    return [(c[1]! - c[0]!) * (1 - fy) + (c[2]! - c[3]!) * fy, (c[3]! - c[0]!) * (1 - fx) + (c[2]! - c[1]!) * fx]
  }
}

/** Kinds a sprite never stands on: what nobody walks (a tree or camp there is kept off it). */
export const CLOSED_KINDS = new Set([STEEP, CRAG, CLIFF])

/** The game's store (dev switch on). */
export const terrain = new TerrainStore()
