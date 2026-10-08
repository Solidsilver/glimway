/**
 * Opening a conversation from the game: the dialogue panel owns the screen
 * (and the keys) until it closes with EV.dialogueClosed.
 */
import { bus, EV, type DialoguePayload } from './events'
import { uiState } from './input'
import { sfx, type SfxCue } from './sfx'

/**
 * Show a conversation. The world stops taking input at once (the panel
 * would set this too, a moment later), and the `open` cue plays unless the
 * caller already played its own (`sound: null`).
 */
export function openDialogue(payload: DialoguePayload, opts: { sound?: SfxCue | null } = {}): void {
  uiState.dialogueOpen = true
  const sound = opts.sound === undefined ? 'open' : opts.sound
  if (sound) sfx(sound)
  bus.emit(EV.dialogue, payload)
}
