import releases from 'virtual:whats-new'
import { latestRelease, parseSeen, whatsNewOnStart, type Release, type Seen } from '../lib/changelog'
import { readJson, writeJson } from '../lib/local-json'
import { RUNNING } from '../lib/version'

/** The build the card last caught up to, on this device. */
const SEEN_KEY = 'glimway:whats-new'

/**
 * The "What's new" card (src/ui/WhatsNew.svelte): after an update, the
 * "For players" lines of each release since the last one this device saw;
 * from the Menu, the newest release's. The lines come from CHANGELOG.md at
 * build time (scripts/whats-new.mjs).
 */
class WhatsNewStore {
  /** The releases on the card, newest first; [] when there's nothing to tell; null when it's closed. */
  shown = $state<Release[] | null>(null)
  /** Remembered once the card is closed (a reload before then shows it again). */
  private catchUp: Seen | null = null
  private started = false

  /** Play began: show the card if this is a new build with something to tell. Once a page. */
  start(): void {
    if (this.started) return
    this.started = true
    const { show, remember } = whatsNewOnStart(readJson(SEEN_KEY, parseSeen, null), RUNNING, releases)
    if (show.length) {
      this.catchUp = remember
      this.shown = show
    } else if (remember) {
      writeJson(SEEN_KEY, remember)
    }
  }

  /** The Menu's "What's new": the newest release this build carries. */
  openLatest(): void {
    const latest = latestRelease(releases, RUNNING.version)
    this.shown = latest ? [latest] : []
  }

  close(): void {
    this.shown = null
    if (this.catchUp) writeJson(SEEN_KEY, this.catchUp)
    this.catchUp = null
  }
}

export const whatsNew = new WhatsNewStore()
