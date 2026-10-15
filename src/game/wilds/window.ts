import { lotAt } from '../../lib/lots.ts'
import { homesteadsFor } from '../homestead.ts'
import { onSceneEnd } from '../scene-end.ts'
/**
 * The open map's moving window (docs/design/open-map.md 2.5, 2.6, 2.10):
 * one Wilds scene, no restart between chunks.
 *
 * The scene keeps the 3×3 chunks around the hero attached (ground,
 * collision, scenery, workable pieces, entities, sites) and the ring around
 * that fetched and decoded. Crossing into another chunk recentres the
 * window: a near read for the new chunk (at most every 10 s a chunk), the
 * new ring's bodies fetched, the new row painted and attached; the row left
 * behind goes once the hero is SLACK_TILES into the new chunk
 * (./window-plan.ts keepAttached), so stepping back over the edge rebuilds
 * nothing. Painting is one chunk a frame, before the chunk is attached
 * (a chunk is painted once its neighbours are known, so its image joins
 * theirs). An attached chunk's ground and collision go in at once, the rest
 * of it a few milliseconds a frame, nearest the hero first. Chunks past the
 * frontier in the 3×3 are the drift. Landmarks of the fetched ring are
 * drawn too, sprite only, so you steer by them from a chunk away; one
 * counts as seen once it is on screen.
 *
 * The window also repaints a chunk whose ground changes moved (someone laid
 * stone), and reloads everything at the turning (./world-turning.ts).
 *
 * Fixed chunks (an authored layout's: the Commons, location-seam.md 4) are
 * on the grid too: the window attaches them like the rest, from their
 * footprint's served chunks (./fixed.ts), with their ground laid from the
 * footprint's painted tileset instead of a per-chunk paint (./fixed-chunk.ts).
 * Only chunks on neither the frontier nor a footprint are the drift.
 */
import type Phaser from 'phaser'
import { refreshLanternVisuals } from '../area/lanterns.ts'
import { ensureSceneryArt } from '../area/props.ts'
import { groundTiles, type GroundTiles } from '../area/terrain.ts'
import { calendarAt } from '../../lib/calendar.ts'
import { seasonMark } from '../../lib/wilds/outer.ts'
import { gameNow } from '../clock.ts'
import { bus, EV } from '../events.ts'
import { generateRepairArt } from '../repairs-art.ts'
import type { Session } from '../session.ts'
import { CHUNK_TILES, chunkKey, chunkOfPixel, parseChunkKey } from './coords.ts'
import { fixedPlaceOf, footprint, footprintAt, prepareFixed, applyLotHome, sceneryOf, type FixedFootprint } from './fixed.ts'
import { FixedChunk, type FixedChunkDeps } from './fixed-chunk.ts'
import type { ExitDef } from '../worlds.ts'
import { PLACES, fixedChunks } from '../../lib/places.ts'
import { chunkSig, effectiveChunk, forgetGround, groundAt, solidAt } from './ground-view.ts'
import { chunkGather, chunkLandmarks } from './terrain.ts'
import { crossed, frontierDistance, keepAttached, paintable, planWindow, SLACK_TILES, veilEdges, type WindowPlan } from './window-plan.ts'
import { AttachedChunk, BuildQueue, DriftChunk, groundTexture, paintDriftChunk, type ChunkDeps } from './window-chunk.ts'
import { paintAway, paintHere, type PaintJob } from './paint-worker.ts'
import { groundTable } from './ground-table.ts'
import { chunkOrigin } from './terrain.ts'
import { fnv1a32 } from '../../lib/hash.ts'
import { TILE } from '../../lib/tile.ts'
import { chunkTerrain, insideNamedFrontier, loadWildsChunk, NEAR_MAX_AGE_MS, refreshNear, wildsEpoch, wildsFrontier, wildsView } from './store.ts'
import { markSeen, markWalked } from './walked.ts'
import { perfSpan, perfTime, perfWithout } from '../perf.ts'
import { addAll, destroyAll, looseImage } from '../area/bulk.ts'

export interface WindowDeps extends Omit<ChunkDeps, 'ground' | 'gather' | 'builds'>, Pick<FixedChunkDeps, 'interactables' | 'enter' | 'hooks'> {
  session: Session
  hero: () => { x: number; y: number }
}

