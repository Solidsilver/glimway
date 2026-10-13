/** Whole seconds remaining for the cooldown badge shown with reduced motion. */
export function cooldownSeconds(readyAt: number, now: number): number {
  return Math.max(0, Math.ceil((readyAt - now) / 1000))
}
