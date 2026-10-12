/**
 * Walking-performance instruments, off unless the page is opened with
 * `?perf=1` (docs/testing.md, "Performance"). Off, every call here is a
 * no-op that allocates nothing.
 *
 * On, they keep:
 *  - named spans around the open map's window stages (recentre, fetch,
 *    paint landed, attach: collision / scenery / things / sites, detach),
 *    as User Timing measures (`fs:<stage>`), so a DevTools trace names them;
 *  - every long animation frame (the `long-animation-frame` entry, else the
 *    `longtask` one), with the stages that ran inside it;
 *  - frame-to-frame times, per phase of a walk (the walk script names the
 *    phases: new ground, the edge, the loop), as percentiles and a histogram;
 *  - the scene's display-list size, tween count and the page's DOM size,
 *    once a second, and which parts of the page add DOM nodes;
 *  - a small overlay, top right.
 *
 * `__fsPerf` (dev builds) returns all of it as JSON; scripts/perf-walk.ts
 * (the walk) reads it.
 */
import type { FightInterp, FightMeasures } from '../lib/fight-interp.ts'
import { expose } from './dev-hooks.ts'

const ON = typeof location !== 'undefined' && new URLSearchParams(location.search).get('perf') === '1'

/** Parts of the open map's window work a measurement turns off (`?perf=1&without=bulk,bake`). */
export type PerfPart = 'bulk' | 'bake' | 'slack' | 'spread'
const WITHOUT = new Set(ON ? (new URLSearchParams(location.search).get('without') ?? '').split(',') : [])

/**
 * Whether a measurement turned a part of the window's work off, to see what
 * it buys (never without ?perf=1): `bulk` (images added and removed in one
 * pass, ./area/bulk.ts), `bake` (flat decals as one blitter a chunk), `slack`
 * (chunks kept past the edge, ./wilds/window-plan.ts) and `spread` (a chunk
 * built over several frames).
 */
export function perfWithout(part: PerfPart): boolean {
  return WITHOUT.has(part)
}

const NOOP = (): void => {}
const now = (): number => performance.now()

/** One finished stage span. */
interface Span {
  name: string
  start: number
  ms: number
  /** Waited on, not worked on (a fetch): never named as a long frame's stage. */
  async: boolean
}

/** A long frame, and what of ours ran in it. */
export interface LongFrame {
  t: number
  ms: number
  /** Time the frame blocked input (long-animation-frame only; else the task's time over 50 ms). */
  blocking: number
  phase: string
  /** Our stages inside it: ms by name. */
  stages: Record<string, number>
  /** The longest script the browser named in it (long-animation-frame only). */
  script: string | null
}

export interface PerfSample {
  t: number
  phase: string
  list: number
  tweens: number
  dom: number
}

export interface PhaseFrames {
  frames: number
  p50: number
  p95: number
  p99: number
  worst: number
  over50: number
  long: number
}

export interface PerfReport {
  on: boolean
  fights: FightMeasures | null
  phase: string
  observer: 'long-animation-frame' | 'longtask' | 'none'
  phases: Record<string, PhaseFrames>
  /** Frame times overall: count per bucket (upper edge, ms). */
  histogram: Record<string, number>
  long: LongFrame[]
  /** Totals per stage: how often it ran, its time in all and its longest run. */
  stages: Record<string, { n: number; ms: number; max: number }>
  samples: PerfSample[]
  /** DOM nodes put into the page, by where (the nearest element with an id or class), most first. */
  domAdded: Record<string, number>
}

const BUCKETS = [8, 17, 20, 33, 50, 100, 250, Infinity]

interface Scene {
  children: { length: number }
  tweens: { getTweens(): unknown[] }
  sys: { isActive(): boolean }
}

class Instruments {
  fights: FightMeasures | null = null
  phase = 'start'
  observer: PerfReport['observer'] = 'none'
  private spans: Span[] = []
  private long: LongFrame[] = []
  private frames = new Map<string, number[]>()
  private histogram = BUCKETS.map(() => 0)
  private stages = new Map<string, { n: number; ms: number; max: number }>()
  private samples: PerfSample[] = []
  private scene: Scene | null = null
  private overlay: HTMLDivElement | null = null
  private lastFrame = 0
  private measures = 0
  private domAdded = new Map<string, number>()