/** On the grid as the window sees it: inside the frontier the server named, or on a fixed footprint. */
export function onWindow(cx: number, cy: number): boolean {
  return insideNamedFrontier(cx, cy) || fixedPlaceOf(cx, cy) !== null
}

/** Pixels from the grid (the frontier and every fixed footprint): the drift fogs with it. */
export function gridDistance(f: { minCx: number; minCy: number; maxCx: number; maxCy: number }, wx: number, wy: number): number {
  let d = frontierDistance(f, wx, wy)
  for (const p of PLACES.fixed) {
    const c = fixedChunks(p)
    d = Math.min(d, frontierDistance({ minCx: c.x0, minCy: c.y0, maxCx: c.x1, maxCy: c.y1 }, wx, wy))
  }
  return d
}

/** Keys of the code-drawn scenery textures a fixed footprint's chunks can ask for. */
function fixedArtKeys(fp: FixedFootprint): string[] {
  const seen = new Set<string>()
  for (const list of fp.objects.values()) {
    for (const o of list) {
      if (o.variant && !seen.has(o.variant)) seen.add(o.variant)
    }
  }
  return [...seen]
}

/** Pre-warm every code-drawn texture a fixed footprint's chunks need. */
export function prewarmFixedArt(scene: Phaser.Scene, fp: FixedFootprint): void {
  generateRepairArt(scene)
  for (const key of fixedArtKeys(fp)) ensureSceneryArt(scene, key)
}

/** A painted chunk texture and what it was painted from. */
interface PaintedChunk {
  key: string
  /** epoch, look and changes: a different one repaints. */
  sig: string
}

/** Paint timings (ms), newest last, for the playtest hooks and the budget report. */
const PAINT_LOG_MAX = 64
/** How long a frame spends building attached chunks (ms; open-map.md 4's budget is 8 for all the window's work). */
const BUILD_MS = 4

export class WildsWindow {
  private plan: WindowPlan | null = null
  private attached = new Map<string, AttachedChunk>()
  /** Attached fixed chunks (./fixed-chunk.ts). */
  private fixed = new Map<string, FixedChunk>()
  /** Each footprint's painted ground, laid a chunk at a time (one per footprint and scene). */
  private fixedGround = new Map<string, GroundTiles>()
  private failedGround = new Set<string>()
  /** The attached chunks still being built, in attachment order (./window-chunk.ts BuildQueue). */
  readonly builds = new BuildQueue()
  private drifts = new Map<string, DriftChunk>()
  private paints = new Map<string, PaintedChunk>()
  private far = new Map<string, Phaser.GameObjects.Image[]>()
  private loading = new Set<string>()
  /** When a chunk whose fetch failed may be asked for again (ms, page clock). */
  private retryAt = new Map<string, number>()
  /** Chunks a worker is painting now, with the signature they were asked with. */
  private pending = new Map<string, string>()
  /** Painting on this thread, at once (the first window, behind the scene's fade). */
  private now = false
  private lastVersion = -1
  private fixedDaySignature = ''
  private seasonalPending = new Set<string>()
  /** The hero's tile when the window last looked at what it keeps past the 3×3. */
  private heroTile = ''
  private seenTimer = 0
  private readonly paintLog: { chunk: string; ms: number; drift: boolean; thread: 'worker' | 'main' }[] = []
  /** Chunks attached so far, and dropped (playtests: crossing back over an edge builds nothing). */
  private attaches = 0
  private drops = 0
  private waiters: (() => void)[] = []
  private gone = false
  /** This window's identity (a playtest sees it never changes while walking: no scene restart). */
  private readonly id = Math.random().toString(36).slice(2, 10)

  constructor(private deps: WindowDeps) {
    onSceneEnd(deps.scene, () => this.destroy())
    bus.on(EV.fixedReady, this.onFixedReady)
    // The fixed footprints' ground (its tilemap and cells) and code-drawn
    // textures are prepared now, behind the scene's fade, not on a walking frame.
    this.now = true
    try {
      for (const p of PLACES.fixed) {
        const fp = footprint(p.id)
        if (fp) perfTime('fixed-ground', () => this.groundFor(fp))
      }
    } finally {
      this.now = false
    }
  }

