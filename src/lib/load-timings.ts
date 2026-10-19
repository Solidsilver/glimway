/**
 * How long each stage of entering the world took, for the last few loads:
 * from Continue (or a world move) to the first drawn frame. Each stage is a
 * `performance.mark` and `measure` (`glimway:load:<stage>`), so a browser's
 * performance panel shows them too; the records live in a small ring
 * buffer, kept in localStorage so a load that had to be abandoned can still
 * be read after a reload. The Menu copies them as plain text for a chat
 * (`formatTimings`), and the dev panel lists them.
 *
 * Pure apart from the `performance` and storage it is given: node tests
 * drive it with fakes.
 */

/** One load: what it was, each stage's time, and how it ended. */
export interface LoadRecord {
  kind: string
  /** Wall clock at the start (ms since the epoch). */
  at: number
  stages: { stage: string; ms: number }[]
  totalMs: number
  /** Still going; or shown (the world drew), retried, back to the title, failed, cancelled. */
  outcome: 'running' | 'shown' | 'retry' | 'title' | 'failed' | 'cancelled'
  /** Facts noted along the way (the art density, the renderer, the art's cache). */
  notes: Record<string, string>
}

export interface PerfLike {
  now(): number
  mark?(name: string): unknown
  measure?(name: string, start?: string, end?: string): unknown
}

export interface StoreLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

/** Loads kept. */
export const TIMINGS_KEPT = 6
const STORAGE_KEY = 'glimway:load-timings'

export class LoadTimings {
  private readonly perf: PerfLike
  private readonly storage: StoreLike | null
  private readonly wall: () => number
  private list: LoadRecord[]
  private current: { record: LoadRecord; stage: string | null; since: number; start: number } | null = null

  constructor(opts: { perf: PerfLike; storage?: StoreLike | null; wall?: () => number }) {
    this.perf = opts.perf
    this.storage = opts.storage ?? null
    this.wall = opts.wall ?? (() => Date.now())
    this.list = readStored(this.storage)
  }

  /** Newest first. */
  get records(): readonly LoadRecord[] {
    return this.list
  }

  /** A new load starts (one still running ends as cancelled). */
  start(kind: string): void {
    if (this.current) this.finish('cancelled')
    const t = this.perf.now()
    const record: LoadRecord = { kind, at: this.wall(), stages: [], totalMs: 0, outcome: 'running', notes: {} }
    this.current = { record, stage: null, since: t, start: t }
    this.list = [record, ...this.list].slice(0, TIMINGS_KEPT)
    this.mark('start')
  }

  /** The load moves on to `stage`: the one before is measured. */
  stage(stage: string): void {
    const c = this.current
    if (!c || c.stage === stage) return
    this.close(c)
    c.stage = stage
    c.since = this.perf.now()
    this.mark(stage)
  }

  /** A fact about this load (the latest value of a key wins). */
  note(key: string, value: string): void {
    if (this.current) this.current.record.notes[key] = value
  }

  /** The load ended. */
  finish(outcome: Exclude<LoadRecord['outcome'], 'running'>): void {
    const c = this.current
    if (!c) return
    this.close(c)
    c.record.totalMs = Math.round(this.perf.now() - c.start)
    c.record.outcome = outcome
    this.current = null
    this.mark(`end:${outcome}`)
    this.save()
  }

  get running(): boolean {
    return this.current !== null
  }

  private close(c: NonNullable<LoadTimings['current']>): void {
    if (c.stage === null) return
    const ms = Math.round(this.perf.now() - c.since)
    c.record.stages.push({ stage: c.stage, ms })
    try {
      this.perf.measure?.(`glimway:load:${c.stage}`, `glimway:load:mark:${c.stage}`)
    } catch {
      /* a mark the browser dropped: the record still has it */
    }
  }

  private mark(name: string): void {
    try {
      this.perf.mark?.(`glimway:load:mark:${name}`)
    } catch {
      /* marks are a bonus */
    }
  }

