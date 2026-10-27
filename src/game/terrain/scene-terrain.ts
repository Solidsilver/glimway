/**
 * Height terrain in the Wilds scene (dev switch on; ./settings.ts). Off,
 * none of this runs and the Wilds are as they always were.
 *
 * - **Terrain:** the chunks round the hero (the attached 3×3 and a ring) and
 *   those the view needs are fetched from the dev route into the store
 *   (./store.ts).
 * - **Ground:** each attached generated chunk, and each chunk the view
 *   needs (./need.ts: in the lift, the chunks south whose high ground is
 *   lifted into view), is baked (./bake.ts, in the worker) from the
 *   window's painted ground with the terrain's materials, the one sun and
 *   edge shading, and drawn over the flat ground. A chunk with no bake for
 *   the look yet gets a quick placeholder first (its lifted shape and
 *   materials, no sun), so nothing in view is ever empty. The sun follows
 *   the game clock (a bake every few game minutes) or the panel's time.
 *   Textures go when chunks leave.
 * - **Walking:** after each physics step the hero's motion is carried again
 *   over the field from the last good feet (./walk.ts sweep): walking, the
 *   roll, the dash and knockback alike, swept in 2 px steps, slower uphill,
 *   quicker downhill. Ground not loaded yet is closed.
 * - **¾ lift:** chunk images are lifted 48 px a level (tall ground
 *   compressed past a knee if the panel says so: ./field.ts liftRows),
 *   north first. Just before each render every world sprite is drawn lifted
 *   the same by its feet's height and put back after, so depth, physics and the game's own
 *   positions stay in field space. What stands behind nearer, higher ground
 *   isn't drawn; the hero is, with only the covered part as the grey
 *   outline (partial see-through, ./field.ts coveredPixels). Sprites on
 *   ground nobody walks (a tree on a crag) aren't drawn in either look.
 * - **Sun on the hero:** a proxy shadow cast by the sun, lit by its feet's
 *   light, in place of the blob; the slope gait (cadence, lean, scuffs).
 */
import Phaser from 'phaser'
import { onSceneEnd } from '../scene-end.ts'
import { gameNow } from '../clock.ts'
import type { Hero } from '../entities/hero.ts'
import type { WildsWindow } from '../wilds/window.ts'
import { GROUND_DEPTH } from '../wilds/window-chunk.ts'
import { CHUNK_PX, CHUNK_TILES, type BakeJob, type Baked } from './bake.ts'
import { bakeAway } from './bake-away.ts'
import { buildWindow } from './window-field.ts'
import { windowView } from './bake.ts'
import { HIDE_ABOVE, MAX_LEVEL, coverRects, coveredPixels, liftRows, liftSlope, type LiftCurve, type TerrainView } from './field.ts'
import { neededChunks } from './need.ts'
import type { RGB } from './material.ts'
import { CLOSED_KINDS, terrain } from './store.ts'
import { onTerrainSettings, terrainCurve, terrainEdges, terrainSettings, type TerrainSettings } from './settings.ts'
import { clockSun, sunAt, type DaySun } from './sun.ts'
import { edgeKey } from './edges.ts'
import { nearestWalkable, standTile, sweep, type Feet } from './walk.ts'
import { slopeGait } from './slope-gait.ts'
import { MoverShadow, frameProxy } from './sun-view.ts'
import { castProxy, shadeMultiply, shadowDarkness, shadowRay, type Cast, type ShadowProxy } from './sun-shadow.ts'
import { terrainVisibility } from './sun-map.ts'

const T = 16
const K = 3
/** Rows a lifted sprite's hiding check looks south: the tallest rise (15 levels) at 3 rows a level. */
const REACH = 46
/** The bake's halo, tiles each way: seams, edge bands and the sun's rays read across chunks. */
const HALO = 24
/** The sun moves this often (game seconds) when it follows the clock. */
const SUN_STEP_S = 600
/** Bakes in flight at once, and quick placeholders. */
const IN_FLIGHT = 2
const QUICK_IN_FLIGHT = 4
/** Frames between looks at what to bake when nothing it depends on moved (painted ground arriving). */
const SCHEDULE_FRAMES = 60
/** Chunks the view may ask to have baked past the attached ones (the wider window's bound). */
const NEED_BUDGET = 24

interface ChunkImage {
  img: Phaser.GameObjects.Image
  tex: string
  sig: string
  /** The look it was baked for (mode and tall ground): a different one is stale, and a placeholder goes in first. */
  look: string
  quick: boolean
  edges: number
  bytes: number
}

export interface SceneTerrainDeps {
  window: () => WildsWindow | null
  hero: () => Hero
  /** The hero's visible body: the avatar's container, or the sprite. */
  body: () => Phaser.GameObjects.Container | Phaser.GameObjects.Sprite
}

/** What a frame's lift pass changed, to put back after the render. */
interface Moved {
  o: Phaser.GameObjects.GameObject & { y: number; x: number; visible: boolean }
  y: number
  x: number
  visible: boolean
}

