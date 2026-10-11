/**
 * A touch button that acts the moment a finger lands (pointerdown, no wait
 * for the lift) must still work as a button: Enter, Space and assistive
 * tech activate it with a click and no pointer. The gate fires on the
 * pointerdown and lets the click that follows it pass silently; a click with
 * no pointerdown before it fires.
 */
export const CLICK_AFTER_DOWN_MS = 1000

export function pressGate(now: () => number = () => performance.now()): { down(id: string): boolean; click(id: string): boolean } {
  let last: { id: string; at: number } | null = null
  return {
    down(id) {
      last = { id, at: now() }
      return true
    },
    click(id) {
      const echo = !!last && last.id === id && now() - last.at < CLICK_AFTER_DOWN_MS
      last = null
      return !echo
    },
  }
}
