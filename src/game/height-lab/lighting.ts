/**
 * Height lab (dev only): one lighting system, the first version the game
 * could adopt (design: .agent/NOTES.md, docs/planning/wide-world/
 * height-lab-3-notes.md). Pure, no Phaser, so node tests read every number.
 *
 * The light at a world point on a layer is the place's ambient plus every
 * source's falloff times its visibility, clamped to 1 per channel; the
 * scene multiplies the world by it (./scene.ts LightView).
 *  - Ambient is a field per tile per layer: daylight, a cave's dark,
 *    daylight spilling in through a mouth, open air, solid rock.
 *  - A source is data: where, which layer and level, colour, radius,
 *    falloff, intensity, and whether it moves. Still sources are baked
 *    into a texel map with the ambient; moving ones are added each frame
 *    over their box.
 *  - Occluders: a "stops light" grid per layer. A source lights a tile if
 *    a straight line to it stays over clear tiles (the end tile may be the
 *    wall itself, so a wall facing a light is lit). Visibility is per tile,
 *    sampled bilinearly between tile middles: a soft half-tile penumbra.
 *    A level of height difference counts as two tiles of distance.
 */

export interface LightSource {
  id: string
  /** World px. */
  x: number
  y: number
  layer: number
  /** The level it stands on (heights in the layer count against its reach). */
  z: number
  /** 0xRRGGBB. */
  color: number
  /** Px to where it's gone. */
  radius: number
  /** Px out to which it's at full strength. */
  inner: number
  /** 0–1 (more saturates). */
  intensity: number
  /** Moving sources are added each frame; still ones are baked. */
  moving: boolean
}

/** A box of texels, row by row from (x0, y0). */
export interface TexelRect {
  x0: number
  y0: number
  w: number
  h: number
}

interface Live extends LightSource {
  /** Per-tile visibility and level penalty (px) over the box, worked out at `atTile`. */
  vis: Float32Array
  pen: Float32Array
  bx: number
  by: number
  bw: number
  bh: number
  atTile: number
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v)

/** How much of a source reaches `r` px out: full to `inner`, smoothly gone at `radius`. */
export function falloff(r: number, inner: number, radius: number): number {
  if (r >= radius) return 0
  if (r <= inner) return 1
  const k = (radius - r) / Math.max(1e-6, radius - inner)
  return k * k * (3 - 2 * k)
}

/** Px of distance a level of height difference adds (two tiles). */
const LEVEL_PX = (tile: number) => 2 * tile

export class Lighting {
  readonly w: number
  readonly h: number
  readonly tile: number
  readonly res: number
  /** Texels across and down. */
  readonly tw: number
  readonly th: number
  private ambient: Float32Array[] = []
  private stops: (Uint8Array | null)[] = []
  private levels: (Int8Array | null)[] = []
  private baked: (Float32Array | null)[] = []
  private sources = new Map<string, Live>()
  private acc = new Float32Array(0)

  constructor(o: { w: number; h: number; tile: number; res: number; layers: number }) {
    this.w = o.w
    this.h = o.h
    this.tile = o.tile
    this.res = o.res
    this.tw = Math.ceil((o.w * o.tile) / o.res)
    this.th = Math.ceil((o.h * o.tile) / o.res)
    for (let l = 0; l < o.layers; l++) {
      this.ambient.push(new Float32Array(o.w * o.h * 3).fill(1))
      this.stops.push(null)
      this.levels.push(null)
      this.baked.push(null)
    }
  }

  // ------------------------------------------------------------ the world

  /** The place's own light per tile (r, g, b, 0–1, row by row). */
  setAmbient(layer: number, rgb: Float32Array): void {
    this.ambient[layer] = rgb
    this.baked[layer] = null
  }

  /** Which tiles stop light (1 stops). */
  setOccluders(layer: number, stops: Uint8Array): void {
    this.stops[layer] = stops
    this.rebuild(layer)
  }

  /** Each tile's floor level, so a light on another floor reaches it weaker. */
  setLevels(layer: number, levels: Int8Array): void {
    this.levels[layer] = levels
    this.rebuild(layer)
  }

  // ------------------------------------------------------------ sources

  add(src: LightSource): void {
    this.remove(src.id)
    const live = this.visibility({ ...src, vis: new Float32Array(0), pen: new Float32Array(0), bx: 0, by: 0, bw: 0, bh: 0, atTile: -1 })
    this.sources.set(src.id, live)
    if (!live.moving && this.baked[live.layer]) this.stamp(this.baked[live.layer]!, null, live, 1)
  }

  /** A moving source's new place (its shadows are worked out again when it crosses a tile). */
  move(id: string, x: number, y: number, layer?: number, z?: number): void {
    const s = this.sources.get(id)
    if (!s) return
    const still = !s.moving
    if (still && this.baked[s.layer]) this.stamp(this.baked[s.layer]!, null, s, -1)
    s.x = x
    s.y = y
    if (layer !== undefined && layer !== s.layer) {
      s.layer = layer
      s.atTile = -1
    }
    if (z !== undefined && z !== s.z) {
      s.z = z
      s.atTile = -1
    }
    this.visibility(s)
    if (still && this.baked[s.layer]) this.stamp(this.baked[s.layer]!, null, s, 1)
  }