export class SceneTerrain {
  private images = new Map<string, ChunkImage>()
  private pending = new Map<string, string>()
  private pendingQuick = new Map<string, string>()
  /** The chunks baked now: the attached and the view's (./need.ts). */
  private wanted = new Set<string>()
  /** The view's chunks (./need.ts). */
  private need: string[] = []
  private plain: { sig: string; rgb: RGB } | null = null
  /** What the bake schedule was last worked out for, frames since, and bakes landed (each one looks again). */
  private schedKey = [Number.NaN, 0, 0, 0, 0, 0]
  private schedWas = ''
  private schedSettings: TerrainSettings | null = null
  private schedSettingsKey = ''
  private idle = 0
  private landed = 0
  private moved: Moved[] = []
  private last: Feet | null = null
  private active = false
  private sun: DaySun = sunAt(0.5)
  private sunKey = ''
  private shadow: MoverShadow | null = null
  private proxy: ShadowProxy | null = null
  private cast: Cast | null = null
  private castKey = ''
  private ghost: Phaser.GameObjects.Sprite | null = null
  private coverGfx: Phaser.GameObjects.Graphics | null = null
  private coverShow: Phaser.Display.Masks.GeometryMask | null = null
  private coverHide: Phaser.Display.Masks.GeometryMask | null = null
  private coverKey = ''
  private near: { view: TerrainView; ox: number; oy: number; key: string } | null = null
  private gait: ReturnType<typeof slopeGait> | null = null
  private scuffPx = 0
  private prev: [number, number] | null = null
  /** The readout (dev hooks, the E2E spec). */
  /** What the pass leaves alone (its own images), and objects drawn by someone else's feet (the hero's shadow). */
  private own = new WeakSet<Phaser.GameObjects.GameObject>()
  private feetOf = new WeakMap<Phaser.GameObjects.GameObject, [number, number]>()
  private seen = new WeakMap<Phaser.GameObjects.GameObject, { x: number; y: number; v: number; look: string; z: number; closed: boolean; behind: boolean }>()
  stats = { bakes: 0, quick: 0, bakeMs: [] as number[], quickMs: [] as number[], frameMs: [] as number[], startMs: [] as number[], scheduleMs: [] as number[], passMs: [] as number[], blocked: 0, k: 1, covered: 0, spriteTotal: 0, hidden: 0, hiddenOnClosed: 0 }

  constructor(private scene: Phaser.Scene, private deps: SceneTerrainDeps) {
    const step = () => this.gate()
    const pre = () => this.liftPass()
    const post = () => this.restore()
    const world = scene.physics.world
    world.on(Phaser.Physics.Arcade.Events.WORLD_STEP, step)
    scene.events.on(Phaser.Scenes.Events.PRE_RENDER, pre)
    scene.events.on(Phaser.Scenes.Events.RENDER, post)
    const off = onTerrainSettings((s, was) => this.changed(s, was))
    onSceneEnd(scene, () => {
      world?.off(Phaser.Physics.Arcade.Events.WORLD_STEP, step)
      scene.events.off(Phaser.Scenes.Events.PRE_RENDER, pre)
      scene.events.off(Phaser.Scenes.Events.RENDER, post)
      off()
      this.teardown(true)
    })
  }

  get on(): boolean {
    return this.active
  }

  private changed(s: TerrainSettings, was: TerrainSettings): void {
    if (!s.on && was.on) this.teardown()
    if (s.on && !was.on) this.deps.window()?.repaintForTerrain()
  }

  /** `ending`: the scene is going; its hero and sprites may already be gone. */
  private teardown(ending = false): void {
    this.active = false
    for (const c of this.images.values()) this.drop(c)
    this.images.clear()
    this.pending.clear()
    this.pendingQuick.clear()
    this.wanted.clear()
    this.need = []
    this.schedKey[0] = Number.NaN
    this.last = null
    this.shadow?.destroy()
    this.shadow = null
    this.dropCover(ending)
    terrain.clear()
    if (ending) return
    const anims = this.deps.hero()?.sprite?.anims
    if (anims) anims.timeScale = 1
  }

  private drop(c: ChunkImage): void {
    c.img.destroy()
    if (this.scene.textures.exists(c.tex)) this.scene.textures.remove(c.tex)
  }

