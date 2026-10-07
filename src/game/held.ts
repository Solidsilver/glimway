/**
 * What the hero holds right now (src/lib/belt.ts): one choice per device,
 * remembered in localStorage (never in the save: the save's flags only grow
 * on the server). The belt is worked out from what's carried; the game reads
 * `heldNow()`, and the UI (the action bar, the phone ring, the bag) follows
 * EV.held { kind, belt }.
 */
import { bus, EV } from './events'
import { BELT_ORDER, beltFor, heldSlot, type BeltKind, type BeltSlot } from '../lib/belt'
import { ITEMS_EV, itemsFor } from './items'
import type { Session } from './session'
import { expose } from './dev-hooks'

/** One choice per player and world on this device (a guest has its own). */
// `fingersnap:` is the game's old name, kept so saved choices load.
let key = 'fingersnap:held'

/** The localStorage key for a session: `fingersnap:held:<player>@<world>`. */
export function deviceKey(base: string, session: Session | null): string {
  const link = session?.link
  return link ? `${base}:${link.habiticaId}@${link.worldId || 'home'}` : `${base}:guest`
}

function load(): BeltKind {
  try {
    const v = localStorage.getItem(key)
    return v && (BELT_ORDER as readonly string[]).includes(v) ? (v as BeltKind) : 'weapon'
  } catch {
    return 'weapon'
  }
}

/** The kind chosen (it may not be carried any more: then the weapon is in hand). */
export const held: { kind: BeltKind; belt: BeltSlot[] } = { kind: load(), belt: beltFor(null) }

export interface HeldPayload {
  /** What's in hand now (the weapon when the chosen kind isn't carried). */
  kind: BeltKind
  belt: BeltSlot[]
}

/** The slot in hand now. */
export function heldNow(): BeltSlot {
  return heldSlot(held.belt, held.kind)
}

function emit(): void {
  bus.emit(EV.held, { kind: heldNow().kind, belt: held.belt } satisfies HeldPayload)
}

/** Take something else in hand (a no-op when it's already there). */
export function setHeld(kind: BeltKind): void {
  if (held.kind === kind && heldNow().kind === kind) return
  held.kind = kind
  try {
    localStorage.setItem(key, kind)
  } catch {
    /* kept for this visit */
  }
  emit()
}

/** Work the belt out again from what's carried (connected; a guest has the weapon only). */
export function refreshBelt(session: Session): void {
  held.belt = beltFor(session.link ? itemsFor(session).view?.instances : null)
  emit()
}

/**
 * Follow what's carried for this session: the belt changes as tools come and
 * go. Returns the stop function (the scene calls it on shutdown).
 */
export function trackBelt(session: Session): () => void {
  // This player's choice in this world.
  const k = deviceKey('fingersnap:held', session)
  if (k !== key) {
    key = k
    held.kind = load()
  }
  const onChanged = () => refreshBelt(session)
  bus.on(ITEMS_EV.changed, onChanged)
  refreshBelt(session)
  return () => bus.off(ITEMS_EV.changed, onChanged)
}

// The UI takes something in hand (the phone ring, the action bar).
bus.on(EV.hold, (p: { kind: BeltKind }) => setHeld(p.kind))

// Read-only, for playtests: what's in hand, and the belt as carried.
expose('__fsHeld', () => ({ kind: heldNow().kind, chosen: held.kind, belt: held.belt.map((s) => s.kind) }))
