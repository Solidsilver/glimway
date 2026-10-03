/**
 * Svelte action for modal panels: moves focus inside on open, keeps Tab
 * cycling within the panel, and returns focus to whatever had it before
 * (usually the HUD button) when the panel closes.
 */
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select, summary, [tabindex]:not([tabindex="-1"])'

export function focusTrap(node: HTMLElement, opts: { initial?: string } = {}) {
  const previous = document.activeElement as HTMLElement | null
  if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '-1')

  const focusables = () => [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null)

  queueMicrotask(() => {
    const preferred = opts.initial ? node.querySelector<HTMLElement>(opts.initial) : null
    const target = preferred ?? focusables().find((el) => !el.classList.contains('modal-close')) ?? node
    target.focus({ preventScroll: true })
  })

  function onKey(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return
    const items = focusables()
    if (items.length === 0) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
  node.addEventListener('keydown', onKey)

  return {
    destroy() {
      node.removeEventListener('keydown', onKey)
      // Hand focus back only inside another overlay (menu -> confirm). A HUD
      // button keeping focus would turn the next Space press (attack/talk)
      // into a click that reopens the panel, so in-world we release focus.
      if (previous && document.contains(previous) && previous.closest('.overlay')) {
        previous.focus({ preventScroll: true })
      } else {
        ;(document.activeElement as HTMLElement | null)?.blur?.()
      }
    }
  }
}