  /** Change a source's look (colour, reach, strength): e.g. the hero's light switched. */
  set(id: string, change: Partial<Pick<LightSource, 'color' | 'radius' | 'inner' | 'intensity'>>): void {
    const s = this.sources.get(id)
    if (!s) return
    this.add({ ...s, ...change })
  }

  remove(id: string): void {
    const s = this.sources.get(id)
    if (!s) return
    this.sources.delete(id)
    if (!s.moving && this.baked[s.layer]) this.stamp(this.baked[s.layer]!, null, s, -1)
  }

  get(id: string): LightSource | undefined {
    return this.sources.get(id)
  }

  // ------------------------------------------------------------ reading

  /** The light at a world point on a layer: [r, g, b], each 0–1. */
  at(layer: number, x: number, y: number): [number, number, number] {
    const map = this.bake(layer)
    const gx = x / this.res - 0.5
    const gy = y / this.res - 0.5
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - x0
    const fy = gy - y0
    const out: [number, number, number] = [0, 0, 0]
    for (let c = 0; c < 3; c++) {
      const v = (tx: number, ty: number) => map[(Math.min(this.th - 1, Math.max(0, ty)) * this.tw + Math.min(this.tw - 1, Math.max(0, tx))) * 3 + c]!
      out[c] = (v(x0, y0) * (1 - fx) + v(x0 + 1, y0) * fx) * (1 - fy) + (v(x0, y0 + 1) * (1 - fx) + v(x0 + 1, y0 + 1) * fx) * fy
    }
    for (const s of this.sources.values()) {
      if (!s.moving || s.layer !== layer) continue
      const k = this.reach(s, x, y)
      if (k <= 0) continue
      out[0] += k * ((s.color >> 16) & 255) / 255
      out[1] += k * ((s.color >> 8) & 255) / 255
      out[2] += k * (s.color & 255) / 255
    }
    return [clamp01(out[0]), clamp01(out[1]), clamp01(out[2])]
  }

  /** The light at a point as one number (its brightest channel), for tests and the lab's line. */
  level(layer: number, x: number, y: number): number {
    const [r, g, b] = this.at(layer, x, y)
    return Math.max(r, g, b)
  }

  /**
   * The frame's light over a box of texels into RGBA bytes (alpha 255):
   * each view's layer, weighted (the cave's view coming in over the
   * surface's is two views whose weights add to 1).
   */
  fill(rect: TexelRect, out: Uint8ClampedArray, views: readonly { layer: number; weight: number }[]): void {
    const n = rect.w * rect.h * 3
    if (this.acc.length < n) this.acc = new Float32Array(n)
    const acc = this.acc
    acc.fill(0, 0, n)
    for (const v of views) {
      if (v.weight <= 0) continue
      const map = this.bake(v.layer)
      for (let y = 0; y < rect.h; y++) {
        const ty = Math.min(this.th - 1, Math.max(0, rect.y0 + y))
        for (let x = 0; x < rect.w; x++) {
          const tx = Math.min(this.tw - 1, Math.max(0, rect.x0 + x))
          const s = (ty * this.tw + tx) * 3
          const d = (y * rect.w + x) * 3
          acc[d] += map[s]! * v.weight
          acc[d + 1] += map[s + 1]! * v.weight
          acc[d + 2] += map[s + 2]! * v.weight
        }
      }
      for (const s of this.sources.values()) if (s.moving && s.layer === v.layer) this.stamp(acc, rect, s, v.weight)
    }
    for (let i = 0, j = 0; i < rect.w * rect.h; i++, j += 3) {
      out[i * 4] = Math.round(clamp01(acc[j]!) * 255)
      out[i * 4 + 1] = Math.round(clamp01(acc[j + 1]!) * 255)
      out[i * 4 + 2] = Math.round(clamp01(acc[j + 2]!) * 255)
      out[i * 4 + 3] = 255
    }
  }

  // ------------------------------------------------------------ inside

  private rebuild(layer: number): void {
    for (const s of this.sources.values())
      if (s.layer === layer) {
        s.atTile = -1
        this.visibility(s)
      }
    this.baked[layer] = null
  }

  /** The layer's ambient and still sources, as texels (baked once, then kept up to date). */
  private bake(layer: number): Float32Array {
    const have = this.baked[layer]
    if (have) return have
    const map = new Float32Array(this.tw * this.th * 3)
    const amb = this.ambient[layer]!
    const per = this.tile / this.res
    for (let y = 0; y < this.th; y++)
      for (let x = 0; x < this.tw; x++) {
        // Bilinear between tile middles.
        const gx = (x + 0.5) / per - 0.5
        const gy = (y + 0.5) / per - 0.5
        const x0 = Math.floor(gx)
        const y0 = Math.floor(gy)
        const fx = gx - x0
        const fy = gy - y0
        const at = (tx: number, ty: number, c: number) => amb[(Math.min(this.h - 1, Math.max(0, ty)) * this.w + Math.min(this.w - 1, Math.max(0, tx))) * 3 + c]!
        for (let c = 0; c < 3; c++)
          map[(y * this.tw + x) * 3 + c] = (at(x0, y0, c) * (1 - fx) + at(x0 + 1, y0, c) * fx) * (1 - fy) + (at(x0, y0 + 1, c) * (1 - fx) + at(x0 + 1, y0 + 1, c) * fx) * fy
      }
    this.baked[layer] = map
    for (const s of this.sources.values()) if (!s.moving && s.layer === layer) this.stamp(map, null, s, 1)
    return map
  }

