/** App-level panel shortcuts that an open nested confirm must own. */
const PANEL_SHORTCUTS = new Set(['KeyJ', 'KeyC', 'KeyI', 'KeyM'])

export function isConfirmOwnedShortcut(code: string): boolean {
  return PANEL_SHORTCUTS.has(code)
}