  private readonly onFixedReady = (): void => {
    if (this.gone || !this.deps.scene?.make) return
    for (const p of PLACES.fixed) {
      const fp = footprint(p.id)
      if (fp && !this.fixedGround.has(p.id) && !this.failedGround.has(p.id)) {
        perfTime('fixed-ground', () => this.groundFor(fp))
      }
    }
  }

  // ------------------------------------------------------------ per frame

  update(dt: number): void {
    if (this.gone) return
    const calendar = calendarAt(gameNow())
    const signature = JSON.stringify([calendar.festival, calendar.mark, calendar.wick])
    if (signature !== this.fixedDaySignature) {
      if (this.fixedDaySignature) this.seasonalPending = new Set(this.fixed.keys())
      this.fixedDaySignature = signature
    }
    const stale = this.seasonalPending.values().next().value
    if (stale) {
      this.seasonalPending.delete(stale)
      const had = this.fixed.has(stale)
      this.fixed.get(stale)?.destroy(true)
      this.fixed.delete(stale)
      if (had && this.plan?.attach.includes(stale)) {
        const { cx, cy } = parseChunkKey(stale)
        const fp = footprintAt(cx, cy)
        if (fp && !this.failedGround.has(fp.place.id)) {
          this.attachFixed(fp, cx, cy)
        }
      }
    }
    const hero = this.deps.hero()
    const at = chunkOfPixel(hero.x, hero.y)
    // Nothing to place a window on until the Wilds have been read once (the
    // entities say so on screen, and try again).
    if (!wildsFrontier()) return
    if (crossed(this.plan?.center ?? null, at)) this.recentre(at.cx, at.cy)
    else this.dropBehind()
    const view = wildsView()
    if (view && view.version !== this.lastVersion) {
      this.lastVersion = view.version
      this.refreshChanged()
    }
    this.step()
    this.buildSome()
    this.seenTimer -= dt
    if (this.seenTimer <= 0) {
      this.seenTimer = 0.5
      this.noteSeen()
    }
  }

  /**
   * Build attached chunks for a few milliseconds (their ground and
   * collision are in already), in the order they were attached: the order
   * their pieces were always drawn in, so pieces of equal depth that overlap
   * across an edge keep which is on top.
   */
  private buildSome(): void {
    perfTime('build:slice', () => this.builds.step(performance.now() + BUILD_MS))
  }

  /** Whether a chunk out of the 3×3 is still kept (the hero is less than SLACK_TILES past the edge it left by). */
  private kept(key: string): boolean {
    if (perfWithout('slack')) return false
    const hero = this.deps.hero()
    const { cx, cy } = parseChunkKey(key)
    return keepAttached(cx, cy, Math.floor(hero.x / TILE), Math.floor(hero.y / TILE), SLACK_TILES)
  }

  /** The chunks kept past the 3×3 go once the hero is far enough past the edge (checked when the hero's tile changes). */
  private dropBehind(): void {
    const plan = this.plan
    if (!plan) return
    const hero = this.deps.hero()
    const tile = `${Math.floor(hero.x / TILE)},${Math.floor(hero.y / TILE)}`
    if (tile === this.heroTile) return
    this.heroTile = tile
    for (const [key, c] of this.attached) if (!plan.attach.includes(key) && !this.kept(key)) {
      c.destroy()
      this.attached.delete(key)
      this.dropPaint(key)
      this.drops++
      // A row can take a long frame to tear down on phones. Drain one
      // chunk per frame, even when the hero has stopped on this tile.
      this.heroTile = ''
      return
    }
    for (const [key, c] of this.fixed) if (!plan.attach.includes(key) && !this.kept(key)) {
      c.destroy()
      this.fixed.delete(key)
      this.drops++
      // A row can take a long frame to tear down on phones. Drain one
      // chunk per frame, even when the hero has stopped on this tile.
      this.heroTile = ''
      return
    }
    for (const [key, d] of this.drifts) if (!plan.drift.includes(key) && !this.kept(key)) {
      d.destroy()
      this.drifts.delete(key)
      this.dropPaint(key)
      this.heroTile = ''
      return
    }
  }

