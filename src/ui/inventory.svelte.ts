/**
 * Reactive inventory state for the interface: a live copy of the save's pack
 * (App refreshes it, since the session's state isn't reactive itself) and the
 * entries this device has already seen. The "seen" list is a per-device
 * convenience in localStorage; it only drives the "new" dots, so losing it
 * is harmless.
 */
const SEEN_KEY = 'fingersnap:inventory-seen'

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

class InventoryStore {
  /** GameState.inventory, as last read (App keeps it current). */
  pack = $state<string[]>([])
  seen = $state<string[]>(loadSeen())

  get seenSet(): Set<string> {
    return new Set(this.seen)
  }

  markSeen(keys: readonly string[]): void {
    const add = keys.filter((k) => !this.seen.includes(k))
    if (add.length === 0) return
    this.seen = [...this.seen, ...add]
    saveSeen(this.seen)
  }

  /** Mirror the pack when it changed (cheap: called often). */
  syncPack(pack: readonly string[]): void {
    if (pack.length === this.pack.length && pack.every((v, i) => v === this.pack[i])) return
    this.pack = [...pack]
  }
}

export const inventory = new InventoryStore()
