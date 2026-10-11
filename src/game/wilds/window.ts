/**
 * The open map's moving window (docs/design/open-map.md 2.5, 2.6, 2.10):
 * one Wilds scene, no restart between chunks.
 *
 * The scene keeps the 3×3 chunks around the hero attached (ground,
 * collision, scenery, workable pieces, entities, sites) and the ring around
 * that fetched and decoded. Crossing into another chunk recentres the
 * window: a near read for the new chunk (at most every 10 s a chunk), the
 * new ring's bodies fetched, the new row painted and attached, the far row
 * dropped. Painting is one chunk a frame, before the chunk is attached
 * (a chunk is painted once its neighbours are known, so its image joins
 * theirs). Chunks past the frontier in the 3×3 are the drift. Landmarks of
 * the fetched ring are drawn too, sprite only, so you steer by them from a
 * chunk away; one counts as seen once it is on screen.
 *
 * The window also repaints a chunk whose ground changes moved (someone laid
 * stone), and reloads everything at the turning (./world-turning.ts).
 */
import type Phaser from 'phaser'
import { calendarAt } from '../../lib/calendar.ts'
import { seasonMark } from '../../lib/wilds/outer.ts'
import { gameNow } from '../clock.ts'
import type { Session } from '../session.ts'
import { chunkKey, chunkOfPixel, parseChunkKey } from './coords.ts'
import { chunkSig, effectiveChunk, forgetGround, groundAt, solidAt } from './ground-view.ts'
import { chunkGather, chunkLandmarks } from './terrain.ts'
import { crossed, paintable, planWindow, veilEdges, type WindowPlan } from './window-plan.ts'
import { AttachedChunk, DriftChunk, groundTexture, paintDriftChunk, type ChunkDeps } from './window-chunk.ts'
import { paintAway, paintHere, type PaintJob } from './paint-worker.ts'
import { groundTable } from './ground-table.ts'
import { chunkOrigin } from './terrain.ts'
import { fnv1a32 } from '../../lib/hash.ts'
import { TILE } from '../../lib/tile.ts'
import { chunkTerrain, insideNamedFrontier, loadWildsChunk, NEAR_MAX_AGE_MS, refreshNear, wildsEpoch, wildsFrontier, wildsView } from './store.ts'
import { markSeen, markWalked } from './walked.ts'

export interface WindowDeps extends Omit<ChunkDeps, 'ground' | 'gather'> {
  session: Session
  hero: () => { x: number; y: number }
}

/** A painted chunk texture and what it was painted from. */
interface PaintedChunk {
  key: string
  /** epoch, look and changes: a different one repaints. */
  sig: string
}

/** Paint timings (ms), newest last, for the playtest hooks and the budget report. */
const PAINT_LOG_MAX = 64

export class WildsWindow {
  private plan: WindowPlan | null = null
  private attached = new Map<string, AttachedChunk>()
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
  private seenTimer = 0
  private readonly paintLog: { chunk: string; ms: number; drift: boolean; thread: 'worker' | 'main' }[] = []
  private waiters: (() => void)[] = []
  private gone = false
  /** This window's identity (a playtest sees it never changes while walking: no scene restart). */
  private readonly id = Math.random().toString(36).slice(2, 10)

  constructor(private deps: WindowDeps) {
    deps.scene.events.once('shutdown', () => this.destroy())
  }

  // ------------------------------------------------------------ per frame

  update(dt: number): void {
    if (this.gone) return
    const hero = this.deps.hero()
    const at = chunkOfPixel(hero.x, hero.y)
    // Nothing to place a window on until the Wilds have been read once (the
    // entities say so on screen, and try again).
    if (!wildsFrontier()) return
    if (crossed(this.plan?.center ?? null, at)) this.recentre(at.cx, at.cy)
    const view = wildsView()
    if (view && view.version !== this.lastVersion) {
      this.lastVersion = view.version
      this.refreshChanged()
    }
    this.step()
    this.seenTimer -= dt
    if (this.seenTimer <= 0) {
      this.seenTimer = 0.5
      this.noteSeen()
    }
  }

