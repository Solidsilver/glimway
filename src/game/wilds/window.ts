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
 * Fixed chunks (an authored layout's: Hearthwick and the lots,
 * location-seam.md 4) are on the grid too: the window attaches them like
 * the rest, from their footprint's served chunks (./fixed.ts), and paints
 * their ground the same way, per chunk and off the main thread
 * (./fixed-ground.ts: docs/design/hearthwick-2.md 4, 5). A fixed chunk
 * never waits for a generated neighbour: it paints with what is known and
 * paints again once its neighbours are in, so the seam blends. Its last
 * paints are kept for the page, so coming back out of a door paints nothing.
 * Only chunks on neither the frontier nor a footprint are the drift.
 *
 * The first window (behind the scene's fade) paints across a few workers at
 * once and builds each chunk whole as it attaches.
 */
import type Phaser from 'phaser'
import { refreshLanternVisuals } from '../area/lanterns.ts'
import { ensureSceneryArt } from '../area/props.ts'
import { calendarAt } from '../../lib/calendar.ts'
import { seasonMark } from '../../lib/wilds/outer.ts'
import { gameNow } from '../clock.ts'
import { bus, EV } from '../events.ts'
import { generateRepairArt } from '../repairs-art.ts'
import type { Session } from '../session.ts'
import { CHUNK_TILES, chunkKey, chunkOfPixel, parseChunkKey } from './coords.ts'
import { fixedPlaceOf, footprint, footprintAt, prepareFixed, applyLotHome, chunkOfTile, type FixedFootprint } from './fixed.ts'
import { fixedChunkHash, paintSource } from './fixed-ground.ts'
import { FixedChunk, type FixedChunkDeps } from './fixed-chunk.ts'
import type { ExitDef } from '../worlds.ts'
import { PLACES, fixedChunks } from '../../lib/places.ts'
import { chunkSig, effectiveChunk, forgetGround, groundAt, solidAt } from './ground-view.ts'
import { chunkGather, chunkLandmarks } from './terrain.ts'
import { crossed, frontierDistance, keepAttached, paintable, planWindow, SLACK_TILES, veilEdges, type WindowPlan } from './window-plan.ts'
import { AttachedChunk, BuildQueue, DriftChunk, groundTexture, paintDriftChunk, type ChunkDeps } from './window-chunk.ts'
import { lanes, paintAway, paintHere, paintsAway, type PaintJob } from './paint-worker.ts'
import { paintTable } from './ground-table.ts'
import { chunkOrigin } from './terrain.ts'
import { fnv1a32 } from '../../lib/hash.ts'
import { TILE } from '../../lib/tile.ts'
import { chunkTerrain, insideNamedFrontier, loadWildsChunk, NEAR_MAX_AGE_MS, placeKey, refreshNear, wildsEpoch, wildsFrontier, wildsView } from './store.ts'
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

/** Where a paint was made: a worker, this thread (`'late'`: after the worker's deadline), or the page's kept fixed paints. */
type PaintThread = 'worker' | 'main' | 'late' | 'cache'

/**
 * Fixed chunks' last paints, by signature, for the page: a scene built again
 * (out of a door, back from a room) lays the town without painting it. A
 * dozen chunks, about 7 MB.
 */
const keptPaints = new Map<string, Uint8ClampedArray>()
const KEPT_PAINTS = 12

function keepPaint(sig: string, rgba: Uint8ClampedArray): void {
  keptPaints.delete(sig)
  keptPaints.set(sig, rgba)
  while (keptPaints.size > KEPT_PAINTS) keptPaints.delete(keptPaints.keys().next().value!)
}

let markSeason: string | null = null
let markOfSeason: string | null = null

/** The Mark fixed ground is painted in: the wick's, as the outskirts beside it are (read every frame, worked out once a season). */
function fixedMark(): string | null {
  const season = wildsEpoch('wick').season
  if (season !== markSeason) {
    markSeason = season
    markOfSeason = seasonMark(season)
  }
  return markOfSeason
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
  /** Footprints whose code-drawn art this window has pre-warmed (or queued). */
  private prewarmed = new Set<string>()
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
  /** The first window, behind the scene's fade: chunks are built whole as they attach, and paints spread across the workers. */
  private first = false
  /** The worker lane the next first-window paint goes to. */
  private lane = 0
  private lastVersion = -1
  private fixedDaySignature = ''
  private seasonalPending = new Set<string>()
  /** The hero's tile when the window last looked at what it keeps past the 3×3. */
  private heroTile = ''
  private seenTimer = 0
  private readonly paintLog: { chunk: string; ms: number; drift: boolean; thread: PaintThread }[] = []
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
    // The fixed footprints' code-drawn textures are made a few milliseconds a
    // frame from now on, so a first walk onto fixed ground makes none. Their
    // ground is painted per chunk as it attaches, off the main thread.
    this.onFixedReady()
  }

  private readonly onFixedReady = (): void => {
    if (this.gone || !this.deps.scene?.make) return
    for (const p of PLACES.fixed) {
      const fp = footprint(p.id)
      if (fp && !this.prewarmed.has(p.id)) {
        this.prewarmed.add(p.id)
        this.prewarm(fp)
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
      // Input is event-driven and can arrive before the next scene update.
      // A refresh under the hero (or their prompt, across a chunk edge) must
      // replace its fixtures in one turn, without an empty interaction list
      // between slices. Chunks elsewhere keep their normal build budget.
      const hero = this.deps.hero()
      const target = this.deps.interactables.currentTarget
      const at = chunkOfPixel(hero.x, hero.y)
      const underfoot = chunkKey(at.cx, at.cy) === stale
      const prompted = !!target && chunkOfTile(Math.floor(target.x / TILE), Math.floor((target.y - 8) / TILE)) === stale
      const had = this.fixed.has(stale)
      this.fixed.get(stale)?.destroy(true)
      this.fixed.delete(stale)
      if (had && this.plan?.attach.includes(stale)) {
        const { cx, cy } = parseChunkKey(stale)
        const fp = footprintAt(cx, cy)
        // On its last paint; a lot whose clearing changed is painted again, off the frame.
        if (fp && this.paints.has(stale)) {
          this.attachFixed(fp, cx, cy)
          const replacement = this.fixed.get(stale)
          if (replacement && (underfoot || prompted)) this.builds.finish(replacement)
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
      this.dropPaint(key)
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
    return this.isReady() ? Promise.resolve() : new Promise<void>((resolve) => this.waiters.push(resolve))
  }

  private isReady(): boolean {
    return !!this.plan && this.plan.attach.every((k) => {
      const { cx, cy } = parseChunkKey(k)
      return this.attached.has(k) || this.fixed.has(k) || (fixedPlaceOf(cx, cy) ? !footprintAt(cx, cy) : !chunkTerrain(cx, cy))
    })
  }

  /**
   * Start everything the window needs now, in one go (the first build,
   * behind the scene's fade): the 3×3's paints go to the workers together
   * (without workers they are painted here), and each chunk is built whole
   * as it attaches, until the window is ready.
   */
  settle(): void {
    this.first = true
    this.lane = 0
    for (let i = 0; i < 64 && this.step(); i++) {
      /* each step paints or attaches one chunk */
    }
    if (this.isReady()) this.release()
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
    const keepPaint = new Set([...plan.fetch, ...plan.drift, ...this.attached.keys(), ...this.fixed.keys(), ...this.drifts.keys()])
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
    const known = (cx: number, cy: number) => this.known(cx, cy)
    for (const key of plan.attach) {
      const { cx, cy } = parseChunkKey(key)
      if (fixedPlaceOf(cx, cy)) {
        const fp = footprintAt(cx, cy)
        if (!fp) {
          this.load(key)
          continue
        }
        const sig = this.sigOf(cx, cy)
        const p = this.paints.get(key)
        const had = this.fixed.get(key)
        if (p?.sig === sig || this.pending.get(key) === sig) {
          if (had || !p) continue
          this.attachFixed(fp, cx, cy)
          return true
        }
        // Not painted yet, or painted before its neighbours (or its lot's
        // clearing) were known: painted now. Its last paint, if any, stands
        // in until the new one lands.
        if (!had && p) {
          this.attachFixed(fp, cx, cy)
          return true
        }
        // A lot is painted with its home's clearing (attaching applies the rest).
        const gate = had ? null : lotAt(cx, cy)
        if (gate !== null) applyLotHome(gate, homesteadsFor(this.deps.session).homes.get(gate) ?? null)
        this.paint(key, gate !== null ? this.sigOf(cx, cy) : sig)
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
        if (this.pending.get(key) === sig || !paintable(cx, cy, insideNamedFrontier, known)) continue
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
        const imgs = chunkLandmarks(t, (k) => scene.textures.exists(k)).map((s) => looseImage(scene, s.x, s.y, s.key).setOrigin(0.5, 1).setFlipX(s.flipX ?? false).setDepth(s.y).setData('place', s.place && placeKey(s.place, t.epochId)).setData('at', { tx: s.tx, ty: s.ty }))
        addAll(scene, imgs)
        return imgs
      }))
      return true
    }
    return false
  }

  /** Is a chunk's ground known (a fixed one once its footprint is here)? */
  private known(cx: number, cy: number): boolean {
    return fixedPlaceOf(cx, cy) ? !!footprintAt(cx, cy) : !!chunkTerrain(cx, cy)
  }

  /**
   * What a chunk's paint depends on. A generated chunk: its epoch and
   * changes. A fixed one: where it is, the world seed, its footprint's
   * revision, the Mark (fixed ground follows the year, as the outskirts do),
   * what it paints from (a lot's clearing), and each neighbour's own
   * identity (a fixed one's hash, a generated one's epoch and changes).
   */
  private sigOf(cx: number, cy: number): string {
    const fp = fixedPlaceOf(cx, cy) ? footprintAt(cx, cy) : null
    if (fp) {
      const around: string[] = []
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) {
        const nx = cx + dx, ny = cy + dy
        if (!onWindow(nx, ny)) { around.push('void'); continue }
        const neighbour = fixedPlaceOf(nx, ny) ? footprintAt(nx, ny) : null
        if (neighbour) around.push(JSON.stringify([neighbour.epoch, fixedChunkHash(neighbour, nx, ny)]))
        else {
          const terrain = chunkTerrain(nx, ny)
          around.push(terrain ? JSON.stringify([terrain.epochId, chunkSig(nx, ny)]) : '?')
        }
      }
      // Pixel noise uses the world seed and absolute coordinates; edge
      // blending reads four tiles into the neighbouring chunks.
      const seed = wildsEpoch('still').worldSeed || wildsEpoch('wick').worldSeed
      return JSON.stringify(['fixed', cx, cy, fp.epoch, seed, fixedMark(), fixedChunkHash(fp, cx, cy), around])
    }
    const t = chunkTerrain(cx, cy)
    return `${t?.epochId ?? ''}|${chunkSig(cx, cy)}`
  }

  /**
   * Paint a chunk's ground off the main thread (the result lands a frame or
   * so later; the first window's paints go to the workers together). Where
   * no worker can start, here and now. A fixed chunk painted before, with
   * the same signature, is laid from its kept paint.
   */
  private paint(key: string, sig: string): void {
    const { cx, cy } = parseChunkKey(key)
    const fixed = fixedPlaceOf(cx, cy) !== null
    const kept = fixed ? keptPaints.get(sig) : undefined
    if (kept) {
      this.pending.delete(key)
      this.painted(key, sig, kept, 0, 'cache')
      return
    }
    const seed = fnv1a32(wildsEpoch('still').worldSeed || wildsEpoch('wick').worldSeed)
    let job: PaintJob
    if (fixed) {
      job = { x0: cx * CHUNK_TILES * TILE, y0: cy * CHUNK_TILES * TILE, w: CHUNK_TILES * TILE, h: CHUNK_TILES * TILE, look: 'outer', mark: fixedMark(), seed, table: paintTable() }
    } else {
      const t = effectiveChunk(cx, cy)!
      const o = chunkOrigin(t)
      job = { x0: o.tx * TILE, y0: o.ty * TILE, w: t.size * TILE, h: t.size * TILE, look: t.look, mark: t.mark, seed, table: paintTable() }
    }
    const done = (r: { rgba: Uint8ClampedArray; ms: number; thread: PaintThread }) => {
      if (fixed) keepPaint(sig, r.rgba)
      this.painted(key, sig, r.rgba, r.ms, r.thread)
    }
    if (!paintsAway()) {
      // A worker's paint of the same chunk, still in flight, is dropped when it lands.
      this.pending.delete(key)
      done(paintHere(job, paintSource))
      return
    }
    this.pending.set(key, sig)
    const lane = this.first ? this.lane++ % lanes() : 0
    void paintAway(job, paintSource, lane).then((r) => {
      if (this.pending.get(key) !== sig) return
      this.pending.delete(key)
      // Still wanted, and painted from the chunk as it is now.
      if (this.gone || !this.plan?.fetch.includes(key) || this.sigOf(cx, cy) !== sig) return
      done(r)
    })
  }

  /** A painted ground lands: its texture, and the chunk (re)attached on it if it is in the 3×3. */
  private painted(key: string, sig: string, rgba: Uint8ClampedArray, ms: number, thread: PaintThread): void {
    perfTime('paint-landed', () => this.paintedNow(key, sig, rgba, ms, thread))
  }

  private paintedNow(key: string, sig: string, rgba: Uint8ClampedArray, ms: number, thread: PaintThread): void {
    const old = this.paints.get(key)
    const texture = groundTexture(this.deps.scene, `wilds-ground:${key}:${old && old.key.endsWith(':a') ? 'b' : 'a'}`, rgba)
    this.logPaint(key, ms, false, thread)
    this.paints.set(key, { key: texture, sig })
    const { cx, cy } = parseChunkKey(key)
    if (fixedPlaceOf(cx, cy)) {
      // An attached fixed chunk takes its new image where it stands; one of
      // the 3×3 waiting for its image is attached now.
      const fixed = this.fixed.get(key)
      const fp = footprintAt(cx, cy)
      if (fixed) {
        fixed.setGround(texture)
        fixed.sig = sig
      } else if (fp && this.plan?.attach.includes(key)) this.attachFixed(fp, cx, cy)
    } else {
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
    if (this.first || perfWithout('spread')) this.builds.finish(c)
  }

  /**
   * Attach a fixed chunk on its last paint (./fixed-chunk.ts). A lot takes
   * its home's state first (what is cleared, planted, standing); if that
   * changed its ground, the window paints it again and the image is
   * swapped in where it stands.
   */
  private attachFixed(fp: FixedFootprint, cx: number, cy: number): void {
    perfTime('attach:fixed', () => {
      const { scene, session } = this.deps
      const key = chunkKey(cx, cy)
      const painted = this.paints.get(key)
      if (!painted) return
      const gate = lotAt(cx, cy)
      if (gate !== null) {
        applyLotHome(gate, homesteadsFor(this.deps.session).homes.get(gate) ?? null)
        fp = footprintAt(cx,cy)!
      }
      const had = this.fixed.get(key)
      if (had) {
        had.destroy(true)
        this.fixed.delete(key)
      }
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
          ground: painted.key,
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
      c.sig = painted.sig
      this.fixed.set(c.key, c)
      this.attaches++
      if (this.first || perfWithout('spread')) this.builds.finish(c)
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

  /** Pre-warm a footprint's code-drawn textures, a few milliseconds a frame (at once without a build queue). */
  private prewarm(fp: FixedFootprint): void {
    if (!this.builds || perfWithout('spread')) {
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
    // The first window is in: chunks from now on are built a slice a frame.
    this.first = false
    const waiting = this.waiters
    this.waiters = []
    for (const w of waiting) w()
  }

  private logPaint(chunk: string, ms: number, drift: boolean, thread: PaintThread = 'main'): void {
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
  debug(): { id: string; center: { cx: number; cy: number } | null; attached: string[]; fixed: string[]; building: string[]; ready: boolean; attaches: number; drops: number; outer: string[]; drift: string[]; ring: string[]; far: string[]; painted: string[]; paints: { chunk: string; ms: number; drift: boolean; thread: PaintThread }[] } {
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
    this.fixed.clear()
    for (const p of this.paints.values()) if (this.deps.scene.textures.exists(p.key)) this.deps.scene.textures.remove(p.key)
    this.attached.clear()
    this.drifts.clear()
    this.far.clear()
    this.paints.clear()
  }
}
