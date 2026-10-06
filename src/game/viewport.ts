/**
 * Screen space the interface covers at each edge while playing, in CSS
 * pixels: the HUD along the top, the touch controls along the bottom. The
 * camera keeps the hero inside what's left (WorldScene), so near a map edge
 * the hero never walks under a card or a thumb. The UI writes it
 * (src/App.svelte measures the HUD and the controls); `rev` bumps on every
 * change so the scene can re-frame cheaply.
 */
export const playInsets = { top: 0, right: 0, bottom: 0, left: 0, rev: 0 }

export function setPlayInsets(next: { top: number; right: number; bottom: number; left: number }): void {
  const r = (n: number) => Math.max(0, Math.round(n))
  const v = { top: r(next.top), right: r(next.right), bottom: r(next.bottom), left: r(next.left) }
  if (v.top === playInsets.top && v.right === playInsets.right && v.bottom === playInsets.bottom && v.left === playInsets.left) return
  Object.assign(playInsets, v)
  playInsets.rev += 1
}