  /** A drained chunk no longer needs its texture unless it is still in the fetched ring. */
  private dropPaint(key: string): void {
    const p = this.paints.get(key)
    if (!p || this.plan?.fetch.includes(key) || this.plan?.drift.includes(key)) return
    if (this.deps.scene.textures.exists(p.key)) this.deps.scene.textures.remove(p.key)
    this.paints.delete(key)
  }

  /** Resolves once every chunk of the 3×3 inside the frontier is attached (the scene's first frame waits for it). */
  ready(): Promise<void> {
    const attached = this.isReady() ? Promise.resolve() : new Promise<void>((resolve) => this.waiters.push(resolve))
    // A fixed footprint's ground transitions are painted off the thread (a first visit).
    return attached.then(() => Promise.all([...this.fixedGround.values()].map((g) => g.pending)).then(() => undefined))
  }

  private isReady(): boolean {
    return !!this.plan && this.plan.attach.every((k) => {
      const { cx, cy } = parseChunkKey(k)
      return this.attached.has(k) || this.fixed.has(k) || (fixedPlaceOf(cx, cy) ? !footprintAt(cx, cy) : !chunkTerrain(cx, cy))
    })
  }

  /** Paint everything the window needs now, in one go (the first build, behind the scene's fade). */
  settle(): void {
    this.now = true
    try {
      for (let i = 0; i < 64 && this.step(); i++) {
        /* each step paints or attaches one chunk */
      }
    } finally {
      this.now = false
    }
  }

  private recentre(cx: number, cy: number): void {
    perfTime('recentre', () => this.recentreNow(cx, cy))
  }

  private recentreNow(cx: number, cy: number): void {
    const plan = planWindow(cx, cy, onWindow)
    this.plan = plan
    const session = this.deps.session
    const wick = wildsEpoch('wick').id
    if (insideNamedFrontier(cx, cy) && wick) markWalked(wick, chunkKey(cx, cy))
    // The new chunk's near read (reused within 10 s), then the ring's bodies.
    void refreshNear(session, cx, cy, NEAR_MAX_AGE_MS)
    for (const key of plan.fetch) this.load(key)
    // The far side goes: chunks out of the 3×3 (once past the slack), drift
    // out of it, landmarks out of the ring.
    this.heroTile = ''
    this.dropBehind()
    const keepFar = new Set(plan.ring)
    for (const [key, imgs] of this.far) if (!keepFar.has(key)) {
      destroyAll(this.deps.scene, imgs)
      this.far.delete(key)
    }
    // Textures of chunks well out of reach are let go.
    const keepPaint = new Set([...plan.fetch, ...plan.drift, ...this.attached.keys(), ...this.drifts.keys()])
    for (const [key, p] of this.paints) if (!keepPaint.has(key)) {
      if (this.deps.scene.textures.exists(p.key)) this.deps.scene.textures.remove(p.key)
      this.paints.delete(key)
    }
  }

  private load(key: string): void {
    const { cx, cy } = parseChunkKey(key)
    if (fixedPlaceOf(cx, cy)) {
      if (footprintAt(cx, cy) || this.loading.has(key) || Date.now() < (this.retryAt.get(key) ?? 0)) return
      this.loading.add(key)
      void Promise.resolve(prepareFixed(this.deps.session)).finally(() => {
        if (!footprintAt(cx, cy)) this.retryAt.set(key, Date.now() + 5000)
        this.loading.delete(key)
      })
      return
    }
    if (chunkTerrain(cx, cy) || this.loading.has(key) || Date.now() < (this.retryAt.get(key) ?? 0)) return
    this.loading.add(key)
    const fetched = perfSpan('fetch', true)
    void loadWildsChunk(this.deps.session, cx, cy)
      .then((t) => {
        if (!t) this.retryAt.set(key, Date.now() + 5000)
      })
      .catch(() => this.retryAt.set(key, Date.now() + 5000))
      .finally(() => {
        fetched()
        this.loading.delete(key)
      })
  }

