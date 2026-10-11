/**
 * What this device has walked and seen in the open map, per wick
 * (docs/design/open-map.md 2.8, 2.10): the chunks you've been in and the
 * landmarks you've had on screen. It is a convenience for the Map tab, not
 * server state: kept in localStorage under the wick epoch's id, the last
 * few wicks only, and empty (never failing) where storage is blocked.
 */

const PREFIX = 'glimway-walked:'
/** Wicks kept on the device (older ones are dropped as new ones start). */
const KEEP = 3

interface Walked {
  walked: string[]
  seen: string[]
}

const memory = new Map<string, Walked>()

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function read(wick: string): Walked {
  const had = memory.get(wick)
  if (had) return had
  let rec: Walked = { walked: [], seen: [] }
  try {
    const raw = storage()?.getItem(PREFIX + wick)
    const parsed = raw ? (JSON.parse(raw) as Partial<Walked>) : null
    if (parsed && Array.isArray(parsed.walked) && Array.isArray(parsed.seen)) {
      rec = { walked: parsed.walked.filter((x): x is string => typeof x === 'string'), seen: parsed.seen.filter((x): x is string => typeof x === 'string') }
    }
  } catch {
    // A broken record starts over.
  }
  memory.set(wick, rec)
  return rec
}

function write(wick: string, rec: Walked): void {
  const s = storage()
  if (!s) return
  try {
    s.setItem(PREFIX + wick, JSON.stringify(rec))
    const keys: string[] = []
    for (let i = 0; i < s.length; i++) {
      const k = s.key(i)
      if (k?.startsWith(PREFIX) && k !== PREFIX + wick) keys.push(k)
    }
    // Keep the newest few wicks: the order they were last written in.
    const order = JSON.parse(s.getItem(`${PREFIX}order`) ?? '[]') as string[]
    const next = [...order.filter((w) => w !== wick), wick].slice(-KEEP)
    s.setItem(`${PREFIX}order`, JSON.stringify(next))
    for (const k of keys) if (k !== `${PREFIX}order` && !next.includes(k.slice(PREFIX.length))) s.removeItem(k)
  } catch {
    // Storage is a convenience.
  }
}

/** You were in chunk `cx,cy` this wick. */
export function markWalked(wick: string, chunk: string): void {
  const rec = read(wick)
  if (rec.walked.includes(chunk)) return
  rec.walked.push(chunk)
  write(wick, rec)
}

/** A landmark (its place id) was on your screen this wick. */
export function markSeen(wick: string, place: string): void {
  const rec = read(wick)
  if (rec.seen.includes(place)) return
  rec.seen.push(place)
  write(wick, rec)
}

/** The chunks walked this wick (`cx,cy`). */
export function walkedChunks(wick: string): readonly string[] {
  return read(wick).walked
}

/** The landmarks seen this wick (place ids). */
export function seenLandmarks(wick: string): readonly string[] {
  return read(wick).seen
}

/** Test seam: forget what's held in memory. */
export function forgetWalked(): void {
  memory.clear()
}
