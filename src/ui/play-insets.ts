/**
 * Measure what the interface covers while playing: the HUD along the top,
 * the touch buttons along the bottom. The camera keeps the hero out of it
 * (src/game/viewport.ts), and the cards and toasts sit under the HUD
 * (--hud-bottom). On a phone the prompt docks beside the action button.
 *
 * Components mark what is measured, so renaming a class never moves the
 * camera:
 * - `data-inset="hud"`: the HUD; each of its children counts, except those
 *   marked `data-inset-skip` (status lines, screen-reader text).
 * - `data-inset="pad"`, `"col"`, `"act"`, `"ring"`: the joystick, the
 *   roll/cast column, the action button and the belt's buttons around it.
 * - `data-inset="cluster"`: the action buttons together (HomeBar's own
 *   fallback for docking the Arrange button reads it).
 * - `data-inset="arrange"`: the homestead's Arrange button.
 * - `data-inset-watch`: a container whose size or children move those
 *   (the touch controls, the action cluster, the belt).
 */
import { setPlayInsets } from '../game/viewport'

export interface Docks {
  /** Phones: where the prompt sits, beside the action button. */
  prompt: { right: number; bottom: number } | null
  /** Phones: px from the screen's bottom to just above the action buttons (the Arrange button docks there). */
  controls: number | undefined
}

const part = (name: string) => document.querySelector<HTMLElement>(`[data-inset="${name}"]`)

/** Start measuring; gives the docks on each change. Returns the stop function. */
export function watchPlayInsets(touch: boolean, onDocks: (docks: Docks) => void): () => void {
  let raf = 0
  const measure = () => {
    raf = 0
    const vh = window.innerHeight
    const vw = window.innerWidth
    // Layout boxes, not painted ones: a hidden HUD (a cinematic) or hidden
    // controls (a conversation) keep their place, so the camera never
    // slides when a dialogue opens and closes.
    const hud = part('hud')
    const hudBottom = hud
      ? Math.max(0, ...[...hud.children].filter((c): c is HTMLElement => c instanceof HTMLElement && !c.hasAttribute('data-inset-skip')).map((c) => hud.offsetTop + c.offsetTop + c.offsetHeight))
      : 0
    const root = document.documentElement.style
    root.setProperty('--hud-bottom', `${Math.round(hudBottom)}px`)
    if (!touch) {
      // Desktop: the HUD is a corner card on a wide screen; the camera centres as before.
      setPlayInsets({ top: 0, right: 0, bottom: 0, left: 0 })
      // The action bar and the prompt tag on it.
      root.setProperty('--dock-bottom', '128px')
      return
    }
    // The buttons at the bottom right always; the joystick at the bottom left when it's fixed there.
    const box = (name: string) => {
      const el = part(name)
      // Hidden controls only fade (opacity): their boxes stay where they are laid out.
      return el && el.offsetHeight > 0 ? el.getBoundingClientRect() : null
    }
    // The cluster: the action button and the roll/cast column. The belt's
    // small buttons arc above it as an overlay: the docks keep clear of
    // them, the camera only in landscape (where the hero walks beside them).
    const union = (rs: (DOMRect | null)[]) => {
      const r = rs.filter((x): x is DOMRect => !!x)
      return r.length ? { top: Math.min(...r.map((x) => x.top)), left: Math.min(...r.map((x) => x.left)) } : null
    }
    const cluster = union([box('act'), box('col')])
    const ring = union([...document.querySelectorAll<HTMLElement>('[data-inset="ring"]')].map((el) => (el.offsetHeight > 0 ? el.getBoundingClientRect() : null)))
    const pad = box('pad')
    if (vw > vh) {
      // Landscape: the thumbs sit at the sides, so the hero keeps to the middle band.
      const left = Math.min(cluster?.left ?? vw, ring?.left ?? vw)
      setPlayInsets({ top: hudBottom, right: cluster ? vw - left : 0, bottom: 0, left: pad ? pad.right : 0 })
    } else {
      const tops = [cluster?.top, pad?.top].filter((t): t is number => t !== undefined)
      setPlayInsets({ top: hudBottom, right: 0, bottom: tops.length ? vh - Math.min(...tops) : 0, left: 0 })
    }
    const controls = cluster ? Math.round(vh - Math.min(cluster.top, ring?.top ?? vh) + 10) : undefined
    // The prompt sits just above the cluster and its belt (and the Arrange button, when it's out), right-aligned with the action button.
    const act = box('act')
    const arrange = part('arrange')?.getBoundingClientRect()
    const above = Math.min(cluster?.top ?? vh, ring?.top ?? vh, arrange && arrange.height > 0 ? arrange.top : vh)
    const prompt = act && cluster ? { right: Math.round(vw - act.right), bottom: Math.round(vh - above + 8) } : null
    onDocks({ prompt, controls })
    // Cards and notices that sit low keep above the buttons and the prompt tag on them.
    root.setProperty('--dock-bottom', `${Math.round(vh - above + 8 + (prompt ? 48 : 0))}px`)
  }
  const soon = () => {
    if (!raf) raf = requestAnimationFrame(measure)
  }
  const ro = new ResizeObserver(soon)
  // Only the marked parts matter: watch them, and re-attach when one of
  // them mounts or unmounts.
  const mo = new MutationObserver(soon)
  const top = new MutationObserver(() => watch())
  const watch = () => {
    ro.disconnect()
    mo.disconnect()
    for (const el of document.querySelectorAll('[data-inset], [data-inset="hud"] > *, [data-inset-watch]')) ro.observe(el)
    for (const el of document.querySelectorAll('[data-inset="hud"], [data-inset-watch]')) mo.observe(el, { childList: true, subtree: true })
    soon()
  }
  const main = document.querySelector('main')
  if (main) top.observe(main, { childList: true })
  window.addEventListener('resize', soon)
  watch()
  return () => {
    ro.disconnect()
    mo.disconnect()
    top.disconnect()
    window.removeEventListener('resize', soon)
    if (raf) cancelAnimationFrame(raf)
    setPlayInsets({ top: 0, right: 0, bottom: 0, left: 0 })
  }
}
