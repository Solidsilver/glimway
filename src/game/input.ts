/**
 * Shared input surface. The Svelte touch controls write into `touchVec` and
 * emit action presses on the bus; the scene reads both every frame.
 * Desktop keys are handled directly by Phaser in the scene.
 *
 * `uiState` lets the scene know when the interface owns the screen so the
 * world can pause movement and combat.
 */
export const touchVec = { x: 0, y: 0 }

/**
 * Where the hero stands on the game canvas, in CSS pixels (written by the
 * scene every live frame). The "hold to walk" touch mode steers toward the
 * finger from here.
 */
export const heroScreen = { x: 0, y: 0 }

export const uiState = {
  dialogueOpen: false,
  panelOpen: false,
  /** Grace period timestamp so closing a dialogue doesn't fire an attack. */
  blockedUntil: 0
}

export function uiBlocked(): boolean {
  return uiState.dialogueOpen || uiState.panelOpen
}
