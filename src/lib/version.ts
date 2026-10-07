/**
 * Which build this tab runs, and noticing when the server has a newer one.
 *
 * Every build writes /version.json ({ "version", "build" }; see
 * scripts/build-version.mjs), served uncached. A tab left open across a
 * release checks it when it becomes visible again and every ten minutes
 * while visible; a different build id means a reload would get the new one.
 * A failed or odd answer is never the player's problem: the check just backs
 * off and tries later.
 */

export interface VersionInfo {
  version: string
  build: string
}

/** This tab's build (defined by Vite; "dev" under the dev server). */
export const RUNNING: VersionInfo = {
  version: typeof __GLIMWAY_VERSION__ === 'string' ? __GLIMWAY_VERSION__ : '0.0.0',
  build: typeof __GLIMWAY_BUILD__ === 'string' ? __GLIMWAY_BUILD__ : 'dev'
}

export const CHANGELOG_URL = 'https://github.com/Solidsilver/glimway/blob/main/CHANGELOG.md'

const BUILD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/

/** A version.json body, or null for anything else (an HTML fallback page, a proxy's error). */
export function parseVersionInfo(raw: unknown): VersionInfo | null {
  if (!raw || typeof raw !== 'object') return null
  const { version, build } = raw as Record<string, unknown>
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) return null
  if (typeof build !== 'string' || !BUILD_ID.test(build)) return null
  return { version, build }
}

/** True when the server's build is not the one running here. */
export function isNewBuild(running: string, served: VersionInfo | null): served is VersionInfo {
  return !!served && served.build !== running
}

export interface UpdateCheckOptions {
  /** This tab's build id. */
  running: string
  /** The parsed body of /version.json; throws on no answer. */
  fetchInfo: () => Promise<unknown>
  /** A newer build is being served (once per build, until dismissed). */
  onNew: (info: VersionInfo) => void
  now?: () => number
  /** Between checks while the tab stays visible. */
  intervalMs?: number
  /** The least time between checks, however often the tab comes back. */
  minGapMs?: number
  /** The longest back-off after failures. */
  maxBackoffMs?: number
}

export interface UpdateCheck {
  /** The tab became visible again: check unless one ran a moment ago. */
  onVisible(): Promise<void>
  /** A timer tick while visible: check when the interval is up. */
  onTick(): Promise<void>
  /** Check now, whatever the timing (playtests). */
  checkNow(): Promise<void>
  /** The player waved the notice away: not shown again for this build. */
  dismiss(build: string): void
}

export const CHECK_INTERVAL_MS = 10 * 60_000
const MIN_GAP_MS = 60_000
const MAX_BACKOFF_MS = 60 * 60_000

export function createUpdateCheck(opts: UpdateCheckOptions): UpdateCheck {
  const now = opts.now ?? Date.now
  const interval = opts.intervalMs ?? CHECK_INTERVAL_MS
  const minGap = opts.minGapMs ?? MIN_GAP_MS
  const maxBackoff = opts.maxBackoffMs ?? MAX_BACKOFF_MS
  /** When the last check started (the page load counts: it fetched the newest build). */
  let lastAt = now()
  /** No check before this (failures back off: twice the interval, then four times, up to the cap). */
  let retryAt = -Infinity
  let failures = 0
  let running: Promise<void> | null = null
  /** The build already announced, and the ones dismissed. */
  let announced = ''
  const dismissed = new Set<string>()

  async function run(): Promise<void> {
    lastAt = now()
    let served: VersionInfo | null = null
    try {
      served = parseVersionInfo(await opts.fetchInfo())
    } catch {
      served = null
    }
    if (!served) {
      failures += 1
      retryAt = now() + Math.min(interval * 2 ** failures, maxBackoff)
      return
    }
    failures = 0
    retryAt = -Infinity
    if (!isNewBuild(opts.running, served) || served.build === announced || dismissed.has(served.build)) return
    announced = served.build
    opts.onNew(served)
  }

  function maybe(gap: number): Promise<void> {
    if (running) return running
    const t = now()
    if (t < retryAt || t - lastAt < gap) return Promise.resolve()
    return checkNow()
  }

  function checkNow(): Promise<void> {
    running ??= run().finally(() => {
      running = null
    })
    return running
  }

  return {
    onVisible: () => maybe(minGap),
    onTick: () => maybe(interval),
    checkNow,
    dismiss(build: string) {
      dismissed.add(build)
    }
  }
}
