/**
 * The context buttons (docs/design/crafts.md 8): a small row of buttons the
 * game puts up for what the hero can do right now beyond the big action
 * button — the saddle and Go home while a mount is out, Keep and Let it go
 * on a landed fish. The HUD (desktop, beside the action bar) and the touch
 * controls (phones, above the action button) draw whatever is here; the
 * lane that owns the moment pushes its entry and takes it away again, so no
 * one edits Hud.svelte or TouchControls.svelte to add a button.
 *
 * No Svelte here: the interface follows `onContextButtons`
 * (src/ui/store.svelte.ts mirrors it into `ui.contextButtons`).
 */

export interface ContextButton {
  /** Stable id, one entry per id ('saddle', 'go-home', 'fish-keep', …): showing it again replaces it. */
  id: string
  /** What the button says ("Ride", "Get down", "Go home", "Keep"). */
  label: string
  /** A code-drawn icon (src/ui/Icon.svelte), the fallback when `art` isn't loaded. */
  icon?: string
  /** A delivered UI icon by frame key (src/ui/ArtIcon.svelte), e.g. 'hud-saddle'. */
  art?: string
  /** The keyboard key shown on desktop ('M', 'H'). The key itself is the owning lane's to handle. */
  key?: string
  /** 'big' for a moment that owns the corner (Keep / Let it go); 'small' is the default. */
  size?: 'small' | 'big'
  /** Lower comes first (left to right). Ties keep the order they were shown in. */
  order?: number
  /** Read out instead of the label when the label alone is unclear ("Send your mount home"). */
  ariaLabel?: string
  /** Called on a click or tap. */
  press: () => void
}

type Listener = (buttons: readonly ContextButton[]) => void

let buttons: ContextButton[] = []
let shown = 0
const seq = new Map<string, number>()
const listeners = new Set<Listener>()

function emit(): void {
  for (const fn of listeners) fn(buttons)
}

/** Put a button up (or replace the one with this id, keeping its place). */
export function showContextButton(button: ContextButton): void {
  if (!seq.has(button.id)) seq.set(button.id, ++shown)
  buttons = [...buttons.filter((b) => b.id !== button.id), button].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || seq.get(a.id)! - seq.get(b.id)!
  )
  emit()
}

/** Take a button down (a no-op when it isn't up). */
export function hideContextButton(id: string): void {
  if (!buttons.some((b) => b.id === id)) return
  buttons = buttons.filter((b) => b.id !== id)
  seq.delete(id)
  emit()
}

/** Take every button down whose id starts with `prefix` (a scene ending: `hideContextButtons('fish-')`), or all of them. */
export function hideContextButtons(prefix = ''): void {
  const keep = buttons.filter((b) => !b.id.startsWith(prefix))
  if (keep.length === buttons.length) return
  for (const b of buttons) if (b.id.startsWith(prefix)) seq.delete(b.id)
  buttons = keep
  emit()
}

/** The buttons up now, in order. */
export function contextButtons(): readonly ContextButton[] {
  return buttons
}

/** Press a button by id, as a click would (the owning lane's keyboard handler may use this). False when it isn't up. */
export function pressContextButton(id: string): boolean {
  const b = buttons.find((x) => x.id === id)
  if (!b) return false
  b.press()
  return true
}

/** Follow the buttons (called at once with the current list). Returns the stop function. */
export function onContextButtons(fn: Listener): () => void {
  listeners.add(fn)
  fn(buttons)
  return () => listeners.delete(fn)
}