  private save(): void {
    try {
      this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.list.filter((r) => r.outcome !== 'running')))
    } catch {
      /* storage full or blocked: the page keeps them */
    }
  }
}

function readStored(storage: StoreLike | null): LoadRecord[] {
  try {
    const raw = storage?.getItem(STORAGE_KEY)
    const list = raw ? (JSON.parse(raw) as LoadRecord[]) : []
    return Array.isArray(list) ? list.filter((r) => r && Array.isArray(r.stages)).slice(0, TIMINGS_KEPT) : []
  } catch {
    return []
  }
}

/** What a resource timing entry says about where a file came from (the fields `PerformanceResourceTiming` has). */
export interface ResourceLike {
  name: string
  startTime: number
  transferSize?: number
  encodedBodySize?: number
}

/**
 * Where the art came from: the memory or disk cache with no request, checked
 * with the server and kept (a 304), or downloaded. From `transferSize`
 * (bytes over the wire, headers included): 0 is the cache; less than the
 * body is a revalidation; otherwise a download. A browser that doesn't
 * report sizes says so.
 */
export function artCacheSummary(entries: readonly ResourceLike[]): string {
  if (!entries.length) return 'no art requests seen'
  const sized = entries.filter((e) => typeof e.transferSize === 'number' && typeof e.encodedBodySize === 'number' && (e.transferSize > 0 || e.encodedBodySize > 0))
  if (!sized.length) return `${entries.length} files, cache unknown (this browser doesn't report transfer sizes)`
  let cached = 0
  let checked = 0
  let downloaded = 0
  let wire = 0
  for (const e of sized) {
    const t = e.transferSize!
    wire += t
    if (t === 0) cached++
    else if (t < e.encodedBodySize!) checked++
    else downloaded++
  }
  const unknown = entries.length - sized.length
  return `${entries.length} files: ${cached} from cache, ${checked} checked with the server (304), ${downloaded} downloaded${unknown ? `, ${unknown} unknown` : ''}; ${(wire / 1_000_000).toFixed(1)} MB over the wire`
}

/** A short device line from the user agent: "iPhone, iOS 18.1, installed app". */
export function deviceLine(ua: string, standalone: boolean): string {
  const ios = /\((iPhone|iPad|iPod)[^)]*OS (\d+)[._](\d+)/.exec(ua)
  const android = /Android (\d+(?:\.\d+)?)/.exec(ua)
  const browser = /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : ''
  const os = ios ? `${ios[1]}, iOS ${ios[2]}.${ios[3]}` : android ? `Android ${android[1]}` : /Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'unknown device'
  return [os, browser, standalone ? 'installed app' : 'browser tab'].filter(Boolean).join(', ')
}

const pad = (s: string, n: number) => s + ' '.repeat(Math.max(1, n - s.length))
const num = (ms: number) => `${ms.toLocaleString('en-US')} ms`

/**
 * The loads as plain text, newest first, for pasting into a chat: one line
 * per stage with its time, then the facts noted, then the device.
 */
export function formatTimings(records: readonly LoadRecord[], env: { device: string; viewport: string; version: string }): string {
  const lines = [`Glimway load timings · ${env.version}`, `device: ${env.device}`, `viewport: ${env.viewport}`]
  if (!records.length) lines.push('', 'No loads recorded yet.')
  for (const r of records) {
    const when = new Date(r.at).toISOString().replace('T', ' ').slice(0, 19)
    lines.push('', `${when} UTC · ${r.kind} · ${r.outcome === 'running' ? 'still loading' : `${num(r.totalMs)} · ${r.outcome}`}`)
    for (const s of r.stages) lines.push(`  ${pad(s.stage, 9)}${num(s.ms)}`)
    for (const [k, v] of Object.entries(r.notes)) lines.push(`  ${k}: ${v}`)
  }
  return lines.join('\n')
}