  /**
   * One unit of work, nearest first: paint a 3×3 chunk whose neighbours are
   * known, attach a painted one, paint a drift chunk, draw a ring chunk's
   * landmarks. False when there was nothing to do.
   */
  private step(): boolean {
    const plan = this.plan
    if (!plan) return false
    const known = (cx: number, cy: number) => fixedPlaceOf(cx, cy) !== null || !!chunkTerrain(cx, cy)
    for (const key of plan.attach) {
      const { cx, cy } = parseChunkKey(key)
      if (fixedPlaceOf(cx, cy)) {
        if (this.fixed.has(key) || this.failedGround.has(fixedPlaceOf(cx, cy)!.id)) continue
        let fp = footprintAt(cx, cy)
        if (!fp) {
          this.load(key)
          continue
        }
        this.attachFixed(fp, cx, cy)
        return true
      }
      const had = this.attached.get(key)
      if (had) {
        // Patched in place (./window-chunk.ts patch): its ground is repainted off the frame.
        const p = this.paints.get(key)
        if (!p || p.sig === had.sig || this.pending.get(key) === had.sig || !paintable(cx, cy, insideNamedFrontier, known)) continue
        this.paint(key, had.sig)
        return true
      }
      const t = effectiveChunk(cx, cy)
      if (!t) {
        this.load(key)
        continue
      }
      const sig = this.sigOf(cx, cy)
      const p = this.paints.get(key)
      if (!p || p.sig !== sig) {
        if ((!this.now && this.pending.get(key) === sig) || !paintable(cx, cy, insideNamedFrontier, known)) continue
        this.paint(key, sig)
        return true
      }
      this.attach(key)
      return true
    }
    if (this.isReady()) this.release()
    for (const key of plan.drift) {
      if (this.drifts.has(key)) continue
      const view = wildsView()
      const f = wildsFrontier()
      if (!view || !f) break
      const { cx, cy } = parseChunkKey(key)
      const glimpse = view.glimpse.get(key) ?? null
      const sig = `drift|${view.wick.id}|${glimpse?.land ?? ''}|${glimpse?.river ?? ''}`
      let p = this.paints.get(key)
      if (!p || p.sig !== sig) {
        const painted = paintDriftChunk(this.deps.scene, cx, cy, glimpse, seasonMark(view.wick.season), (wx, wy) => gridDistance(f, wx, wy), view.wick.worldSeed, `wilds-drift:${key}`)
        this.logPaint(key, painted.ms, true)
        p = { key: painted.key, sig }
        this.paints.set(key, p)
      }
      this.drifts.set(key, perfTime('drift', () => new DriftChunk(this.deps.scene, cx, cy, p.key, veilEdges(cx, cy, onWindow), this.deps.reducedMotion)))
      return true
    }
    for (const key of plan.ring) {
      if (this.far.has(key) || this.attached.has(key)) continue
      const { cx, cy } = parseChunkKey(key)
      if (fixedPlaceOf(cx, cy)) continue
      const t = chunkTerrain(cx, cy)
      if (!t) continue
      const { scene } = this.deps
      this.far.set(key, perfTime('landmarks', () => {
        const imgs = chunkLandmarks(t, (k) => scene.textures.exists(k)).map((s) => looseImage(scene, s.x, s.y, s.key).setOrigin(0.5, 1).setFlipX(s.flipX ?? false).setDepth(s.y).setData('place', s.place).setData('at', { tx: s.tx, ty: s.ty }))
        addAll(scene, imgs)
        return imgs
      }))
      return true
    }
    return false
  }

  private sigOf(cx: number, cy: number): string {
    const t = chunkTerrain(cx, cy)
    return `${t?.epochId ?? ''}|${chunkSig(cx, cy)}`
  }

