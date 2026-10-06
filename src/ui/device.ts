/**
 * Touch-first device (phones/tablets): on-screen controls and the phone
 * layouts. The primary pointer decides, not whether a touch screen exists:
 * a touch laptop with a trackpad and keyboard keeps the desktop layout.
 * The fallback covers browsers that don't report hover: touch points and no
 * fine pointer anywhere.
 */
export function isTouchFirst(): boolean {
  try {
    if (window.matchMedia('(pointer: coarse) and (hover: none)').matches) return true
    return navigator.maxTouchPoints > 0 && !window.matchMedia('(any-pointer: fine)').matches
  } catch {
    return false
  }
}