  start(): void {
    this.observe()
    const tick = (t: number) => {
      if (this.lastFrame) this.frame(t - this.lastFrame)
      this.lastFrame = t
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    new MutationObserver((records) => {
      for (const m of records) {
        if (!m.addedNodes.length || this.overlay?.contains(m.target)) continue
        const where = describe(m.target)
        this.domAdded.set(where, (this.domAdded.get(where) ?? 0) + m.addedNodes.length)
      }
    }).observe(document.documentElement, { childList: true, subtree: true })
    setInterval(() => this.sample(), 1000)
    setInterval(() => this.draw(), 500)
  }

  private observe(): void {
    const types = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes ?? []
    const type = types.includes('long-animation-frame') ? 'long-animation-frame' : types.includes('longtask') ? 'longtask' : null
    if (!type) return
    this.observer = type
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) this.longFrame(e as PerformanceEntry & { blockingDuration?: number; scripts?: { invoker?: string; sourceFunctionName?: string; sourceURL?: string; duration: number }[] })
    }).observe({ type, buffered: true })
  }

  private longFrame(e: PerformanceEntry & { blockingDuration?: number; scripts?: { invoker?: string; sourceFunctionName?: string; sourceURL?: string; duration: number }[] }): void {
    const end = e.startTime + e.duration
    const stages: Record<string, number> = {}
    for (const s of this.spans) {
      if (s.async) continue
      const overlap = Math.min(end, s.start + s.ms) - Math.max(e.startTime, s.start)
      if (overlap > 0) stages[s.name] = round((stages[s.name] ?? 0) + overlap)
    }
    const top = [...(e.scripts ?? [])].sort((a, b) => b.duration - a.duration)[0]
    const script = top ? `${top.sourceFunctionName || top.invoker || '?'} ${(top.sourceURL ?? '').split('/').pop()?.split('?')[0] ?? ''} ${round(top.duration)}ms`.trim() : null
    this.long.push({ t: round(e.startTime), ms: round(e.duration), blocking: round(e.blockingDuration ?? Math.max(0, e.duration - 50)), phase: this.phase, stages, script })
    if (this.long.length > 2000) this.long.shift()
  }

  private frame(ms: number): void {
    let list = this.frames.get(this.phase)
    if (!list) this.frames.set(this.phase, (list = []))
    list.push(ms)
    this.histogram[BUCKETS.findIndex((b) => ms <= b)]!++
  }

  span(name: string, async = false): () => void {
    const start = now()
    return () => {
      const end = now()
      const ms = end - start
      this.spans.push({ name, start, ms, async })
      // Spans are only kept long enough to name the long frames they fall in.
      if (this.spans.length > 4000) this.spans.splice(0, 2000)
      const st = this.stages.get(name) ?? { n: 0, ms: 0, max: 0 }
      st.n++
      st.ms += ms
      st.max = Math.max(st.max, ms)
      this.stages.set(name, st)
      performance.measure(`fs:${name}`, { start, end })
      if (++this.measures > 2000) {
        performance.clearMeasures()
        this.measures = 0
      }
    }
  }

  watch(scene: Scene | null): void {
    this.scene = scene
  }

  private sample(): void {
    const s = this.scene
    const live = !!s && s.sys.isActive()
    this.samples.push({
      t: Math.round(now()),
      phase: this.phase,
      list: live ? s!.children.length : 0,
      tweens: live ? s!.tweens.getTweens().length : 0,
      dom: document.getElementsByTagName('*').length,
    })
    if (this.samples.length > 3600) this.samples.shift()
  }

  private draw(): void {
    if (!this.overlay) {
      const d = document.createElement('div')
      d.setAttribute('aria-hidden', 'true')
      d.style.cssText = 'position:fixed;top:4px;right:4px;z-index:99999;pointer-events:none;font:11px/1.3 monospace;color:#e8f0e0;background:rgba(20,16,24,.72);padding:3px 6px;border-radius:3px;white-space:pre'
      document.body.appendChild(d)
      this.overlay = d
    }
    const frames = this.frames.get(this.phase) ?? []
    const recent = frames.slice(-60)
    const last = this.long[this.long.length - 1]
    const sample = this.samples[this.samples.length - 1]
    this.overlay.textContent =
      `perf · ${this.phase}\n` +
      `frame p50 ${pct(recent, 0.5)} worst ${round(Math.max(0, ...recent))} ms\n` +
      `long ${this.long.length}${last ? ` · last ${last.ms} ms` : ''}\n` +
      `list ${sample?.list ?? '-'} · tweens ${sample?.tweens ?? '-'} · dom ${sample?.dom ?? '-'}` +
      (this.fights ? `\nfights · gap p95 ${round(this.fights.snapshotGapP95)} · delay ${round(this.fights.interpolationDelay)} ms\nhit p95 ${round(this.fights.hitConfirmationP95)} ms · refused ${round(this.fights.refusedPercent)}%\npending ${this.fights.pending} · timeout ${this.fights.timeouts} · swing refused ${this.fights.swingRefusals}` : '')
  }

  report(): PerfReport {
    const phases: Record<string, PhaseFrames> = {}
    for (const [name, list] of this.frames) {
      phases[name] = {
        frames: list.length,
        p50: pct(list, 0.5),
        p95: pct(list, 0.95),
        p99: pct(list, 0.99),
        worst: round(Math.max(0, ...list)),
        over50: list.filter((ms) => ms > 50).length,
        long: this.long.filter((l) => l.phase === name).length,
      }
    }
    const histogram: Record<string, number> = {}
    BUCKETS.forEach((b, i) => (histogram[b === Infinity ? 'more' : `<=${b}`] = this.histogram[i]!))
    const stages: PerfReport['stages'] = {}
    for (const [name, s] of this.stages) stages[name] = { n: s.n, ms: round(s.ms), max: round(s.max) }
    const domAdded = Object.fromEntries([...this.domAdded].sort((a, b) => b[1] - a[1]).slice(0, 20))
    return { fights: this.fights, on: true, phase: this.phase, observer: this.observer, phases, histogram, long: [...this.long], stages, samples: [...this.samples], domAdded }
  }

  reset(): void {
    this.long = []
    this.frames.clear()
    this.histogram = BUCKETS.map(() => 0)
    this.stages.clear()
    this.samples = []
    this.spans = []
    this.domAdded.clear()
    this.lastFrame = 0
  }
}