  /** How much of a source reaches a world point: falloff by distance (plus levels), times visibility. */
  private reach(s: Live, x: number, y: number): number {
    const r = Math.hypot(x - s.x, y - s.y)
    if (r >= s.radius) return 0
    // Visibility and level penalty, bilinear between tile middles in the box.
    const gx = x / this.tile - 0.5 - s.bx
    const gy = y / this.tile - 0.5 - s.by
    const x0 = Math.floor(gx)
    const y0 = Math.floor(gy)
    const fx = gx - x0
    const fy = gy - y0
    const i = (bx: number, by: number) => Math.min(s.bh - 1, Math.max(0, by)) * s.bw + Math.min(s.bw - 1, Math.max(0, bx))
    const bil = (f: Float32Array) => (f[i(x0, y0)]! * (1 - fx) + f[i(x0 + 1, y0)]! * fx) * (1 - fy) + (f[i(x0, y0 + 1)]! * (1 - fx) + f[i(x0 + 1, y0 + 1)]! * fx) * fy
    const vis = bil(s.vis)
    if (vis <= 0) return 0
    return s.intensity * vis * falloff(r + bil(s.pen), s.inner, s.radius)
  }

  /** Add (sign 1) or take away (-1) a source's light over its box, into a texel map (whole, or a rect of it). */
  private stamp(map: Float32Array, rect: TexelRect | null, s: Live, sign: number): void {
    const R = this.res
    const ox = rect ? rect.x0 : 0
    const oy = rect ? rect.y0 : 0
    const mw = rect ? rect.w : this.tw
    const mh = rect ? rect.h : this.th
    const x0 = Math.max(ox, Math.floor((s.x - s.radius) / R))
    const x1 = Math.min(ox + mw - 1, Math.ceil((s.x + s.radius) / R))
    const y0 = Math.max(oy, Math.floor((s.y - s.radius) / R))
    const y1 = Math.min(oy + mh - 1, Math.ceil((s.y + s.radius) / R))
    const cr = (((s.color >> 16) & 255) / 255) * sign
    const cg = (((s.color >> 8) & 255) / 255) * sign
    const cb = ((s.color & 255) / 255) * sign
    for (let ty = y0; ty <= y1; ty++)
      for (let tx = x0; tx <= x1; tx++) {
        const k = this.reach(s, (tx + 0.5) * R, (ty + 0.5) * R)
        if (k <= 0) continue
        const d = ((ty - oy) * mw + (tx - ox)) * 3
        map[d] += k * cr
        map[d + 1] += k * cg
        map[d + 2] += k * cb
      }
  }

  /** Work out which tiles in the source's reach it sees (again only when it has crossed a tile). */
  private visibility(s: Live): Live {
    const T = this.tile
    const stx = Math.min(this.w - 1, Math.max(0, Math.floor(s.x / T)))
    const sty = Math.min(this.h - 1, Math.max(0, Math.floor(s.y / T)))
    const here = sty * this.w + stx
    if (here === s.atTile) return s
    s.atTile = here
    const reach = Math.ceil(s.radius / T) + 1
    s.bx = stx - reach
    s.by = sty - reach
    s.bw = s.bh = reach * 2 + 1
    s.vis = new Float32Array(s.bw * s.bh)
    s.pen = new Float32Array(s.bw * s.bh)
    const stops = this.stops[s.layer]
    const levels = this.levels[s.layer]
    for (let by = 0; by < s.bh; by++)
      for (let bx = 0; bx < s.bw; bx++) {
        const tx = s.bx + bx
        const ty = s.by + by
        const j = by * s.bw + bx
        if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) continue
        if (levels) s.pen[j] = Math.abs(levels[ty * this.w + tx]! - s.z) * LEVEL_PX(T)
        s.vis[j] = !stops || sightLine(stops, this.w, stx, sty, tx, ty) ? 1 : 0
      }
    return s
  }
}

/** Whether a straight line between two tile middles stays over clear tiles (its ends needn't be). */
export function sightLine(stops: Uint8Array, w: number, ax: number, ay: number, bx: number, by: number): boolean {
  const n = Math.ceil(Math.hypot(bx - ax, by - ay) * 3)
  let last = -1
  for (let s = 1; s < n; s++) {
    const tx = Math.floor(ax + 0.5 + ((bx - ax) * s) / n)
    const ty = Math.floor(ay + 0.5 + ((by - ay) * s) / n)
    if (tx === bx && ty === by) break
    if (tx === ax && ty === ay) continue
    const i = ty * w + tx
    if (i === last) continue
    last = i
    if (stops[i]) return false
  }
  return true
}