  /** Resolves once every chunk of the 3×3 inside the frontier is attached (the scene's first frame waits for it). */
  ready(): Promise<void> {
    if (this.isReady()) return Promise.resolve()
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  private isReady(): boolean {
    return !!this.plan && this.plan.attach.every((k) => this.attached.has(k) || !chunkTerrain(parseChunkKey(k).cx, parseChunkKey(k).cy))
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
    const plan = planWindow(cx, cy, insideNamedFrontier)
    this.plan = plan
    const session = this.deps.session
    const wick = wildsEpoch('wick').id
    if (insideNamedFrontier(cx, cy) && wick) markWalked(wick, chunkKey(cx, cy))
    // The new chunk's near read (reused within 10 s), then the ring's bodies.
    void refreshNear(session, cx, cy, NEAR_MAX_AGE_MS)
    for (const key of plan.fetch) this.load(key)
    // The far side goes: chunks out of the 3×3, drift out of it, landmarks out of the ring.
    for (const [key, c] of this.attached) if (!plan.attach.includes(key)) {
      c.destroy()
      this.attached.delete(key)
    }
    for (const [key, d] of this.drifts) if (!plan.drift.includes(key)) {
      d.destroy()
      this.drifts.delete(key)
    }
    const keepFar = new Set(plan.ring)
    for (const [key, imgs] of this.far) if (!keepFar.has(key)) {
      for (const img of imgs) img.destroy()
      this.far.delete(key)
    }
    // Textures of chunks well out of reach are let go.
    const keepPaint = new Set([...plan.fetch, ...plan.drift])
    for (const [key, p] of this.paints) if (!keepPaint.has(key)) {
      if (this.deps.scene.textures.exists(p.key)) this.deps.scene.textures.remove(p.key)
      this.paints.delete(key)
    }
  }

  private load(key: string): void {
    const { cx, cy } = parseChunkKey(key)
    if (chunkTerrain(cx, cy) || this.loading.has(key) || Date.now() < (this.retryAt.get(key) ?? 0)) return
    this.loading.add(key)
    void loadWildsChunk(this.deps.session, cx, cy)
      .then((t) => {
        if (!t) this.retryAt.set(key, Date.now() + 5000)
      })
      .catch(() => this.retryAt.set(key, Date.now() + 5000))
      .finally(() => this.loading.delete(key))
  }

  /**
   * One unit of work, nearest first: paint a 3×3 chunk whose neighbours are
   * known, attach a painted one, paint a drift chunk, draw a ring chunk's
   * landmarks. False when there was nothing to do.
   */
  private step(): boolean {
    const plan = this.plan
    if (!plan) return false
    const known = (cx: number, cy: number) => !!chunkTerrain(cx, cy)
    for (const key of plan.attach) {
      const { cx, cy } = parseChunkKey(key)
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
        const painted = paintDriftChunk(this.deps.scene, cx, cy, glimpse, seasonMark(view.wick.season), f, view.wick.worldSeed, `wilds-drift:${key}`)
        this.logPaint(key, painted.ms, true)
        p = { key: painted.key, sig }
        this.paints.set(key, p)
      }
      this.drifts.set(key, new DriftChunk(this.deps.scene, cx, cy, p.key, veilEdges(cx, cy, insideNamedFrontier), this.deps.reducedMotion))
      return true
    }
    for (const key of plan.ring) {
      if (this.far.has(key)) continue
      const { cx, cy } = parseChunkKey(key)
      const t = chunkTerrain(cx, cy)
      if (!t) continue
      const { scene } = this.deps
      this.far.set(key, chunkLandmarks(t, (k) => scene.textures.exists(k)).map((s) => scene.add.image(s.x, s.y, s.key).setOrigin(0.5, 1).setFlipX(s.flipX ?? false).setDepth(s.y).setData('place', s.place).setData('at', { tx: s.tx, ty: s.ty })))
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
    const { cx, cy } = parseChunkKey(key)
    const t = effectiveChunk(cx, cy)
    const p = this.paints.get(key)
    if (!t || !p) return
    const far = this.far.get(key)
    if (far) {
      for (const img of far) img.destroy()
      this.far.delete(key)
    }
    const c = new AttachedChunk({ ...this.deps, ground: { ground: groundAt, solid: solidAt }, gather: (c) => chunkGather(c, calendarAt(gameNow())) }, t, p.key)
    c.sig = p.sig
    this.attached.set(key, c)
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
      if (sameEpoch && c.patch(t)) {
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

  /** Landmarks on screen count as seen (kept on the device per wick, for the Map tab). */
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
    for (const d of this.drifts.values()) d.destroy()
    for (const imgs of this.far.values()) for (const img of imgs) img.destroy()
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
  debug(): { id: string; center: { cx: number; cy: number } | null; attached: string[]; drift: string[]; ring: string[]; far: string[]; painted: string[]; paints: { chunk: string; ms: number; drift: boolean; thread: 'worker' | 'main' }[] } {
    return {
      id: this.id,
      center: this.plan?.center ?? null,
      attached: [...this.attached.keys()],
      drift: [...this.drifts.keys()],
      ring: this.plan?.ring ?? [],
      far: [...this.far.keys()],
      painted: [...this.paints.keys()],
      paints: [...this.paintLog],
    }
  }

  private destroy(): void {
    this.gone = true
    this.release()
    for (const p of this.paints.values()) if (this.deps.scene.textures.exists(p.key)) this.deps.scene.textures.remove(p.key)
    this.attached.clear()
    this.drifts.clear()
    this.far.clear()
    this.paints.clear()
  }
}
