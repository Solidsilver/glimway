import { createUpdateCheck, RUNNING, type UpdateCheck, type VersionInfo } from '../lib/version'

/** Checks while the tab is visible run on this tick (the check spaces them out). */
const TICK_MS = 60_000
const FETCH_TIMEOUT_MS = 8_000

/** The newer build the server has, for src/ui/UpdateNotice.svelte. */
class UpdateStore {
  /** A newer build is being served (null: none yet, or waved away). */
  ready = $state<VersionInfo | null>(null)
  /** Why the notice is up: a newer build, or the world server's contract. */
  cause = $state<'build' | 'contract'>('build')
  /** Reload pressed: saving first. */
  reloading = $state(false)
  /** Why the reload was held back, if it was. */
  held = $state<'offline' | 'unsaved' | null>(null)
  check: UpdateCheck | null = null

  dismiss(): void {
    if (this.ready) this.check?.dismiss(this.ready.build)
    this.ready = null
    this.held = null
  }

  /**
   * The world server answered `reload-needed`: this client is not the
   * version the server speaks. The same quiet notice as a newer build —
   * reload when it suits you (design section 8). Nothing can be written
   * until the reload, so it skips the save-first settle.
   */
  reloadNeeded(): void {
    this.cause = 'contract'
    this.ready = { version: RUNNING.version, build: 'world' }
  }
}

export const update = new UpdateStore()

/** GET /version.json; throws on no answer, a timeout or a non-2xx. */
async function fetchVersion(): Promise<unknown> {
  const abort = new AbortController()
  const timer = window.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS)
  try {
    // application/json: a missing file is a 404, never the SPA's index.html.
    const res = await fetch('/version.json', { cache: 'no-store', signal: abort.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`version.json: ${res.status}`)
    return await res.json()
  } finally {
    window.clearTimeout(timer)
  }
}

/**
 * Watch for a newer build: when the tab comes back into view, and every ten
 * minutes while it stays in view. Never under the dev server, where playtests
 * check on demand instead (`__fsDevVersionCheck`). Returns the stop function.
 */
export function watchForUpdates(): () => void {
  const check = createUpdateCheck({
    running: RUNNING.build,
    fetchInfo: fetchVersion,
    onNew: (info) => {
      update.cause = 'build'
      update.ready = info
    }
  })
  update.check = check
  if (import.meta.env.DEV) {
    ;(window as unknown as { __fsDevVersionCheck?: () => Promise<void> }).__fsDevVersionCheck = () => check.checkNow()
    return () => {}
  }
  const visible = () => document.visibilityState === 'visible'
  const onVisibility = () => {
    if (visible()) void check.onVisible()
  }
  document.addEventListener('visibilitychange', onVisibility)
  const tick = window.setInterval(() => {
    if (visible()) void check.onTick()
  }, TICK_MS)
  return () => {
    document.removeEventListener('visibilitychange', onVisibility)
    window.clearInterval(tick)
  }
}