  /**
   * Paint a chunk's ground: off the main thread while walking (the result
   * lands a frame or so later), here and now for the first window.
   */
  private paint(key: string, sig: string): void {
    const { cx, cy } = parseChunkKey(key)
    const t = effectiveChunk(cx, cy)!
    const o = chunkOrigin(t)
    const job: PaintJob = { x0: o.tx * TILE, y0: o.ty * TILE, w: t.size * TILE, h: t.size * TILE, look: t.look, mark: t.mark, seed: fnv1a32(wildsEpoch('still').worldSeed || wildsEpoch('wick').worldSeed), table: groundTable() }
    const src = { ground: groundAt, solid: solidAt }
    if (this.now) {
      // A worker's paint of the same chunk, still in flight, is dropped when it lands.
      this.pending.delete(key)
      const r = paintHere(job, src)
      this.painted(key, sig, r.rgba, r.ms, r.thread)
      return
    }
    this.pending.set(key, sig)
    void paintAway(job, src).then((r) => {
      if (this.pending.get(key) !== sig) return
      this.pending.delete(key)
      // Still wanted, and painted from the chunk as it is now.
      if (this.gone || !this.plan?.fetch.includes(key) || this.sigOf(cx, cy) !== sig) return
      this.painted(key, sig, r.rgba, r.ms, r.thread)
    })
  }

  /** A painted ground lands: its texture, and the chunk (re)attached on it if it is in the 3×3. */
  private painted(key: string, sig: string, rgba: Uint8ClampedArray, ms: number, thread: 'worker' | 'main'): void {
    perfTime('paint-landed', () => this.paintedNow(key, sig, rgba, ms, thread))
  }

  private paintedNow(key: string, sig: string, rgba: Uint8ClampedArray, ms: number, thread: 'worker' | 'main'): void {
    const old = this.paints.get(key)
    const texture = groundTexture(this.deps.scene, `wilds-ground:${key}:${old && old.key.endsWith(':a') ? 'b' : 'a'}`, rgba)
    this.logPaint(key, ms, false, thread)
    this.paints.set(key, { key: texture, sig })
    // A chunk patched in place takes its new image; one whose ground moved
    // otherwise is rebuilt on it; a chunk of the 3×3 waiting for its image
    // is attached now.
    const had = this.attached.get(key)
    if (had && had.sig === sig) had.setGround(texture)
    else {
      if (had) {
        had.destroy()
        this.attached.delete(key)
      }
      if (had || this.plan?.attach.includes(key)) this.attach(key)
    }
    if (this.isReady()) this.release()
    if (old && old.key !== texture && this.deps.scene.textures.exists(old.key)) this.deps.scene.textures.remove(old.key)
  }

  private attach(key: string): void {
    perfTime('attach:generated', () => this.attachNow(key))
  }

  private attachNow(key: string): void {
    const { cx, cy } = parseChunkKey(key)
    const t = effectiveChunk(cx, cy)
    const p = this.paints.get(key)
    if (!t || !p) return
    const far = this.far.get(key)
    if (far) {
      destroyAll(this.deps.scene, far)
      this.far.delete(key)
    }
    const c = new AttachedChunk({ ...this.deps, ground: { ground: groundAt, solid: solidAt }, gather: (c) => chunkGather(c, calendarAt(gameNow())), builds: this.builds }, t, p.key)
    c.sig = p.sig
    this.attached.set(key, c)
    this.attaches++
    // The first window (behind the fade) is built whole at once.
    if (this.now || perfWithout('spread')) this.builds.finish(c)
  }

  /** Attach a fixed chunk: its ground laid from its footprint's painted tileset (painted on first use). */
  private attachFixed(fp: FixedFootprint, cx: number, cy: number): void {
    perfTime('attach:fixed', () => {
      const { scene, session } = this.deps
      const gate = lotAt(cx, cy)
      if (gate !== null) {
        applyLotHome(gate, homesteadsFor(this.deps.session).homes.get(gate) ?? null)
        fp = footprintAt(cx,cy)!
      }
      const ground = this.groundFor(fp)
      if (!ground) return
      const c = new FixedChunk(
        {
          scene,
          solids: this.deps.solids,
          tileArt: this.deps.tileArt,
          gathering: this.deps.gathering,
          occluders: this.deps.occluders,
          interactables: this.deps.interactables,
          reducedMotion: this.deps.reducedMotion,
          enter: this.deps.enter,
          hooks: this.deps.hooks,
          ground,
          day: () => {
            const cal = calendarAt(gameNow())
            return { festival: cal.festival, wick: cal.wick, mark: cal.mark }
          },
          light: (lamps) => refreshLanternVisuals(scene, lamps, session.questStage, session.state),
          builds: this.builds
        },
        fp,
        cx,
        cy
      )
      this.fixed.set(c.key, c)
      this.attaches++
      if (this.now || perfWithout('spread')) this.builds.finish(c)
    })
  }

