import { latestRelease, parseSeen, whatsNewOnStart, type Release, type Seen } from '../lib/changelog.ts'
import { readJson, writeJson } from '../lib/local-json.ts'

/**
 * The "What's new" card's state (src/ui/WhatsNew.svelte): after an update,
 * the "For players" lines of each release since the last one this device
 * saw; from the Menu, the newest release's. The instance the game uses is
 * in src/ui/whats-new.svelte.ts, fed by CHANGELOG.md at build time.
 *
 * The catch-up after an update and the Menu's look are kept apart: looking
 * from the Menu while a catch-up is waiting (behind a conversation, say)
 * never counts as catching up. The catch-up comes back once the Menu's card
 * closes, and only closing the catch-up itself remembers the build.
 */
export class WhatsNewStore {
  /** The catch-up after an update: its releases, newest first, and what closing it remembers. */
  private catchUp = $state<{ releases: Release[]; remember: Seen } | null>(null)
  /** Opened from the Menu: the newest release ([] when there's nothing written up). */
  private looked = $state<Release[] | null>(null)
  private started = false
  private releases: Release[]
  private running: Seen
  private key: string

  constructor(releases: Release[], running: Seen, key = 'glimway:whats-new') {
    this.releases = releases
    this.running = running
    this.key = key
  }

  /** The releases on the card, newest first; [] when there's nothing to tell; null when it's closed. */
  get shown(): Release[] | null {
    return this.looked ?? this.catchUp?.releases ?? null
  }

  /** Play began: show the card if this is a new build with something to tell. Once a page. */
  start(): void {
    if (this.started) return
    this.started = true
    const { show, remember } = whatsNewOnStart(readJson(this.key, parseSeen, null), this.running, this.releases)
    if (show.length && remember) this.catchUp = { releases: show, remember }
    else if (remember) writeJson(this.key, remember)
  }

  /** The Menu's "What's new": the newest release this build carries. */
  openLatest(): void {
    const latest = latestRelease(this.releases, this.running.version)
    this.looked = latest ? [latest] : []
  }

  /** The card's button: the Menu's look closes (a waiting catch-up shows again), or the catch-up is done. */
  close(): void {
    if (this.looked) {
      this.looked = null
      return
    }
    if (this.catchUp) writeJson(this.key, this.catchUp.remember)
    this.catchUp = null
  }
}
