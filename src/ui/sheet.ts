import { isTouchFirst } from './device'

/**
 * Svelte action for a panel's overlay (`<div class="overlay sheet" use:sheet={onClose}>`).
 * On touch devices the panel is a sheet (app.css): a tap on the dimmed world
 * closes it, and so does dragging its header down (portrait, a bottom sheet)
 * or right (landscape, a side sheet). Short drags spring back. Desktop keeps
 * the plain modal: no backdrop click, no drag.
 *
 * A tap on the world never throws away something half done: while a field
 * in the panel has focus, has been typed in or changed, or the panel marks
 * a choice in progress (`data-dirty="true"` on any element), only the ✕ or
 * a drag closes it.
 */
export function sheet(node: HTMLElement, onClose: () => void) {
  let close = onClose
  if (!isTouchFirst()) return { update: (f: () => void) => void (close = f) }

  const panel = () => node.querySelector<HTMLElement>(':scope > .panel')
  const sideways = () => window.innerWidth > window.innerHeight
  let drag: { id: number; x: number; y: number; t: number; moved: boolean } | null = null
  /** Until when a click is the end of a drag, not a press. */
  let swallowUntil = 0
  /** The player typed or changed a field in this panel. */
  let edited = false
  /** A field had focus when the backdrop press began (the press itself blurs it). */
  let fieldFocusedAtPress = false
  const FIELD = 'input, textarea, select, [contenteditable="true"]'

  function offset(e: PointerEvent): number {
    if (!drag) return 0
    return Math.max(0, sideways() ? e.clientX - drag.x : e.clientY - drag.y)
  }

  function onDown(e: PointerEvent): void {
    if (e.target === node) {
      const active = document.activeElement as HTMLElement | null
      fieldFocusedAtPress = !!active && node.contains(active) && active.matches(FIELD)
    }
    const head = (e.target as HTMLElement | null)?.closest('.panel-head')
    if (!head || !node.contains(head) || drag) return
    if ((e.target as HTMLElement).closest('input, textarea, select')) return
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, t: performance.now(), moved: false }
  }

  function onMove(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.id) return
    const d = offset(e)
    if (!drag.moved && d < 8) return
    if (!drag.moved) {
      drag.moved = true
      try {
        ;(e.target as HTMLElement).setPointerCapture?.(e.pointerId)
      } catch {
        /* the pointer already ended: the drag finishes on the overlay */
      }
    }
    const p = panel()
    if (p) {
      p.style.transition = 'none'
      p.style.transform = sideways() ? `translateX(${d}px)` : `translateY(${d}px)`
    }
  }

  function onUp(e: PointerEvent): void {
    if (!drag || e.pointerId !== drag.id) return
    const d = offset(e)
    const fast = d / Math.max(1, performance.now() - drag.t) > 0.6
    const moved = drag.moved
    drag = null
    const p = panel()
    if (!moved || !p) return
    swallowUntil = performance.now() + 350
    p.style.transition = 'transform 160ms ease-out'
    if (d > 80 || (fast && d > 24)) {
      p.style.transform = sideways() ? 'translateX(110%)' : 'translateY(110%)'
      window.setTimeout(() => close(), 150)
    } else {
      p.style.transform = ''
    }
  }

  // A drag that started on a tab or the ✕ must not also press it.
  function onClickCapture(e: MouseEvent): void {
    if (performance.now() > swallowUntil) return
    swallowUntil = 0
    e.stopPropagation()
    e.preventDefault()
  }

  function busy(): boolean {
    return edited || fieldFocusedAtPress || !!node.querySelector('[data-dirty="true"]')
  }

  function onBackdrop(e: MouseEvent): void {
    if (e.target !== node) return
    const keep = busy()
    fieldFocusedAtPress = false
    if (!keep) close()
  }

  function onEdit(e: Event): void {
    if ((e.target as HTMLElement | null)?.matches?.(FIELD)) edited = true
  }

  node.addEventListener('pointerdown', onDown)
  node.addEventListener('pointermove', onMove)
  node.addEventListener('pointerup', onUp)
  node.addEventListener('pointercancel', onUp)
  node.addEventListener('click', onClickCapture, true)
  node.addEventListener('click', onBackdrop)
  node.addEventListener('input', onEdit, true)
  node.addEventListener('change', onEdit, true)
  return {
    update: (f: () => void) => void (close = f),
    destroy() {
      node.removeEventListener('pointerdown', onDown)
      node.removeEventListener('pointermove', onMove)
      node.removeEventListener('pointerup', onUp)
      node.removeEventListener('pointercancel', onUp)
      node.removeEventListener('click', onClickCapture, true)
      node.removeEventListener('click', onBackdrop)
      node.removeEventListener('input', onEdit, true)
      node.removeEventListener('change', onEdit, true)
    }
  }
}