  /** Mutable home overlays rebuild through the same window budget, without a scene restart. */
  refreshFixed(key: string): void { if (this.fixed.has(key)) this.seasonalPending.add(key) }

  /** Late layers join pending/built chunks through their existing budgeted job. */
  fixturesReady(): void {
    for (const c of this.fixed.values()) c.fixturesReady()
  }

  /** Fixed ground and collision are attached, even if its drawing is still building. */
  hasFixed(cx: number, cy: number): boolean {
    return this.fixed.has(chunkKey(cx, cy))
  }

  /** The fixed chunks attached now. */
  fixedKeys(): string[] {
    return [...this.fixed.keys()]
  }

  /** A footprint's painted ground (painted, or taken from the paint cache, on first use in this scene). */
  private groundFor(fp: FixedFootprint): GroundTiles | null {
    const had = this.fixedGround.get(fp.place.id)
    if (had) return had
    if (this.failedGround.has(fp.place.id)) return null
    const g = groundTiles(this.deps.scene, { areaId: fp.place.id, ...(fp.place.id === 'homestead-lots' ? { groundStyle: 'tangle' as const, groundMark: null } : {}), ground: fp.ground, width: fp.w, height: fp.h, scenery: [...fp.objects.values()].flat().flatMap((o) => {
      const s = sceneryOf(o)
      if (!s?.groundUnder) return []
      return [{ ...s, groundUnder: { ...s.groundUnder, tx: s.groundUnder.tx - fp.tx, ty: s.groundUnder.ty - fp.ty } }]
    }) }, true)
    if (g) {
      this.fixedGround.set(fp.place.id, g)
      this.prewarm(fp)
    } else {
      this.failedGround.add(fp.place.id)
      console.error(`Could not build fixed ground: ${fp.place.id}`)
    }
    return g
  }

  /** Pre-warm a footprint's code-drawn textures: at once behind the fade, or spread across the hold. */
  private prewarm(fp: FixedFootprint): void {
    if (this.now || !this.builds || perfWithout('spread')) {
      perfTime('fixed-art', () => prewarmFixedArt(this.deps.scene, fp))
      return
    }
    const keys = fixedArtKeys(fp)
    let repairs = false
    this.builds.add({
      build: (deadline) =>
        perfTime('fixed-art', () => {
          if (!repairs) {
            generateRepairArt(this.deps.scene)
            repairs = true
          }
          while (keys.length && performance.now() < deadline) ensureSceneryArt(this.deps.scene, keys.shift()!)
          return !keys.length
        })
    })
  }

  /** The ways out of the attached fixed chunks, in world tiles (the scene checks them as the hero walks). */
  exits(): ExitDef[] {
    const out: ExitDef[] = []
    for (const c of this.fixed.values()) out.push(...c.exits)
    return out
  }

  /**
   * Chunks whose ground changes moved (a path laid, a thicket cleared) are
   * patched in place and repainted off the frame; a chunk whose epoch moved,
   * or whose change can't be patched, is built again.
   */
  private refreshChanged(): void {
    for (const [key, c] of this.attached) {
      const { cx, cy } = parseChunkKey(key)
      const sig = this.sigOf(cx, cy)
      if (c.sig === sig) continue
      const t = effectiveChunk(cx, cy)
      const sameEpoch = !!t && t.epochId === c.terrain.epochId
      // A tile changed on the edge: the chunk across it redraws its own edge tile's art.
      const beyond = (tx: number, ty: number) => this.attached.get(chunkKey(Math.floor(tx / CHUNK_TILES), Math.floor(ty / CHUNK_TILES)))?.relay(tx, ty)
      if (sameEpoch && c.patch(t, beyond)) {
        c.sig = sig
        continue
      }
      this.paints.delete(key)
      c.destroy()
      this.attached.delete(key)
    }
  }

  private release(): void {
    const waiting = this.waiters
    this.waiters = []
    for (const w of waiting) w()
  }

