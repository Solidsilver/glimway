/**
 * The loading screen's state (src/ui/LoadingScreen.svelte): the stage model
 * (src/lib/loading.ts) driven by the account flow (connecting), App
 * (the land reads, a restart) and the game over the bus (the art, the
 * first frame), and the load timings it keeps (src/lib/load-timings.ts)
 * for the Menu's "Copy load timings" and the dev panel.
 */
import { Loading, type LoadKind, type LoadStage, type LoadView } from '../lib/loading.ts'
import { LoadTimings, artCacheSummary, deviceLine, formatTimings, type ResourceLike } from '../lib/load-timings.ts'
import { bus, EV } from '../game/events.ts'
import { RUNNING } from '../lib/version.ts'

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null
  } catch {
    return null
  }
}

export const loadTimings = new LoadTimings({ perf: performance, storage: storage() })

class LoadingState {
  view = $state<LoadView | null>(null)
  /** When the art fetch began (performance time): its requests are the ones after. */
  private fetchFrom = 0
  private readonly model = new Loading({
    clock: {
      after: (ms, fn) => {
        const t = setTimeout(fn, ms)
        return () => clearTimeout(t)
      }
    },
    changed: (v) => (this.view = v),
    timings: loadTimings
  })

  get active(): boolean {
    return this.view !== null
  }

  begin(kind: LoadKind, stage: LoadStage): void {
    this.model.begin(kind, stage)
  }

  /** Moves on, or (none running) starts a load at this stage. */
  stage(stage: LoadStage, kind: LoadKind = 'enter'): void {
    if (!this.model.active) this.model.begin(kind, stage)
    else {
      if (stage !== 'fetch' && this.view?.stage === 'fetch') this.noteArt()
      if (stage === 'fetch') this.fetchFrom = performance.now()
      this.model.stage(stage)
    }
  }

  progress(p: number): void {
    this.model.progress(p)
  }

  fail(): void {
    this.model.fail()
  }

  done(): void {
    this.model.done()
  }

  cancel(outcome?: 'retry' | 'title' | 'cancelled' | 'failed'): void {
    this.model.cancel(outcome)
  }

  /** Where the art came from (the requests since the fetch began). */
  private noteArt(): void {
    try {
      const art = (performance.getEntriesByType('resource') as unknown as ResourceLike[]).filter((e) => e.startTime >= this.fetchFrom && e.name.includes('/assets/'))
      this.model.note('art files', artCacheSummary(art))
    } catch {
      /* no resource timing: nothing to say */
    }
  }
}

export const loading = new LoadingState()

// The game's side: the art stages, their progress, and the first frame.
bus.on(EV.loadStage, (p) => {
  if (!loading.active) return
  if (p.note) loadTimings.note(p.note[0], p.note[1])
  if (p.stage) loading.stage(p.stage)
  if (p.progress !== undefined) loading.progress(p.progress)
  if (p.failed) loading.fail()
})
bus.on(EV.worldShown, () => loading.done())

/** The device and screen, for the copied timings. */
function environment(): { device: string; viewport: string; version: string } {
  const standalone = (navigator as { standalone?: boolean }).standalone === true || matchMedia?.('(display-mode: standalone)').matches === true
  return {
    device: deviceLine(navigator.userAgent, standalone),
    viewport: `${innerWidth}×${innerHeight} CSS px @${devicePixelRatio}x`,
    version: `${RUNNING.version} (${RUNNING.build})`
  }
}

/** The last loads as text for a chat (the Menu's "Copy load timings"). */
export function loadTimingsText(): string {
  return formatTimings(loadTimings.records, environment())
}