/** Where in the page a node went: the nearest element with an id or a class. */
function describe(node: Node): string {
  for (let n: Node | null = node; n; n = n.parentNode) {
    if (!(n instanceof Element)) continue
    if (n.id) return `#${n.id}`
    const cls = typeof n.className === 'string' ? n.className.split(' ').filter((c) => c && !c.startsWith('svelte-'))[0] : undefined
    if (cls) return `${n.tagName.toLowerCase()}.${cls}`
  }
  return node.nodeName.toLowerCase()
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}

function pct(list: readonly number[], q: number): number {
  if (!list.length) return 0
  const sorted = [...list].sort((a, b) => a - b)
  return round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!)
}

const instruments = ON ? new Instruments() : null
if (instruments) {
  instruments.start()
  expose('__fsPerf', () => instruments.report())
  expose('__fsPerfPhase', (name: string) => void (instruments.phase = name))
  expose('__fsPerfReset', () => instruments.reset())
}

/**
 * Start a named span; call what it returns when the stage is done. Off,
 * the same no-op every time. An `async` span is time waited (a fetch), not
 * worked: it is measured, but never named as a long frame's stage.
 */
export function perfSpan(name: string, async = false): () => void {
  return instruments ? instruments.span(name, async) : NOOP
}

/** Run `fn` inside a named span. */
export function perfTime<T>(name: string, fn: () => T): T {
  if (!instruments) return fn()
  const end = instruments.span(name)
  try {
    return fn()
  } finally {
    end()
  }
}

/** The scene whose display list and tweens are sampled (null: none now). */
export function perfWatch(scene: Scene | null): void {
  instruments?.watch(scene)
}

/** Latest server fight measurements, included in the overlay and __fsPerf. */
export function perfFights(source: Pick<FightInterp, 'measures'>): void { if (instruments) instruments.fights = source.measures() }
