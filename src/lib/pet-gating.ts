/**
 * When a pet is on offer (lane exp/empty-hands, the owner's playtest: "I
 * often start doing the heart interaction with my pet instead of attacking").
 * Two paths, two rules: the prompt and the action key only with empty hands,
 * so what's in hand always wins there; a click or tap on the pet itself pets
 * it whatever is in hand (src/game/entities/interactables.ts
 * `availableDirect` keeps the two apart).
 *
 * Pure (no Phaser, no DOM, no class): node --test can import it — the
 * Petting class's TS parameter properties won't load in node's strip-only
 * mode, so the rules live here.
 */
import type { BeltKind } from './belt.ts'

/** The prompt's (and the action key's) pet: empty hands only. */
export function petOnPrompt(held: BeltKind): boolean {
  return held === 'hands'
}

/** A click or a tap on the pet itself: always, whatever is in hand. */
export function petOnTap(_held: BeltKind): boolean {
  return true
}
