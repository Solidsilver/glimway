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
 *    A level of height difference counts as two tiles of distance; levels
 *    are smooth (a ramp's change evenly), and the penalty is worked out
 *    from the source's height as it is, so a light moving down a ramp
 *    changes evenly without its shadows being worked out again.
 *  - Depth: a layer's light can darken with the level difference from the
 *    viewer's (levels above and below darker, never tinted; fill's depth).
 *  - A portal mask: tiles (a cave mouth's arch) that always show one
 *    layer's light, whatever the views' mix (fill's portal).
 *  - The way in: a cap (a layer fading in over another never shows
 *    brighter than its own light allows) and an iris (one layer's light
 *    inside a circle).
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
  /** Per-tile visibility and floor level over the box, worked out at `atTile`. */
  vis: Float32Array
  lev: Float32Array | null
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

/**
 * How much darker something `dz` levels above or below the viewer is, 0
 * (own level) to `cap` (two levels and more): smooth, the same either way.
 */
export function depthDark(dz: number, cap: number): number {
  const d = Math.min(1, Math.abs(dz) / 2)
  return cap * d * d * (3 - 2 * d)
}

/** fill's options: darken a layer by level difference from the viewer's; show one layer's light on a portal's tiles. */
export interface FillOptions {
  /** The layer that darkens, the viewer's level, the most it darkens (0–1), and how much of it applies (the view's weight). */
  depth?: { layer: number; z: number; cap: number; weight: number }
  /** Tiles (1) that show this layer's light at full weight; moving lights of every layer count on them. */
  portal?: { layer: number; mask: Uint8Array }
  /** This layer's material is drawn at `alpha` over the others: its light never more than its own over alpha there. */
  cap?: { layer: number; alpha: number }
  /** This layer's light inside a circle (world px), the others' outside, over a soft ring. */
  iris?: { layer: number; x: number; y: number; r: number; soft: number }
}

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
  private levels: (Float32Array | null)[] = []
  /** Per layer, texels: the level (bilinear between tile middles) and how much depth darkens there (0–1). */
  private levelTex: ({ lev: Float32Array; mat: Float32Array } | null)[] = []
  private material: (Uint8Array | null)[] = []
  private cover: (Float32Array | null)[] = []
  private wBase: Float32Array[] = []
  private wSrc: Float32Array[] = []
  private bufAmb: Float32Array[] = []
  private bufMov: Float32Array[] = []
  private kDepth: Float32Array[] = []
  /** The last fill's cap: how far the layer's material showed past its own light before the cap (uncapped), 0–1. */
  stats = { uncapped: 0 }
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
      this.levelTex.push(null)
      this.material.push(null)
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

  /**
   * Each tile's floor level (smooth), so a light on another floor reaches it
   * weaker and depth can darken it; `material`: where depth darkens (1),
   * e.g. not the open air seen out of a mouth. Everywhere if not given.
   */
  setLevels(layer: number, levels: Float32Array, material?: Uint8Array): void {
    this.levels[layer] = levels
    this.material[layer] = material ?? null
    this.levelTex[layer] = null
    this.rebuild(layer)
  }

  /** How much a layer's image covers per texel (0–1), for the cap; without it, where its levels' material is. */
  setCover(layer: number, cover: Float32Array): void {
    this.cover[layer] = cover
  }

  // ------------------------------------------------------------ sources

  add(src: LightSource): void {
    this.remove(src.id)
    const live = this.visibility({ ...src, vis: new Float32Array(0), lev: null, bx: 0, by: 0, bw: 0, bh: 0, atTile: -1 })
    this.sources.set(src.id, live)
    if (!live.moving && this.baked[live.layer]) this.stamp(this.baked[live.layer]!, null, live, 1)
  }

  /** A source's new place (its shadows are worked out again when it crosses a tile; a new height only changes its reach). */
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
    if (z !== undefined) s.z = z
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
   * surface's is two views whose weights add to 1), a layer darkened by
   * depth, a portal's tiles in their layer's light, an iris, and a cap on
   * a layer drawn see-through (FillOptions).
   */
  fill(rect: TexelRect, out: Uint8ClampedArray, views: readonly { layer: number; weight: number }[], opts: FillOptions = {}): void {
    const nt = rect.w * rect.h
    const n = nt * 3
    const grow = (a: Float32Array[], i: number, len: number) => (a[i] && a[i]!.length >= len ? a[i]! : (a[i] = new Float32Array(len)))
    if (this.acc.length < n) this.acc = new Float32Array(n)
    const acc = this.acc
    acc.fill(0, 0, n)
    const { depth, portal, cap, iris } = opts
    const per = this.tile / this.res
    // Each view's light at full weight: its ambient and still lights, and its moving lights, apart.
    views.forEach((v, vi) => {
      const amb = grow(this.bufAmb, vi, n)
      const mov = grow(this.bufMov, vi, n)
      const k = grow(this.kDepth, vi, nt)
      amb.fill(0, 0, n)
      mov.fill(0, 0, n)
      k.fill(1, 0, nt)
      if (depth && depth.layer === v.layer && depth.weight > 0 && depth.cap > 0 && this.levels[v.layer]) {
        const { lev, mat } = this.levelMap(v.layer)
        for (let y = 0; y < rect.h; y++) {
          const ty = Math.min(this.th - 1, Math.max(0, rect.y0 + y))
          for (let x = 0; x < rect.w; x++) {
            const t = ty * this.tw + Math.min(this.tw - 1, Math.max(0, rect.x0 + x))
            k[y * rect.w + x] = 1 - depth.weight * mat[t]! * depthDark(lev[t]! - depth.z, depth.cap)
          }
        }
      }
      const map = this.bake(v.layer)
      for (let y = 0; y < rect.h; y++) {
        const ty = Math.min(this.th - 1, Math.max(0, rect.y0 + y))
        for (let x = 0; x < rect.w; x++) {
          const kk = k[y * rect.w + x]!
          const s = (ty * this.tw + Math.min(this.tw - 1, Math.max(0, rect.x0 + x))) * 3
          const d = (y * rect.w + x) * 3
          amb[d] = map[s]! * kk
          amb[d + 1] = map[s + 1]! * kk
          amb[d + 2] = map[s + 2]! * kk
        }
      }
      for (const s of this.sources.values()) if (s.moving && s.layer === v.layer) this.stamp(mov, rect, s, 1, k)
    })
    // Each view's weight per texel: for its ambient and still lights, and for its moving lights.
    views.forEach((v, vi) => {
      grow(this.wBase, vi, nt).fill(v.weight, 0, nt)
      grow(this.wSrc, vi, nt).fill(v.weight, 0, nt)
    })
    if (iris)
      // The iris's layer inside its circle, the others outside, a soft ring between.
      for (let y = 0; y < rect.h; y++)
        for (let x = 0; x < rect.w; x++) {
          const d = Math.hypot((rect.x0 + x + 0.5) * this.res - iris.x, (rect.y0 + y + 0.5) * this.res - iris.y)
          const wi = clamp01((iris.r + iris.soft - d) / Math.max(1e-6, iris.soft))
          views.forEach((v, vi) => {
            const w = v.layer === iris.layer ? wi : 1 - wi
            this.wBase[vi]![y * rect.w + x] = w
            this.wSrc[vi]![y * rect.w + x] = w
          })
        }
    if (portal) {
      // Tile by tile over the box: a masked tile's texels.
      const tx0 = Math.max(0, Math.floor(rect.x0 / per))
      const ty0 = Math.max(0, Math.floor(rect.y0 / per))
      const tx1 = Math.min(this.w - 1, Math.floor((rect.x0 + rect.w - 1) / per))
      const ty1 = Math.min(this.h - 1, Math.floor((rect.y0 + rect.h - 1) / per))
      for (let ty = ty0; ty <= ty1; ty++)
        for (let tx = tx0; tx <= tx1; tx++) {
          if (!portal.mask[ty * this.w + tx]) continue
          for (let y = Math.max(0, ty * per - rect.y0); y < Math.min(rect.h, (ty + 1) * per - rect.y0); y++)
            for (let x = Math.max(0, tx * per - rect.x0); x < Math.min(rect.w, (tx + 1) * per - rect.x0); x++)
              views.forEach((v, vi) => {
                this.wBase[vi]![y * rect.w + x] = v.layer === portal.layer ? 1 : 0
                this.wSrc[vi]![y * rect.w + x] = 1
              })
        }
    }
    views.forEach((_v, vi) => {
      const amb = this.bufAmb[vi]!
      const mov = this.bufMov[vi]!
      const wb = this.wBase[vi]!
      const ws = this.wSrc[vi]!
      for (let t = 0, d = 0; t < nt; t++, d += 3) {
        const b = wb[t]!
        const m = ws[t]!
        acc[d] += amb[d]! * b + mov[d]! * m
        acc[d + 1] += amb[d + 1]! * b + mov[d + 1]! * m
        acc[d + 2] += amb[d + 2]! * b + mov[d + 2]! * m
      }
    })
    // The cap: where the layer's material is drawn at \`alpha\` over another, the light there is never more
    // than its own light over alpha, so that material never shows brighter than it will once fully in.
    this.stats = { uncapped: 0 }
    const ci = cap ? views.findIndex((v) => v.layer === cap.layer) : -1
    if (cap && ci >= 0 && cap.alpha > 0.001) {
      const amb = this.bufAmb[ci]!
      const mov = this.bufMov[ci]!
      const mat = this.cover[cap.layer] ?? (this.levels[cap.layer] ? this.levelMap(cap.layer).mat : null)
      for (let y = 0; y < rect.h; y++) {
        const ty = Math.min(this.th - 1, Math.max(0, rect.y0 + y))
        for (let x = 0; x < rect.w; x++) {
          const t = y * rect.w + x
          // Fully capped where the image covers half or more; on its fading rim, less (the rim's material
          // shows at most an eighth of what it would uncapped, and the surface beyond isn't darkened in a hard edge).
          const cover = mat ? mat[ty * this.tw + Math.min(this.tw - 1, Math.max(0, rect.x0 + x))]! : 1
          const m = Math.min(1, 2 * cover)
          if (m <= 0) continue
          const d = t * 3
          let over = 0
          for (let c = 0; c < 3; c++) {
            const own = clamp01(amb[d + c]! + mov[d + c]!)
            const shown = cap.alpha * clamp01(acc[d + c]!)
            over = Math.max(over, cover * (shown - own))
            const excess = acc[d + c]! - own / cap.alpha
            if (excess > 0) acc[d + c] -= m * excess
          }
          this.stats.uncapped = Math.max(this.stats.uncapped, over)
        }
      }
    }
    for (let i = 0, j = 0; i < nt; i++, j += 3) {
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

  /** A layer's level and where depth darkens it, as texels (bilinear between tile middles; worked out once). */
  private levelMap(layer: number): { lev: Float32Array; mat: Float32Array } {
    const have = this.levelTex[layer]
    if (have) return have
    const levels = this.levels[layer]!
    const material = this.material[layer]
    const lev = new Float32Array(this.tw * this.th)
    const mat = new Float32Array(this.tw * this.th)
    const per = this.tile / this.res
    const at = (f: ArrayLike<number>, tx: number, ty: number) => f[Math.min(this.h - 1, Math.max(0, ty)) * this.w + Math.min(this.w - 1, Math.max(0, tx))]!
    for (let y = 0; y < this.th; y++)
      for (let x = 0; x < this.tw; x++) {
        const gx = (x + 0.5) / per - 0.5
        const gy = (y + 0.5) / per - 0.5
        const x0 = Math.floor(gx)
        const y0 = Math.floor(gy)
        const fx = gx - x0
        const fy = gy - y0
        const bil = (f: ArrayLike<number>) => (at(f, x0, y0) * (1 - fx) + at(f, x0 + 1, y0) * fx) * (1 - fy) + (at(f, x0, y0 + 1) * (1 - fx) + at(f, x0 + 1, y0 + 1) * fx) * fy
        lev[y * this.tw + x] = bil(levels)
        mat[y * this.tw + x] = material ? bil(material) : 1
      }
    this.levelTex[layer] = { lev, mat }
    return this.levelTex[layer]!
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
    let pen = 0
    if (s.lev) {
      // The level penalty from the source's height now (it moves smoothly on a ramp).
      const lev = s.lev
      const z = s.z
      const p = (j: number) => Math.abs(lev[j]! - z)
      pen = ((p(i(x0, y0)) * (1 - fx) + p(i(x0 + 1, y0)) * fx) * (1 - fy) + (p(i(x0, y0 + 1)) * (1 - fx) + p(i(x0 + 1, y0 + 1)) * fx) * fy) * LEVEL_PX(this.tile)
    }
    return s.intensity * vis * falloff(r + pen, s.inner, s.radius)
  }

  /** Add (sign 1) or take away (-1) a source's light over its box, into a texel map (whole, or a rect of it, each texel weighted by `wts`). */
  private stamp(map: Float32Array, rect: TexelRect | null, s: Live, sign: number, wts?: Float32Array): void {
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
        const t = (ty - oy) * mw + (tx - ox)
        const wt = wts ? wts[t]! : 1
        if (wt <= 0) continue
        const k = this.reach(s, (tx + 0.5) * R, (ty + 0.5) * R) * wt
        if (k <= 0) continue
        const d = t * 3
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
    const stops = this.stops[s.layer]
    const levels = this.levels[s.layer]
    s.lev = levels ? new Float32Array(s.bw * s.bh).fill(s.z) : null
    for (let by = 0; by < s.bh; by++)
      for (let bx = 0; bx < s.bw; bx++) {
        const tx = s.bx + bx
        const ty = s.by + by
        const j = by * s.bw + bx
        if (tx < 0 || ty < 0 || tx >= this.w || ty >= this.h) continue
        if (s.lev) s.lev[j] = levels![ty * this.w + tx]!
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

/**
 * An image lit on the CPU: `src` (RGBA, `sw` px wide, its top left at world
 * px sx, sy) times the light texels in `light` (RGBA, `lw` × `lh`, the
 * first at texel lx0, ly0; `res` px a texel), bilinear between texel
 * middles as the light's image is drawn, over the world box rx, ry, w, h
 * into `out` (RGBA, w × h; transparent where `src` has nothing). The way
 * in's crossfade (./scene.ts): the cave's floors in the cave's own light,
 * drawn over the lit surface.
 */
export function litPixels(
  src: Uint8ClampedArray,
  sw: number,
  sx: number,
  sy: number,
  light: Uint8ClampedArray,
  lw: number,
  lh: number,
  lx0: number,
  ly0: number,
  res: number,
  rx: number,
  ry: number,
  w: number,
  h: number,
  out: Uint8ClampedArray
): void {
  const sh = src.length / 4 / sw
  const ix = new Int32Array(w)
  const fxs = new Float32Array(w)
  for (let x = 0; x < w; x++) {
    const g = (rx + x + 0.5) / res - 0.5 - lx0
    const i = Math.floor(g)
    ix[x] = Math.min(lw - 2, Math.max(0, i))
    fxs[x] = i < 0 ? 0 : i > lw - 2 ? 1 : g - i
  }
  out.fill(0, 0, w * h * 4)
  for (let y = 0; y < h; y++) {
    const syy = ry + y - sy
    if (syy < 0 || syy >= sh) continue
    const g = (ry + y + 0.5) / res - 0.5 - ly0
    const iy = Math.min(lh - 2, Math.max(0, Math.floor(g)))
    const fy = g < 0 ? 0 : Math.floor(g) > lh - 2 ? 1 : g - Math.floor(g)
    const r0 = iy * lw * 4
    const r1 = (iy + 1) * lw * 4
    for (let x = 0; x < w; x++) {
      const sxx = rx + x - sx
      if (sxx < 0 || sxx >= sw) continue
      const s = (syy * sw + sxx) * 4
      const a = src[s + 3]!
      if (a === 0) continue
      const fx = fxs[x]!
      const c0 = ix[x]! * 4
      const o = (y * w + x) * 4
      for (let c = 0; c < 3; c++) {
        const top = light[r0 + c0 + c]! * (1 - fx) + light[r0 + c0 + 4 + c]! * fx
        const bot = light[r1 + c0 + c]! * (1 - fx) + light[r1 + c0 + 4 + c]! * fx
        out[o + c] = (src[s + c]! * (top * (1 - fy) + bot * fy)) / 255
      }
      out[o + 3] = a
    }
  }
}
