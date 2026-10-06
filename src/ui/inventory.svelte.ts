/**
 * Reactive inventory state for the interface: a live copy of the save's pack
 * (App refreshes it, since the session's state isn't reactive itself) and the
 * entries this device has already seen. The "seen" list is a per-device
 * convenience in localStorage; it only drives the "new" dots, so losing it
 * is harmless.
 */
const SEEN_KEY = 'fingersnap:inventory-seen'
/** When each key was seen: one stamp per look at the bag (a batch), newest highest. */
const SEEN_AT_KEY = 'fingersnap:inventory-seen-at'

function loadSeen(): string[] {
  try {
    const raw = localStorage.getItem(SEEN_KEY)
    const list = raw ? (JSON.parse(raw) as unknown) : []
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

function saveSeen(list: string[]): void {
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(list))
  } catch {
    /* storage blocked: the dots just come back next visit */
  }
}

/** Stamps by key; a key seen before stamps were kept gets its place in the old list. */
function loadSeenAt(list: readonly string[]): Map<string, number> {
  const at = new Map(list.map((k, i) => [k, i - list.length] as [string, number]))
  try {
    const raw = localStorage.getItem(SEEN_AT_KEY)
    const obj = raw ? (JSON.parse(raw) as unknown) : null
    if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (typeof v === 'number' && at.has(k)) at.set(k, v)
  } catch {
    /* the old order stands */
  }
  return at
}

function saveSeenAt(at: ReadonlyMap<string, number>): void {
  try {
    localStorage.setItem(SEEN_AT_KEY, JSON.stringify(Object.fromEntries(at)))
  } catch {
    /* the order is a convenience */
  }
}

class InventoryStore {
  /** GameState.inventory, as last read (App keeps it current). */
  pack = $state<string[]>([])
  seen = $state<string[]>(loadSeen())
  /** When each key was seen (a shared stamp per look): newest first in the bag. */
  seenAt = $state<Map<string, number>>(loadSeenAt(this.seen))

  get seenSet(): Set<string> {
    return new Set(this.seen)
  }

  /** Everything in `keys` was seen together now: one stamp for the batch. */
  markSeen(keys: readonly string[]): void {
    const add = keys.filter((k) => !this.seen.includes(k))
    if (add.length === 0) return
    const stamp = Math.max(0, ...this.seenAt.values()) + 1
    const at = new Map(this.seenAt)
    for (const k of add) at.set(k, stamp)
    this.seen = [...this.seen, ...add]
    this.seenAt = at
    saveSeen(this.seen)
    saveSeenAt(at)
  }

  /** Mirror the pack when it changed (cheap: called often). */
  syncPack(pack: readonly string[]): void {
    if (pack.length === this.pack.length && pack.every((v, i) => v === this.pack[i])) return
    this.pack = [...pack]
  }
}

export const inventory = new InventoryStore()
