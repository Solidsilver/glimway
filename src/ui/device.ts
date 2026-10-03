/** Touch-first device (phones/tablets): shows on-screen controls. */
export function isTouchFirst(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0
  } catch {
    return false
  }
}
