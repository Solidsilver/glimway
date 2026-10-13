/** Mounted confirms own App's keys even if focus leaves their DOM subtree. */
export const confirms = $state({ open: 0 })

/** Svelte action: ownership lasts exactly as long as the dialog is mounted. */
export function ownConfirm(_node: HTMLElement) {
  confirms.open++
  return {
    destroy() {
      confirms.open--
    }
  }
}
