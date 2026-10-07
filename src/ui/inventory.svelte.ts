/**
 * Reactive inventory state for the interface: a live copy of the save's pack
 * (App refreshes it, since the session's state isn't reactive itself) and the
 * entries this device has already seen. The "seen" list is a per-device
 * convenience in localStorage; it only drives the "new" dots, so losing it
 * is harmless.
 */
import { readJson, stringList, writeJson } from '../lib/local-json'

const SEEN_KEY = 'fingersnap:inventory-seen'
/** When each key was seen: one stamp per look at the bag (a batch), newest highest. */
const SEEN_AT_KEY = 'fingersnap:inventory-seen-at'

const loadSeen = (): string[] => readJson(SEEN_KEY, stringList, [])

/** Storage blocked: the dots just come back next visit. */
const saveSeen = (list: string[]): void => void writeJson(SEEN_KEY, list)

/** Stamps by key; a key seen before stamps were kept gets its place in the old list. */
function loadSeenAt(list: readonly string[]): Map<string, number> {
  const at = new Map(list.map((k, i) => [k, i - list.length] as [string, number]))
  const obj = readJson(SEEN_AT_KEY, (v) => v, null)
  if (obj && typeof obj === 'object') for (const [k, v] of Object.entries(obj as Record<string, unknown>)) if (typeof v === 'number' && at.has(k)) at.set(k, v)
  return at
}

/** The order is a convenience: nothing lost if storage refuses it. */
const saveSeenAt = (at: ReadonlyMap<string, number>): void => void writeJson(SEEN_AT_KEY, Object.fromEntries(at))

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