  /** Each frame, before the hero moves. */
  update(): void {
    const s = terrainSettings()
    const win = this.deps.window()
    if (!s.on || !win) {
      if (this.active) this.teardown()
      return
    }
    if (!this.active) {
      this.active = true
      win.repaintForTerrain()
    }
    const t0 = performance.now()
    const hero = this.deps.hero().sprite
    const hcx = Math.floor(hero.x / CHUNK_PX)
    const hcy = Math.floor(hero.y / CHUNK_PX)
    this.updateSun(s)
    // What to bake is looked at again only when something it depends on moved (the view by 32 px, the
    // terrain, the look, the sun, a bake landing), or every SCHEDULE_FRAMES frames for painted ground arriving.
    const v = this.scene.cameras.main.worldView
    // The settings object is new whenever they change.
    if (s !== this.schedSettings) {
      this.schedSettings = s
      this.schedSettingsKey = `${this.look(s)},${edgeKey(terrainEdges(s))},${s.sunStrength}`
    }
    const k = this.schedKey
    const vx = Math.floor(v.x / 32)
    const vy = Math.floor(v.y / 32)
    const moved = k[0] !== vx || k[1] !== vy || k[2] !== hcx || k[3] !== hcy || k[4] !== terrain.arrived || k[5] !== this.landed || this.schedWas !== this.schedSettingsKey + this.sunKey
    let started = false
    let startMs = 0
    if (moved || ++this.idle >= SCHEDULE_FRAMES) {
      k[0] = vx
      k[1] = vy
      k[2] = hcx
      k[3] = hcy
      k[4] = terrain.arrived
      k[5] = this.landed
      this.schedWas = this.schedSettingsKey + this.sunKey
      const ts = performance.now()
      this.idle = 0
      const want: [number, number][] = []
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) want.push([hcx + dx, hcy + dy])
      // The view's chunks, south as far as their lifted ground reaches into it.
      const curve = this.curve(s)
      const lift = s.mode === 'lift'
      const need = neededChunks({ x: v.x, y: v.y, w: v.width, h: v.height }, (z) => (lift ? T * liftRows(z, K, curve) : 0), (cx, cy) => terrain.top(cx, cy), NEED_BUDGET)
      this.need = need.map(([cx, cy]) => `${cx},${cy}`)
      for (const [cx, cy] of need) if (Math.abs(cx - hcx) > 2 || Math.abs(cy - hcy) > 2) want.push([cx, cy])
      terrain.want(want)
      // A bake started (its window built and posted) is the attach cost, kept apart from the steady frame.
      const tb = performance.now()
      started = this.bakes(win, s)
      startMs = performance.now() - tb
      this.stats.scheduleMs.push(performance.now() - ts - (started ? startMs : 0))
      if (this.stats.scheduleMs.length > 200) this.stats.scheduleMs.shift()
    }
    if (started) {
      this.stats.startMs.push(startMs)
      if (this.stats.startMs.length > 200) this.stats.startMs.shift()
    }
    this.heroLook(s)
    this.stats.frameMs.push(performance.now() - t0 - (started ? startMs : 0))
    if (this.stats.frameMs.length > 600) this.stats.frameMs.shift()
  }

  private updateSun(s: TerrainSettings): void {
    const now = gameNow()
    const key = s.sunClock ? `c${Math.floor(now / SUN_STEP_S)}` : `t${s.sunTime.toFixed(3)}`
    if (key === this.sunKey) return
    this.sunKey = key
    this.sun = s.sunClock ? clockSun(Math.floor(now / SUN_STEP_S) * SUN_STEP_S) : sunAt(s.sunTime)
  }

  /** What a chunk's bake depends on: the terrain round it, the look, the sun, its painted ground. */
  private bakeSig(cx: number, cy: number, s: TerrainSettings, albedo: string): string {
    let around = ''
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) around += terrain.has(cx + dx, cy + dy) ? '1' : '0'
    return `${around}|${this.look(s)}|${edgeKey(terrainEdges(s))}|${this.sunKey}|${s.sunStrength}|${albedo}`
  }

  /** The lift's tall-ground curve (none at full height or top-down). */
  private curve(s: TerrainSettings): LiftCurve | undefined {
    return s.mode === 'lift' ? terrainCurve(s) : undefined
  }

  /** The look a bake's shape depends on: the mode and, lifted, the tall-ground curve. */
  private look(s: TerrainSettings): string {
    const c = this.curve(s)
    return c ? `lift|${c.knee}|${c.above}` : s.mode
  }

  /** The plain ground a placeholder stands on: the mean of a painted chunk near the hero, kept per paint. */
  private plainFrom(chunks: { rgba: Uint8ClampedArray | null; sig: string }[]): RGB | undefined {
    const p = chunks.find((c) => c.rgba)
    if (!p) return this.plain?.rgb
    if (this.plain?.sig !== p.sig) {
      const rgb: RGB = [0, 0, 0]
      let n = 0
      for (let o = 0; o < p.rgba!.length; o += 4 * 997) {
        rgb[0] += p.rgba![o]!
        rgb[1] += p.rgba![o + 1]!
        rgb[2] += p.rgba![o + 2]!
        n++
      }
      this.plain = { sig: p.sig, rgb: [rgb[0] / n, rgb[1] / n, rgb[2] / n] }
    }
    return this.plain!.rgb
  }

  /** Start the bakes due (true when one started): a quick placeholder where the look has none, then the real bakes. */
  private bakes(win: WildsWindow, s: TerrainSettings): boolean {
    let started = false
    const order = new Map(this.need.map((k, i) => [k, i]))
    const chunks = win.terrainChunks(this.need)
    this.wanted = new Set(chunks.map((c) => c.key))
    for (const [key, c] of this.images) if (!this.wanted.has(key)) { this.drop(c); this.images.delete(key) }
    // The view's chunks first (nearest its middle), then the rest nearest the hero.
    const hero = this.deps.hero().sprite
    const far = (c: { cx: number; cy: number }) => Math.hypot(c.cx + 0.5 - hero.x / CHUNK_PX, c.cy + 0.5 - hero.y / CHUNK_PX)
    chunks.sort((a, b) => (order.get(a.key) ?? 1e3 + far(a)) - (order.get(b.key) ?? 1e3 + far(b)))
    const look = this.look(s)
    const lift = s.mode === 'lift'
    const curve = this.curve(s)
    const plain = this.plainFrom(chunks)
    const job = (cx: number, cy: number, albedo: Uint8ClampedArray | null, quick: boolean): BakeJob => {
      const ox = cx * CHUNK_TILES - HALO
      const oy = cy * CHUNK_TILES - HALO
      return { win: buildWindow(terrain, ox, oy, CHUNK_TILES + 2 * HALO, CHUNK_TILES + 2 * HALO), cx, cy, albedo, lift, curve, quick, plain, sun: this.sun, sunStrength: s.sunStrength, edges: terrainEdges(s) }
    }
    for (const c of chunks) {
      if (!terrain.has(c.cx, c.cy)) continue
      const had = this.images.get(c.key)
      // A placeholder first where this look has nothing yet; an attached chunk's flat ground is its own placeholder.
      if (!c.attached && (!had || had.look !== look) && this.pendingQuick.size < QUICK_IN_FLIGHT && !this.pendingQuick.has(c.key) && this.pending.get(c.key)?.includes(`|${look}|`) !== true) {
        const qsig = `quick|${look}`
        this.pendingQuick.set(c.key, qsig)
        started = true
        void bakeAway(job(c.cx, c.cy, c.rgba, true)).then((r) => {
          if (this.pendingQuick.get(c.key) !== qsig) return
          this.pendingQuick.delete(c.key)
          if (!this.active || !this.wanted.has(c.key)) return
          // The real bake for this look got here first: keep it.
          const now = this.images.get(c.key)
          if (now && now.look === look && !now.quick) return
          this.stats.quick++
          this.stats.quickMs.push(r.ms)
          if (this.stats.quickMs.length > 200) this.stats.quickMs.shift()
          this.place(c.key, c.cy, qsig, look, true, r.baked)
        })
      }
      // The real bake waits for the chunk's painted ground.
      if (this.pending.size >= IN_FLIGHT || !c.rgba) continue
      const sig = this.bakeSig(c.cx, c.cy, s, c.sig)
      if (had?.sig === sig || this.pending.get(c.key) === sig) continue
      this.pending.set(c.key, sig)
      started = true
      void bakeAway(job(c.cx, c.cy, c.rgba, false)).then((r) => {
        if (this.pending.get(c.key) !== sig) return
        this.pending.delete(c.key)
        if (!this.active || !this.wanted.has(c.key)) return
        this.stats.bakes++
        this.stats.bakeMs.push(r.ms)
        if (this.stats.bakeMs.length > 200) this.stats.bakeMs.shift()
        this.place(c.key, c.cy, sig, look, false, r.baked)
      })
    }
    return started
  }

  private place(key: string, cy: number, sig: string, look: string, quick: boolean, b: Baked): void {
    const had = this.images.get(key)
    const tex = `terrain:${key}:${had?.tex.endsWith(':a') ? 'b' : 'a'}`
    const canvas = document.createElement('canvas')
    canvas.width = b.w
    canvas.height = b.h
    canvas.getContext('2d')!.putImageData(new ImageData(b.rgba as Uint8ClampedArray<ArrayBuffer>, b.w, b.h), 0, 0)
    if (this.scene.textures.exists(tex)) this.scene.textures.remove(tex)
    this.scene.textures.addCanvas(tex, canvas)
    // Over the flat ground, under its tile art; lifted, the north chunks first.
    const img = this.scene.add.image(b.x, b.y, tex).setOrigin(0, 0).setDepth(GROUND_DEPTH + 0.25 + (cy + 1e5) * 1e-6)
    this.own.add(img)
    if (had) this.drop(had)
    this.images.set(key, { img, tex, sig, look, quick, edges: b.edges, bytes: b.w * b.h * 4 })
    this.landed++
  }

  // ------------------------------------------------------------ walking

  private feet(): Feet {
    const body = this.deps.hero().sprite.body as Phaser.Physics.Arcade.Body
    return { x: body.center.x, y: body.bottom, hw: body.halfWidth, fh: body.height }
  }

  /** After a physics step: the hero's motion, carried over the field from the last good feet. */
  private gate(): void {
    if (!this.active) return
    const hero = this.deps.hero()
    const body = hero.sprite.body as Phaser.Physics.Arcade.Body | null
    if (!body || !body.enable) {
      this.last = null
      return
    }
    const now = this.feet()
    const last = this.last
    const [tx, ty] = standTile(now)
    // A jump (a warp, arriving), standing where nothing is known yet, or nothing known before: taken as is.
    if (!last || Math.hypot(now.x - last.x, now.y - last.y) > 24 || !terrain.known(tx, ty)) {
      if (terrain.known(tx, ty) && !terrain.walkable(tx, ty)) {
        // Standing on ground nobody walks (the switch just went on): the nearest walkable tile.
        const to = nearestWalkable(terrain, tx, ty)
        if (to) this.put(body, to[0] * T + 8 - now.x, to[1] * T + 10 - now.y)
      }
      this.last = this.feet()
      return
    }
    const s = terrainSettings()
    const w = { ...last }
    const r = sweep(terrain, w, now.x - last.x, now.y - last.y, (x, y) => terrain.gradientAt(x, y), s.uphill, s.downhill)
    this.stats.k = r.k
    if (r.bx || r.by) this.stats.blocked++
    if (Math.abs(w.x - now.x) > 1e-6 || Math.abs(w.y - now.y) > 1e-6) this.put(body, w.x - now.x, w.y - now.y)
    if (r.bx) body.velocity.x = 0
    if (r.by) body.velocity.y = 0
    this.last = w
  }

  private put(body: Phaser.Physics.Arcade.Body, dx: number, dy: number): void {
    body.position.x += dx
    body.position.y += dy
    body.updateCenter()
  }

  // ------------------------------------------------------------ the hero's look

  private heroLook(s: TerrainSettings): void {
    const hero = this.deps.hero()
    const sp = hero.sprite
    // The gait: cadence from real field speed, a small lean, scuffs on steep ground.
    const dt = this.scene.game.loop.delta / 1000
    const [gx, gy] = terrain.gradientAt(sp.x, sp.y - 2)
    if (this.prev && dt > 0 && s.gait) {
      const vx = (sp.x - this.prev[0]) / dt
      const vy = (sp.y - this.prev[1]) / dt
      this.gait = slopeGait(gx, gy, vx, vy, Math.max(1, (sp.body as Phaser.Physics.Arcade.Body).velocity.length() || 90))
      if (sp.anims.isPlaying) sp.anims.timeScale = Math.max(0.4, Math.min(1.6, this.gait.cadence || 1))
      this.scuffPx += Math.hypot(sp.x - this.prev[0], sp.y - this.prev[1])
      if (this.gait.scuff && this.scuffPx >= 28) {
        this.scuffPx = 0
        const dust = this.scene.add.rectangle(sp.x - 2, sp.y + 1, 3, 1, 0xc2b68b, 0.45).setDepth(sp.y + 3)
        this.scene.tweens.add({ targets: dust, alpha: 0, y: dust.y - 2, duration: 260, onComplete: () => dust.destroy() })
      }
    } else {
      this.gait = null
      sp.anims.timeScale = 1
    }
    this.prev = [sp.x, sp.y]
    // A proxy shadow cast by the sun (the blob is hidden in the pass).
    if (!this.shadow) this.shadow = new MoverShadow(this.scene, 'terrain-hero-shadow')
    if (!this.proxy && sp.frame) this.proxy = frameProxy(this.scene, sp.texture.key, sp.frame.name, 'body', sp.scaleY)
    if (!this.proxy || this.sun.daylight <= 0 || s.sunStrength <= 0) {
      this.shadow.hide()
      return
    }
    const z = terrain.zAt(sp.x, sp.y - 2)
    const nearV = this.nearView(sp.x, sp.y)
    const visible = nearV && !Number.isNaN(z) ? terrainVisibility(nearV.view.field, sp.x - nearV.ox * T, sp.y - 2 - nearV.oy * T, z, this.sun.direction) : 1
    // The shape is cast once per ray (quantized), light and frame; walking only moves it.
    const q = (n: number) => Math.round(n * 20) / 20
    const v = shadowRay(gx, gy, this.sun.direction, s.mode === 'lift' && !Number.isNaN(z) ? liftSlope(z, K, this.curve(s)) : 0)
    const vq: [number, number] = [q(v[0]), q(v[1])]
    const stamp = `${vq[0]},${vq[1]},${this.sunKey},${visible},${s.sunStrength},${sp.frame.name}`
    if (stamp !== this.castKey || !this.cast) {
      this.cast = castProxy(this.proxy, 0, 0, vq)
      this.castKey = stamp
    }
    const cast = this.cast
    const fx = Math.round(sp.x)
    const fy = Math.round(sp.y)
    const { daylight } = this.sun
    this.shadow.draw(stamp, fx + cast.x0, fy + cast.y0, cast.w, cast.h, (wx, wy) => {
      const j = (wy - fy - cast.y0) * cast.w + (wx - fx - cast.x0)
      if (!cast.dir[j] && !cast.contact[j]) return null
      const d = shadowDarkness(cast.dir[j]!, cast.contact[j]!, visible, visible, s.sunStrength, daylight)
      return d > 0 ? shadeMultiply(d) : null
    })
    this.feetOf.set(this.shadow.image, [sp.x, sp.y])
  }

  /** A field window round (x, y) world px, reaching far enough south for the lift's hiding (rebuilt as the hero crosses tiles or terrain arrives). */
  private nearView(x: number, y: number): { view: TerrainView; ox: number; oy: number; key: string } | null {
    const tx = Math.floor(x / T)
    const ty = Math.floor(y / T)
    const s = terrainSettings()
    const lift = s.mode === 'lift'
    const key = `${tx},${ty},${terrain.arrived},${this.look(s)}`
    if (this.near?.key === key) return this.near
    const ox = tx - 6
    const oy = ty - 8
    const win = buildWindow(terrain, ox, oy, 13, REACH + 10)
    this.near = { view: windowView(win, lift, this.curve(s)), ox, oy, key }
    return this.near
  }

  // ------------------------------------------------------------ the lift pass

  /** Is someone at (x, y) world px, height z, behind nearer higher ground in the lift? */
  private behind(x: number, y: number, z: number, curve: LiftCurve | undefined): boolean {
    const sFoot = y / T - liftRows(z, K, curve)
    const ty0 = Math.floor(y / T)
    const most = liftRows(MAX_LEVEL, K, curve)
    for (let ty = ty0 + 1; ty <= ty0 + REACH; ty++) {
      if (ty - most > sFoot) break
      const zn = terrain.zAt(x, ty * T)
      if (Number.isNaN(zn)) continue
      if (ty - liftRows(zn, K, curve) < sFoot - 0.02 && zn > z + HIDE_ABOVE) return true
    }
    return false
  }

  private liftPass(): void {
    if (!this.active) return
    const t0 = performance.now()
    const s = terrainSettings()
    const lift = s.mode === 'lift'
    const curve = this.curve(s)
    const look = this.look(s)
    const hero = this.deps.hero()
    const heroBody = this.deps.body()
    // The hero's feet in field space, before the pass lifts the sprite.
    const heroAt: [number, number] = [hero.sprite.x, hero.sprite.y]
    const view = this.scene.cameras.main.worldView
    // The lift draws ground up to 15 levels north of where it lies: sprites that far south may show.
    const reach = lift ? T * liftRows(MAX_LEVEL, K, curve) + 64 : 64
    let hidden = 0
    let onClosed = 0
    for (const o of this.scene.children.list) {
      const g = o as Phaser.GameObjects.GameObject & { x: number; y: number; visible: boolean; scrollFactorY?: number; depth: number; type: string }
      if (!g.visible || g.scrollFactorY !== 1 || this.own.has(o)) continue
      if (g.type !== 'Image' && g.type !== 'Sprite' && g.type !== 'Container' && g.type !== 'Text' && g.type !== 'Rectangle') continue
      // The flat ground stays under the lifted images (they cover it wherever they're whole): where one is still on its way, ground shows, never the void.
      if (g.depth <= GROUND_DEPTH) continue
      // The blob shadow gives way to the sun's.
      if (o === hero.shadow) {
        this.move(g, 0, 0, false)
        continue
      }
      const foot = this.feetOf.get(o) ?? [g.x, g.y]
      // Off screen (with the lift's reach north): nothing to draw.
      if (foot[0] < view.x - 64 || foot[0] > view.right + 64 || foot[1] < view.y - 32 || foot[1] > view.bottom + reach) continue
      const isHero = o === heroBody || o === hero.sprite
      // Still sprites keep what was worked out for them until they move or the terrain changes.
      let at = this.seen.get(o)
      if (!at || at.x !== foot[0] || at.y !== foot[1] || at.v !== terrain.arrived || at.look !== look) {
        const z = terrain.zAt(foot[0], foot[1] - 1)
        const closed = !isHero && CLOSED_KINDS.has(terrain.kindAt(Math.floor(foot[0] / T), Math.floor((foot[1] - 1) / T)))
        const behind = lift && !isHero && !closed && g.depth < 1e6 && !Number.isNaN(z) && z !== 0 && this.behind(foot[0], foot[1] - 1, z, curve)
        at = { x: foot[0], y: foot[1], v: terrain.arrived, look, z, closed, behind }
        this.seen.set(o, at)
      }
      if (at.closed) {
        onClosed++
        this.move(g, 0, 0, false)
        continue
      }
      if (!lift) continue
      const z = at.z
      if (Number.isNaN(z) || z === 0) continue
      if (at.behind) {
        hidden++
        this.move(g, 0, 0, false)
        continue
      }
      let dx = 0
      let dy = -T * liftRows(z, K, curve)
      if (isHero && this.gait) {
        dx += this.gait.x
        dy += this.gait.y
      }
      this.move(g, dx, dy, true)
    }
    this.stats.hidden = hidden
    this.stats.hiddenOnClosed = onClosed
    this.seeThrough(lift, heroAt)
    const ms = performance.now() - t0
    this.stats.passMs.push(ms)
    if (this.stats.passMs.length > 600) this.stats.passMs.shift()
    const f = this.stats.frameMs
    if (f.length) f[f.length - 1] = f[f.length - 1]! + ms
  }

  private move(g: Moved['o'], dx: number, dy: number, visible: boolean): void {
    this.moved.push({ o: g, x: g.x, y: g.y, visible: g.visible })
    g.x += dx
    g.y += dy
    if (!visible) g.visible = false
  }

  private restore(): void {
    for (let i = this.moved.length - 1; i >= 0; i--) {
      const m = this.moved[i]!
      if (!m.o.scene) continue
      m.o.x = m.x
      m.o.y = m.y
      m.o.visible = m.visible
    }
    this.moved.length = 0
  }

  // ------------------------------------------------------------ partial see-through

  private dropCover(ending = false): void {
    const body = ending ? null : this.deps.body()
    if (body && this.coverHide && body.mask === this.coverHide) body.clearMask()
    this.ghost?.destroy()
    this.coverShow?.destroy()
    this.coverHide?.destroy()
    this.coverGfx?.destroy()
    this.ghost = null
    this.coverShow = this.coverHide = null
    this.coverGfx = null
    this.coverKey = ''
  }

  /** Only the hero's pixels that nearer, higher ground covers show as the grey outline; the rest draws as usual. */
  private seeThrough(lift: boolean, at: [number, number]): void {
    const hero = this.deps.hero()
    const sp = hero.sprite
    const body = this.deps.body()
    if (!lift) {
      if (this.coverGfx) this.dropCover()
      this.stats.covered = 0
      return
    }
    if (!this.coverGfx) {
      this.coverGfx = this.scene.make.graphics({ x: 0, y: 0 }, false)
      this.coverShow = this.coverGfx.createGeometryMask()
      this.coverHide = this.coverGfx.createGeometryMask().setInvertAlpha(true)
      this.ghost = this.scene.add.sprite(0, 0, sp.texture.key, sp.frame.name).setOrigin(0.5, 1).setVisible(false).setTintFill(0x2c2640).setAlpha(0.7).setDepth(9e6)
      this.own.add(this.ghost)
      this.ghost.setMask(this.coverShow)
    }
    const z = terrain.zAt(at[0], at[1] - 2)
    const near = this.nearView(at[0], at[1])
    if (!near || Number.isNaN(z)) {
      this.ghost!.setVisible(false)
      if (body.mask) body.clearMask()
      return
    }
    // The sprite as drawn this frame (the pass has lifted it).
    const x0 = Math.floor(sp.x - sp.displayWidth * sp.originX)
    const y0 = Math.floor(sp.y - sp.displayHeight * sp.originY)
    const w = Math.ceil(sp.displayWidth) + 1
    const h = Math.ceil(sp.displayHeight) + 1
    const fieldY = at[1] - 2
    const key = `${x0},${y0},${w},${h},${fieldY.toFixed(1)},${near.key}`
    if (key !== this.coverKey) {
      this.coverKey = key
      const v = near.view
      // View px: field px from the window's origin, the lift's margin on top.
      const vx = near.ox * T
      const vy = (near.oy - v.pad) * T
      const mask = coveredPixels(v, fieldY - near.oy * T, z, x0 - vx, y0 - vy, w, h)
      let covered = 0
      for (const m of mask) covered += m
      this.stats.covered = covered
      this.stats.spriteTotal = w * h
      this.coverGfx!.clear().fillStyle(0xffffff)
      for (const r of coverRects(mask, x0, y0, w, h)) this.coverGfx!.fillRect(r.x, r.y, r.w, r.h)
    }
    if (this.stats.covered === 0) {
      if (body.mask === this.coverHide) body.clearMask()
      this.ghost!.setVisible(false)
      return
    }
    if (body.mask !== this.coverHide) body.setMask(this.coverHide!)
    this.ghost!.setTexture(sp.texture.key, sp.frame.name).setPosition(sp.x, sp.y).setScale(sp.scaleX, sp.scaleY).setFlipX(sp.flipX).setVisible(true)
    this.moved.push({ o: this.ghost! as Moved['o'], x: this.ghost!.x, y: this.ghost!.y, visible: false })
  }

  /**
   * The void check (dev hooks, the E2E spec): one frame drawn over a magenta
   * background, and the magenta pixels counted (canvas px): wherever
   * nothing was drawn. The background is put back after.
   */
  voidProbe(): Promise<{ void: number; total: number; at: [number, number][]; why: Record<string, unknown>[] }> {
    const cam = this.scene.cameras.main
    const c = cam.backgroundColor
    const prev = { r: c.red, g: c.green, b: c.blue, a: c.alpha }
    cam.setBackgroundColor(0xff00ff)
    return new Promise((resolve) => {
      this.scene.game.renderer.snapshot((snap) => {
        cam.setBackgroundColor(prev)
        const img = snap as HTMLImageElement
        const count = () => {
          const canvas = document.createElement('canvas')
          canvas.width = img.width
          canvas.height = img.height
          const g = canvas.getContext('2d')!
          g.drawImage(img, 0, 0)
          const px = g.getImageData(0, 0, img.width, img.height).data
          let n = 0
          const at: [number, number][] = []
          for (let i = 0; i < px.length; i += 4) {
            if (px[i]! > 150 && px[i + 2]! > 150 && px[i + 1]! < 90) {
              n++
              if (at.length < 16 && n % 97 === 1) at.push([(i / 4) % img.width, Math.floor(i / 4 / img.width)])
            }
          }
          resolve({ void: n, total: img.width * img.height, at, why: at.map(([x, y]) => this.whyEmpty(x, y)) })
        }
        if (img.complete) count()
        else img.onload = count
      })
    })
  }

  /** What's at canvas px (x, y) as the terrain sees it: the world point, its chunk, and each image over it with its alpha there. */
  private whyEmpty(x: number, y: number): Record<string, unknown> {
    const p = this.scene.cameras.main.getWorldPoint(x, y)
    const key = `${Math.floor(p.x / CHUNK_PX)},${Math.floor(p.y / CHUNK_PX)}`
    const over: Record<string, unknown>[] = []
    for (const [k, c] of this.images) {
      const ix = Math.floor(p.x - c.img.x)
      const iy = Math.floor(p.y - c.img.y)
      if (ix < 0 || iy < 0 || ix >= c.img.width || iy >= c.img.height) continue
      const src = this.scene.textures.get(c.tex).getSourceImage() as HTMLCanvasElement
      const a = src.getContext?.('2d')?.getImageData(ix, iy, 1, 1).data[3]
      over.push({ key: k, quick: c.quick, look: c.look, at: [ix, iy], size: [c.img.width, c.img.height], alpha: a, depth: c.img.depth, visible: c.img.visible })
    }
    return { canvas: [x, y], world: [Math.round(p.x * 100) / 100, Math.round(p.y * 100) / 100], chunk: key, wanted: this.wanted.has(key), need: this.need.includes(key), terrain: terrain.has(Math.floor(p.x / CHUNK_PX), Math.floor(p.y / CHUNK_PX)), over }
  }

  /** Timings afresh (the spec's steady walk). */
  resetStats(): void {
    this.stats.frameMs.length = 0
    this.stats.scheduleMs.length = 0
    this.stats.passMs.length = 0
    this.stats.startMs.length = 0
  }

  /** The readout for the dev hooks and the E2E spec. */
  state(): Record<string, unknown> {
    const sp = this.deps.hero().sprite
    const [tx, ty] = [Math.floor(sp.x / T), Math.floor((sp.y - 2) / T)]
    const pct = (xs: number[]) => {
      const v = [...xs].sort((a, b) => a - b)
      return { n: v.length, p50: v[Math.floor(v.length / 2)] ?? 0, p95: v[Math.floor(v.length * 0.95)] ?? 0, max: v.at(-1) ?? 0 }
    }
    return {
      on: this.active,
      settings: terrainSettings(),
      chunks: terrain.size,
      error: terrain.error,
      images: [...this.images.entries()].map(([k, c]) => ({ key: k, x: c.img.x, y: c.img.y, w: c.img.width, h: c.img.height, edges: c.edges, quick: c.quick, look: c.look })),
      pending: this.pending.size,
      pendingQuick: this.pendingQuick.size,
      need: this.need,
      /** Needed chunks with terrain and no image for the look: a placeholder or a bake still on its way. */
      missing: this.need.filter((k) => { const [cx, cy] = k.split(',').map(Number) as [number, number]; return this.wanted.has(k) && terrain.has(cx, cy) && this.images.get(k)?.look !== this.look(terrainSettings()) }),
      bytes: [...this.images.values()].reduce((a, c) => a + c.bytes, 0),
      quick: this.stats.quick,
      quickMs: pct(this.stats.quickMs),
      textures: this.scene.textures.getTextureKeys().filter((k) => k.startsWith('terrain:')).length,
      hero: { x: sp.x, y: sp.y, tile: [tx, ty], z: terrain.zAt(sp.x, sp.y - 2), kind: terrain.kindAt(tx, ty), walkable: terrain.walkable(tx, ty), gradient: terrain.gradientAt(sp.x, sp.y - 2) },
      k: this.stats.k,
      blocked: this.stats.blocked,
      gait: this.gait,
      cover: { covered: this.stats.covered, total: this.stats.spriteTotal },
      hidden: this.stats.hidden,
      hiddenOnClosed: this.stats.hiddenOnClosed,
      sun: { time: this.sun.time, daylight: this.sun.daylight, key: this.sunKey },
      bakes: this.stats.bakes,
      bakeMs: pct(this.stats.bakeMs),
      frameMs: pct(this.stats.frameMs),
      startMs: pct(this.stats.startMs),
      /** Of the frame: working out what to bake (when something moved), and the lift pass before the render. */
      scheduleMs: pct(this.stats.scheduleMs),
      passMs: pct(this.stats.passMs)
    }
  }
}
