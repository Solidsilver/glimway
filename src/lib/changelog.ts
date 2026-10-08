/**
 * The "What's new" card's words, read from CHANGELOG.md when the game is
 * built (the `virtual:whats-new` module, scripts/whats-new.mjs), never
 * fetched at runtime. Each release's `### For players` lines are the card;
 * `### Technical` stays in the file. The format is in CHANGELOG.md's header
 * and docs/releasing.md.
 */

export interface Release {
  /** "0.2.0", or "Unreleased". */
  version: string
  /** "2026-10-07", when the heading has one. */
  date: string | null
  /** The `### For players` lines, as plain text. */
  players: string[]
}

/** Seen on this device: the build and version the card last caught up to. */
export interface Seen {
  version: string
  build: string
}

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

/** Markdown inline marks to plain text: links keep their words, code its letters. */
function plain(line: string): string {
  return line
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^\w])[*_]([^*_]+)[*_](?=[^\w]|$)/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Every release in the file, newest first, with its players' lines. */
export function parseChangelog(markdown: string): Release[] {
  const releases: Release[] = []
  let current: Release | null = null
  let section = ''
  let item: string[] | null = null
  const endItem = () => {
    if (current && item) current.players.push(plain(item.join(' ')))
    item = null
  }
  for (const raw of markdown.split(/\r?\n/)) {
    const release = /^## \[([^\]]+)\](?:\s*-\s*(\d{4}-\d{2}-\d{2}))?/.exec(raw)
    if (release) {
      endItem()
      current = { version: release[1], date: release[2] ?? null, players: [] }
      releases.push(current)
      section = ''
      continue
    }
    const heading = /^###\s+(.+?)\s*$/.exec(raw)
    if (heading) {
      endItem()
      section = heading[1].toLowerCase()
      continue
    }
    if (!current || section !== 'for players') continue
    const bullet = /^[-*]\s+(.*)$/.exec(raw)
    if (bullet) {
      endItem()
      item = [bullet[1]]
    } else if (item && /^\s+\S/.test(raw)) {
      item.push(raw.trim())
    } else if (!raw.trim()) {
      endItem()
    }
  }
  endItem()
  return releases
}

/** Negative when `a` comes before `b`; versions that aren't x.y.z sort first. */
export function compareVersions(a: string, b: string): number {
  const pa = SEMVER.exec(a)
  const pb = SEMVER.exec(b)
  if (!pa || !pb) return (pa ? 1 : 0) - (pb ? 1 : 0)
  for (let i = 1; i <= 3; i++) {
    const d = Number(pa[i]) - Number(pb[i])
    if (d) return d
  }
  return 0
}

/** Released versions after `seen`, up to and including `running`, that have players' lines; newest first. */
export function releasesSince(releases: Release[], seen: string, running: string): Release[] {
  return releases
    .filter((r) => SEMVER.test(r.version) && r.players.length > 0 && compareVersions(r.version, seen) > 0 && compareVersions(r.version, running) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version))
}

/** The newest release this build carries that has players' lines (the Menu's "What's new"). */
export function latestRelease(releases: Release[], running: string): Release | null {
  return releasesSince(releases, '0.0.0', running)[0] ?? null
}

/**
 * What the card shows when a tab starts, and what to remember. A device
 * that never saw the card (a new player, or the first build with it)
 * catches up without a card: there is nothing to say "since" yet. A new
 * build shows the releases after the last one seen; a new build of the same
 * version (a fix, an unreleased change) shows nothing and just catches up.
 */
export function whatsNewOnStart(seen: Seen | null, running: Seen, releases: Release[]): { show: Release[]; remember: Seen | null } {
  if (!seen) return { show: [], remember: running }
  if (seen.build === running.build && seen.version === running.version) return { show: [], remember: null }
  return { show: releasesSince(releases, seen.version, running.version), remember: running }
}

/** A stored Seen record, or null for anything else. */
export function parseSeen(value: unknown): Seen | null {
  if (!value || typeof value !== 'object') return null
  const { version, build } = value as Record<string, unknown>
  return typeof version === 'string' && typeof build === 'string' ? { version, build } : null
}