  private logPaint(chunk: string, ms: number, drift: boolean, thread: 'worker' | 'main' = 'main'): void {
    this.paintLog.push({ chunk, ms: Math.round(ms * 100) / 100, drift, thread })
    if (this.paintLog.length > PAINT_LOG_MAX) this.paintLog.shift()
  }

  /** Landmarks on screen count as seen (kept on the device per wick, for the world map). */
  private noteSeen(): void {
    const wick = wildsEpoch('wick').id
    if (!wick) return
    const view = this.deps.scene.cameras.main.worldView
    for (const imgs of this.far.values())
      for (const img of imgs) {
        const place = img.getData('place') as string | null
        if (place && view.contains(img.x, img.y - img.displayHeight / 2)) markSeen(wick, place, img.getData('at') as { tx: number; ty: number })
      }
    for (const c of this.attached.values())
      for (const p of c.terrain.places) {
        const x = (c.terrain.cx * c.terrain.size + p.tx) * 16 + 8
        const y = (c.terrain.cy * c.terrain.size + p.ty) * 16
        if (view.contains(x, y)) markSeen(wick, p.id, { tx: c.terrain.cx * c.terrain.size + p.tx, ty: c.terrain.cy * c.terrain.size + p.ty })
      }
  }

  // ------------------------------------------------------------ the scene's hooks

  /** A worked piece leaves open ground (gathering): the attached chunk opens the tile. */
  clearSolid(tx: number, ty: number): void {
    const key = chunkKey(Math.floor(tx / 24), Math.floor(ty / 24))
    this.attached.get(key)?.clearSolid(tx, ty)
  }

  /** Drop everything and build the window again (the turning: the land changed under you). */
  reload(): void {
    for (const c of this.attached.values()) c.destroy()
    for (const c of this.fixed.values()) c.destroy()
    this.fixed.clear()
    for (const d of this.drifts.values()) d.destroy()
    for (const imgs of this.far.values()) destroyAll(this.deps.scene, imgs)
    for (const p of this.paints.values()) if (this.deps.scene.textures.exists(p.key)) this.deps.scene.textures.remove(p.key)
    this.attached.clear()
    this.drifts.clear()
    this.far.clear()
    this.paints.clear()
    this.plan = null
    this.lastVersion = -1
    this.pending.clear()
    forgetGround()
  }

  /** Read-only, for playtests: what the window holds and how painting went. */
  debug(): { id: string; center: { cx: number; cy: number } | null; attached: string[]; fixed: string[]; building: string[]; ready: boolean; attaches: number; drops: number; outer: string[]; drift: string[]; ring: string[]; far: string[]; painted: string[]; paints: { chunk: string; ms: number; drift: boolean; thread: 'worker' | 'main' }[] } {
    const building = [...this.attached, ...this.fixed].filter(([, c]) => !c.whole).map(([k]) => k)
    return {
      id: this.id,
      center: this.plan?.center ?? null,
      attached: [...this.attached.keys(), ...this.fixed.keys()],
      fixed: [...this.fixed.keys()],
      building,
      // Every chunk of the 3×3 inside the frontier attached, and built whole.
      ready: this.isReady() && !building.length,
      attaches: this.attaches,
      drops: this.drops,
      // Attached chunks in the deep drift's look (the Whitequiet and beyond: its motes drift there).
      outer: [...this.attached].filter(([, c]) => c.terrain.look === 'outer').map(([k]) => k),
      drift: [...this.drifts.keys()],
      ring: this.plan?.ring ?? [],
      far: [...this.far.keys()],
      painted: [...this.paints.keys()],
      paints: [...this.paintLog],
    }
  }

  private destroy(): void {
    if (this.gone) return
    this.gone = true
    bus.off(EV.fixedReady, this.onFixedReady)
    this.release()
    for (const c of this.attached.values()) c.destroy()
    for (const c of this.fixed.values()) c.destroy()
    for (const c of this.drifts.values()) c.destroy()
    for (const g of this.fixedGround.values()) g.map.destroy()
    this.fixedGround.clear()
    this.fixed.clear()
    for (const p of this.paints.values()) if (this.deps.scene.textures.exists(p.key)) this.deps.scene.textures.remove(p.key)
    this.attached.clear()
    this.drifts.clear()
    this.far.clear()
    this.paints.clear()
  }
}
